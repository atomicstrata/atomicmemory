//! Actionable recovery playbooks for ingest/smoke/Core gateway failures.

use anyhow::Error;

use super::openai::CONNECTED_LOCAL_DOCS;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorClass {
    BadGateway,
    Auth,
    Timeout,
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
            Self::OpenAi => "openai",
            Self::RawContent => "raw_content",
            Self::Other => "other",
        }
    }
}

/// Attach recovery steps to memory pipeline / ingest failures.
pub fn with_operation_recovery(err: Error, operation: &str) -> Error {
    let base = err.to_string();
    let class = classify_error(&base);
    let hint = match class {
        ErrorClass::BadGateway => {
            "Likely Core is starting or unreachable — run `am instance start`, wait for health, then `am connect doctor`."
        }
        ErrorClass::Auth => {
            "Authentication failed — check OPENAI_API_KEY and local client key via `am instance status --show-secrets`."
        }
        ErrorClass::Timeout => {
            "Request timed out — Core may still be starting; retry in ~30s or run `am connect doctor`."
        }
        ErrorClass::OpenAi => {
            "OpenAI upstream error — verify OPENAI_API_KEY and re-run `am instance start --openai-api-key sk-...`."
        }
        ErrorClass::RawContent => {
            "This deployment refuses raw or unstamped content (Core `RAW_CONTENT_POLICY=reject`, the default).\n\
             Re-run with `--content-class summary` or `--content-class redacted` to declare what the stored text is.\n\
             `--mode verbatim` with no content class, or `--content-class raw`, is refused unless the operator sets `RAW_CONTENT_POLICY=allow`."
        }
        ErrorClass::Other => "",
    };

    let mut message = format!("{operation} failed: {base}");
    if !hint.is_empty() {
        message.push_str("\n\n");
        message.push_str(hint);
    }
    // A policy refusal is not a connectivity failure: Core answered correctly,
    // so the generic "is Core up?" playbook would send the user down the wrong
    // path.
    if class != ErrorClass::RawContent {
        message.push_str(
            "\n\nRecovery:\n  1. `am connect doctor`\n  2. `am doctor --smoke`\n  3. Docs: ",
        );
        message.push_str(CONNECTED_LOCAL_DOCS);
    }

    anyhow::anyhow!(message)
}

pub fn classify_error(message: &str) -> ErrorClass {
    let lower = message.to_lowercase();
    // Checked first: this is a deliberate policy refusal, and its payload can
    // otherwise be swallowed by the broader substring checks below.
    if lower.contains("raw_content_rejected")
        || (lower.contains("content_class") && lower.contains("422"))
    {
        return ErrorClass::RawContent;
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
    if lower.contains("openai") || lower.contains("upstream_provider") || lower.contains("sk-") {
        return ErrorClass::OpenAi;
    }
    ErrorClass::Other
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_class_strings_are_stable() {
        assert_eq!(ErrorClass::BadGateway.as_str(), "bad_gateway");
        assert_eq!(ErrorClass::Auth.as_str(), "auth");
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
    fn recovery_includes_doctor_commands() {
        let err = with_operation_recovery(anyhow::anyhow!("core http 502"), "Memory smoke ingest");
        let msg = err.to_string();
        assert!(msg.contains("am connect doctor"));
        assert!(msg.contains("am doctor --smoke"));
        assert!(msg.contains(CONNECTED_LOCAL_DOCS));
        assert!(msg.contains("502"));
    }
}
