//! Local Core client credentials — retrieval, redaction, and operator-facing cards.

use serde::Serialize;

use crate::config::resolve_core_api_key;
use crate::instance::CORE_STATE_KEY_PATH;

/// How the local client `CORE_API_KEY` was resolved.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum KeyProvenance {
    /// Read from Core's persisted state file inside the managed container.
    CoreState,
    /// Explicit operator shell override (`CORE_API_KEY` / `ATOMICMEMORY_CORE_API_KEY`).
    ShellOverride,
    /// No key available (container stopped, legacy image, or unreachable).
    Unavailable,
}

/// Structured local-client credential block for JSON output.
#[derive(Debug, Clone, Serialize)]
pub struct LocalClientsInfo {
    pub url: String,
    pub core_api_key: Option<String>,
    pub auth_header_hint: Option<String>,
    pub provenance: KeyProvenance,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retrieval_hint: Option<String>,
}

impl LocalClientsInfo {
    pub fn unavailable(url: impl Into<String>, hint: impl Into<String>) -> Self {
        Self {
            url: url.into(),
            core_api_key: None,
            auth_header_hint: None,
            provenance: KeyProvenance::Unavailable,
            retrieval_hint: Some(hint.into()),
        }
    }
}

/// Resolve local-client credentials for display.
///
/// Precedence: persisted Core state file (when provided), then shell override.
pub fn resolve_local_clients(
    local_url: &str,
    state_key: Option<&str>,
    show_secrets: bool,
) -> LocalClientsInfo {
    resolve_local_clients_with_shell(
        local_url,
        state_key,
        resolve_core_api_key().as_deref(),
        show_secrets,
    )
}

/// Resolve with an explicit shell override (testable without env mutation).
pub fn resolve_local_clients_with_shell(
    local_url: &str,
    state_key: Option<&str>,
    shell_key: Option<&str>,
    show_secrets: bool,
) -> LocalClientsInfo {
    if let Some(key) = state_key.filter(|k| !k.is_empty()) {
        return build_info(local_url, key, KeyProvenance::CoreState, show_secrets, None);
    }

    if let Some(key) = shell_key.filter(|k| !k.is_empty()) {
        return build_info(
            local_url,
            key,
            KeyProvenance::ShellOverride,
            show_secrets,
            None,
        );
    }

    LocalClientsInfo::unavailable(
        local_url,
        format!(
            "start Core (`am instance start`) or read the key: docker exec atomic-memory cat {CORE_STATE_KEY_PATH}"
        ),
    )
}

fn build_info(
    local_url: &str,
    key: &str,
    provenance: KeyProvenance,
    show_secrets: bool,
    retrieval_hint: Option<String>,
) -> LocalClientsInfo {
    let displayed = if show_secrets {
        key.to_string()
    } else {
        redact_secret(key)
    };
    LocalClientsInfo {
        url: local_url.to_string(),
        core_api_key: Some(displayed.clone()),
        auth_header_hint: Some(format!("Authorization: Bearer {displayed}")),
        provenance,
        retrieval_hint,
    }
}

/// Redact a secret for operator display (first 4 + last 4 when long enough).
pub fn redact_secret(secret: &str) -> String {
    if secret.len() <= 8 {
        return "****".to_string();
    }
    format!("{}…{}", &secret[..4], &secret[secret.len() - 4..])
}

/// Human-readable Local Core credentials card (stderr).
pub fn render_local_clients_card(info: &LocalClientsInfo, _show_secrets: bool) -> String {
    let mut lines = vec![
        String::new(),
        "Local Core (for apps / SDK / agents on this machine)".to_string(),
        format!("  URL:  {}", info.url),
    ];

    match (&info.core_api_key, info.provenance) {
        (Some(key), _) => {
            lines.push(format!("  Auth: Authorization: Bearer {key}"));
            lines.push("  Env:".to_string());
            lines.push(format!("    ATOMICMEMORY_CORE_URL={}", info.url));
            lines.push(format!("    CORE_API_KEY={key}"));
        }
        (None, KeyProvenance::Unavailable) => {
            if let Some(hint) = &info.retrieval_hint {
                lines.push(format!("  Key:  unavailable — {hint}"));
            } else {
                lines.push("  Key:  unavailable".to_string());
            }
        }
        _ => {}
    }

    lines.push(
        "Cloud sync uses a different key (amc_) — see `am connect env --for sync`.".to_string(),
    );
    lines.join("\n")
}

/// Environment block for local apps → Core.
pub fn render_client_env_block(local_url: &str, key: &str, show_secrets: bool) -> String {
    let secret = if show_secrets {
        key.to_string()
    } else {
        redact_secret(key)
    };
    format!("# Local clients → Core\nATOMICMEMORY_CORE_URL={local_url}\nCORE_API_KEY={secret}")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `am instance start` used to pass a `reveal_on_start` override that OR'd
    /// with `--show-secrets`, so an ordinary start printed the persisted
    /// CORE_API_KEY. It is a usable bearer token, and it landed in terminals and
    /// captured logs while the flag advertised redaction without the flag.
    #[test]
    fn the_raw_key_is_withheld_unless_secrets_are_requested() {
        let key = "c0ffee1234567890abcdefc0ffee1234567890abcdefc0ffee1234567890abcd";
        let info =
            resolve_local_clients_with_shell("http://127.0.0.1:17350", Some(key), None, false);

        let shown = info.core_api_key.expect("a key is reported");
        assert_ne!(shown, key, "the raw key must not be displayed by default");
        assert!(
            !shown.contains("567890abcdef"),
            "the body of the key must not leak"
        );

        let hint = info.auth_header_hint.expect("an auth hint is reported");
        assert!(
            !hint.contains(key),
            "the copy-paste auth header must not embed the raw key either",
        );
    }

    #[test]
    fn the_raw_key_is_shown_only_when_explicitly_requested() {
        let key = "c0ffee1234567890abcdefc0ffee1234567890abcdefc0ffee1234567890abcd";
        let info =
            resolve_local_clients_with_shell("http://127.0.0.1:17350", Some(key), None, true);
        assert_eq!(
            info.core_api_key.as_deref(),
            Some(key),
            "--show-secrets must still reveal it, or the flag is useless",
        );
    }

    #[test]
    fn resolve_prefers_state_file_over_shell() {
        let info = resolve_local_clients_with_shell(
            "http://127.0.0.1:17350",
            Some("state-file-key"),
            Some("shell-key-value"),
            false,
        );
        assert_eq!(info.provenance, KeyProvenance::CoreState);
        assert!(info.core_api_key.as_ref().is_some_and(|k| k.contains('…')));
        assert!(
            !info
                .core_api_key
                .as_ref()
                .unwrap()
                .contains("state-file-key")
        );
    }

    #[test]
    fn resolve_shell_fallback_when_no_state() {
        let info = resolve_local_clients_with_shell(
            "http://127.0.0.1:17350",
            None,
            Some("my-shell-override-key"),
            true,
        );
        assert_eq!(info.provenance, KeyProvenance::ShellOverride);
        assert_eq!(info.core_api_key.as_deref(), Some("my-shell-override-key"));
    }

    #[test]
    fn unavailable_when_no_sources() {
        let info = resolve_local_clients_with_shell("http://127.0.0.1:17350", None, None, false);
        assert_eq!(info.provenance, KeyProvenance::Unavailable);
        assert!(info.retrieval_hint.is_some());
    }

    #[test]
    fn redact_short_secret_fully_masked() {
        assert_eq!(redact_secret("short"), "****");
    }

    #[test]
    fn render_client_env_redacts_by_default() {
        let block = render_client_env_block("http://127.0.0.1:17350", "abcd1234wxyz9876", false);
        assert!(block.contains("ATOMICMEMORY_CORE_URL=http://127.0.0.1:17350"));
        assert!(!block.contains("abcd1234wxyz9876"));
        assert!(block.contains("abcd…9876"));
    }
}
