//! Actionable recovery playbooks for ingest/smoke/Core gateway failures.

use anyhow::Error;

use super::openai::CONNECTED_LOCAL_DOCS;
use crate::config::ProfileKind;

const HOSTED_CLOUD_DOCS: &str = "https://docs.atomicstrata.ai/cloud/troubleshooting";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorClass {
    BadGateway,
    Auth,
    Timeout,
    UpstreamProvider,
    OpenAi,
    /// Core refused raw/unstamped content (`RAW_CONTENT_POLICY=reject`).
    RawContent,
    Other,
}

impl ErrorClass {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::BadGateway => "bad_gateway",
            Self::Auth => "auth",
            Self::Timeout => "timeout",
            Self::UpstreamProvider => "upstream_provider",
            Self::OpenAi => "openai",
            Self::RawContent => "raw_content",
            Self::Other => "other",
        }
    }
}

/// Attach recovery steps to memory pipeline / ingest failures.
pub fn with_operation_recovery(err: Error, operation: &str, kind: ProfileKind) -> Error {
    let base = err.to_string();
    let class = classify_error(&base);
    let hint = recovery_hint(class, kind);

    let mut message = format!("{operation} failed: {base}");
    if !hint.is_empty() {
        message.push_str("\n\n");
        message.push_str(hint);
    }
    if let Some(steps) = recovery_steps(class, kind) {
        message.push_str("\n\n");
        message.push_str(&steps);
    }

    anyhow::anyhow!(message)
}

pub fn classify_error(message: &str) -> ErrorClass {
    let lower = message.to_lowercase();
    if lower.contains("raw_content_rejected")
        || (lower.contains("content_class") && lower.contains("422"))
    {
        return ErrorClass::RawContent;
    }
    // `upstream_provider` covers the codes Core actually emits
    // (upstream_provider_auth_failed / _rate_limited / _quota_exceeded /
    // _error). Matching only `upstream_error` meant every real provider
    // failure fell through to the 502 arm and told the user to retry, which
    // never clears a bad provider credential or an exhausted quota.
    if lower.contains("upstream_provider")
        || lower.contains("upstream_error")
        || lower.contains("ai provider")
        || lower.contains("configured ai provider")
    {
        return ErrorClass::UpstreamProvider;
    }
    if lower.contains("502")
        || lower.contains("bad gateway")
        || lower.contains("503")
        || lower.contains("504")
    {
        return ErrorClass::BadGateway;
    }
    if lower.contains("401")
        || lower.contains("403")
        || lower.contains("authentication")
        || lower.contains("unauthorized")
        || lower.contains("auth")
    {
        return ErrorClass::Auth;
    }
    if lower.contains("timeout") || lower.contains("timed out") {
        return ErrorClass::Timeout;
    }
    if lower.contains("openai") || lower.contains("sk-") {
        return ErrorClass::OpenAi;
    }
    ErrorClass::Other
}

fn recovery_hint(class: ErrorClass, kind: ProfileKind) -> &'static str {
    match (class, kind) {
        (ErrorClass::BadGateway, ProfileKind::Cloud) => {
            "Hosted Cloud returned a gateway error. Retry shortly; if it persists, check service \
             status."
        }
        (ErrorClass::BadGateway, ProfileKind::Local) => {
            "Likely Core is starting or unreachable — run `am instance start`, wait for health, \
             then `am connect doctor`."
        }
        (ErrorClass::Auth, ProfileKind::Cloud) => {
            "Authentication failed — verify the active profile's API key (`am key list`). If you \
             exported ATOMICMEMORY_API_KEY, ensure it matches the intended key; init-managed \
             Hosted Cloud profiles ignore stale exports unless ATOMICMEMORY_API_KEY_FORCE=1."
        }
        (ErrorClass::Auth, ProfileKind::Local) => {
            "Authentication failed — check OPENAI_API_KEY and local client key via `am instance \
             status --show-secrets`."
        }
        (ErrorClass::Timeout, ProfileKind::Cloud) => {
            "Request timed out — retry shortly or check Hosted Cloud status."
        }
        (ErrorClass::Timeout, ProfileKind::Local) => {
            "Request timed out — Core may still be starting; retry in ~30s or run `am connect \
             doctor`."
        }
        (ErrorClass::UpstreamProvider, ProfileKind::Cloud) => {
            "Hosted Cloud rejected the AI extraction request. Check the project's AI provider \
             configuration in the dashboard, or distill/redact the input yourself and re-ingest \
             with a content class that matches the transformed text."
        }
        (ErrorClass::UpstreamProvider, ProfileKind::Local) => {
            "Core's upstream AI provider rejected the request. Check OPENAI_API_KEY and Core logs, \
             or distill/redact the input yourself and re-ingest with a content class that matches \
             the transformed text."
        }
        (ErrorClass::OpenAi, ProfileKind::Cloud) => {
            "Hosted Cloud text extraction uses the project's configured AI provider, not your \
             local OPENAI_API_KEY. Check provider settings in the dashboard."
        }
        (ErrorClass::OpenAi, ProfileKind::Local) => {
            "OpenAI upstream error — verify OPENAI_API_KEY and re-run `am instance start \
             --openai-api-key sk-...`."
        }
        (ErrorClass::RawContent, _) => {
            "This deployment refuses raw or unstamped content (Core `RAW_CONTENT_POLICY=reject`, \
             the default).\nRe-run with `--content-class summary` or `--content-class redacted` to \
             declare what the stored text is.\n`--mode verbatim` with no content class, or \
             `--content-class raw`, is refused unless the operator sets `RAW_CONTENT_POLICY=allow`."
        }
        (ErrorClass::Other, _) => "",
    }
}

fn recovery_steps(class: ErrorClass, kind: ProfileKind) -> Option<String> {
    if class == ErrorClass::RawContent || class == ErrorClass::Other {
        return None;
    }
    Some(match (class, kind) {
        (ErrorClass::Auth, ProfileKind::Cloud) => {
            format!(
                "Recovery:\n  1. `am key list`\n  2. `am init --project <id>`\n  3. Docs: {HOSTED_CLOUD_DOCS}"
            )
        }
        (ErrorClass::UpstreamProvider | ErrorClass::OpenAi, ProfileKind::Cloud) => {
            format!(
                "Recovery:\n  1. Check the project's AI provider in the dashboard\n  2. Docs: {HOSTED_CLOUD_DOCS}"
            )
        }
        (ErrorClass::BadGateway | ErrorClass::Timeout, ProfileKind::Cloud) => {
            format!(
                "Recovery:\n  1. Retry shortly\n  2. Check Hosted Cloud status\n  3. Docs: {HOSTED_CLOUD_DOCS}"
            )
        }
        (_, ProfileKind::Local) => format!(
            "Recovery:\n  1. `am connect doctor`\n  2. `am doctor --smoke`\n  3. Docs: {CONNECTED_LOCAL_DOCS}"
        ),
        (_, ProfileKind::Cloud) => None?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_class_strings_are_stable() {
        assert_eq!(ErrorClass::BadGateway.as_str(), "bad_gateway");
        assert_eq!(ErrorClass::Auth.as_str(), "auth");
        assert_eq!(ErrorClass::UpstreamProvider.as_str(), "upstream_provider");
    }

    #[test]
    fn classifies_bad_gateway() {
        assert_eq!(classify_error("core http 502"), ErrorClass::BadGateway);
    }

    #[test]
    fn classifies_auth_errors() {
        assert_eq!(
            classify_error("authentication failed (401/403)"),
            ErrorClass::Auth
        );
    }

    #[test]
    fn core_upstream_provider_codes_are_classified_as_provider_failures() {
        // The literal error_code values in packages/core/src/schemas/errors.ts.
        // The previous matcher looked for "upstream_error", which none of them
        // contain, so all four were misrouted — and with the 502 that Core
        // sends alongside them, every one became a "retry shortly" gateway
        // hint.
        for code in [
            "upstream_provider_auth_failed",
            "upstream_provider_rate_limited",
            "upstream_provider_quota_exceeded",
            "upstream_provider_error",
        ] {
            assert_eq!(
                classify_error(code),
                ErrorClass::UpstreamProvider,
                "bare {code}"
            );
            assert_eq!(
                classify_error(&format!("HTTP 502: {code}")),
                ErrorClass::UpstreamProvider,
                "502 {code}"
            );
        }
        // A genuine gateway failure with no provider code still reads as one.
        assert_eq!(
            classify_error("HTTP 502 Bad Gateway"),
            ErrorClass::BadGateway
        );
    }

    #[test]
    fn upstream_error_is_classified_before_bad_gateway() {
        assert_eq!(
            classify_error("upstream_error: configured AI provider rejected request"),
            ErrorClass::UpstreamProvider
        );
    }

    #[test]
    fn local_recovery_includes_doctor_commands() {
        let err = with_operation_recovery(
            anyhow::anyhow!("core http 502"),
            "Memory smoke ingest",
            ProfileKind::Local,
        );
        let msg = err.to_string();
        assert!(msg.contains("am connect doctor"));
        assert!(msg.contains("am doctor --smoke"));
        assert!(msg.contains(CONNECTED_LOCAL_DOCS));
        assert!(msg.contains("502"));
    }

    #[test]
    fn cloud_auth_recovery_omits_openai_and_instance_start() {
        let err = with_operation_recovery(
            anyhow::anyhow!("http 401 unauthorized"),
            "Memory ingest",
            ProfileKind::Cloud,
        );
        let msg = err.to_string();
        assert!(msg.contains("ATOMICMEMORY_API_KEY_FORCE"));
        assert!(!msg.contains("OPENAI_API_KEY"));
        assert!(!msg.contains("am instance start"));
        assert!(msg.contains("am key list"));
    }

    #[test]
    fn cloud_upstream_recovery_does_not_suggest_false_summary_stamp() {
        let err = with_operation_recovery(
            anyhow::anyhow!("upstream_error: provider rejected"),
            "Memory ingest",
            ProfileKind::Cloud,
        );
        let msg = err.to_string();
        assert!(!msg.contains("--mode verbatim --content-class summary"));
        assert!(!msg.contains("am init --project"));
        assert!(msg.contains("dashboard"));
    }

    #[test]
    fn cloud_upstream_recovery_steps_point_at_provider_not_key_init() {
        let err = with_operation_recovery(
            anyhow::anyhow!("upstream_error: provider rejected"),
            "Memory ingest",
            ProfileKind::Cloud,
        );
        let msg = err.to_string();
        assert!(msg.contains("AI provider"));
        assert!(!msg.contains("am key list"));
        assert!(!msg.contains("am init --project"));
    }

    #[test]
    fn local_bad_gateway_recovery_mentions_instance_start() {
        let err = with_operation_recovery(
            anyhow::anyhow!("core http 502"),
            "Memory smoke",
            ProfileKind::Local,
        );
        assert!(err.to_string().contains("am instance start"));
    }

    #[test]
    fn smoke_recovery_uses_passed_local_kind_without_cloud_init_steps() {
        let err = with_operation_recovery(
            anyhow::anyhow!("http 401 unauthorized"),
            "Memory smoke",
            ProfileKind::Local,
        );
        let msg = err.to_string();
        assert!(!msg.contains("am init --project"));
        assert!(msg.contains("am instance"));
    }
}
