//! OpenAI API key probe — fail closed before Core starts in a broken state.

use std::time::Duration;

use anyhow::{Context, Result, bail};

pub const OPENAI_MODELS_URL: &str = "https://api.openai.com/v1/models";
pub const CONNECTED_LOCAL_DOCS: &str = "https://docs.atomicstrata.ai/cloud";

/// Lightweight OpenAI auth probe (`GET /v1/models`).
pub async fn validate_openai_api_key(key: &str) -> Result<()> {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        bail!(openai_key_error("OPENAI_API_KEY is empty"));
    }
    if !trimmed.starts_with("sk-") {
        bail!(openai_key_error(
            "OPENAI_API_KEY must start with sk- (paste a valid OpenAI secret key)",
        ));
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .context("build OpenAI validation client")?;

    let resp = client
        .get(OPENAI_MODELS_URL)
        .bearer_auth(trimmed)
        .send()
        .await
        .context("OpenAI key validation request failed (network)")?;

    let status = resp.status();
    if status.is_success() {
        return Ok(());
    }

    let body = resp.text().await.unwrap_or_default();
    let detail = body.chars().take(120).collect::<String>();

    match status.as_u16() {
        401 => bail!(openai_key_error(
            "OpenAI rejected the key (401 unauthorized) — export a fresh key or pass --openai-api-key",
        )),
        403 => bail!(openai_key_error(
            "OpenAI rejected the key (403 forbidden) — check project access and billing",
        )),
        429 => bail!(openai_key_error(
            "OpenAI rate-limited the validation probe — retry in a moment",
        )),
        code => bail!(openai_key_error(&format!(
            "OpenAI validation failed (HTTP {code}){detail_suffix}",
            detail_suffix = if detail.is_empty() {
                String::new()
            } else {
                format!(": {detail}")
            }
        ))),
    }
}

fn openai_key_error(reason: &str) -> String {
    format!(
        "{reason}\n\nFix: export OPENAI_API_KEY=<sk-...> or run `am instance start --openai-api-key sk-...`\nThen verify: `am connect doctor` and `am doctor --smoke`\nDocs: {CONNECTED_LOCAL_DOCS}"
    )
}

/// Auth / format failures where a fresh key may succeed (TTY re-prompt candidates).
/// Network errors and rate limits are not re-promptable.
pub fn is_repromptable_openai_key_error(err: &anyhow::Error) -> bool {
    let s = err.to_string();
    s.contains("401 unauthorized")
        || s.contains("403 forbidden")
        || s.contains("OPENAI_API_KEY is empty")
        || s.contains("must start with sk-")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn openai_key_error_includes_recovery_commands() {
        let msg = openai_key_error("bad key");
        assert!(msg.contains("am connect doctor"));
        assert!(msg.contains("am doctor --smoke"));
        assert!(msg.contains(CONNECTED_LOCAL_DOCS));
    }

    #[test]
    fn repromptable_detects_auth_and_format_failures() {
        assert!(is_repromptable_openai_key_error(&anyhow::anyhow!(
            openai_key_error(
                "OpenAI rejected the key (401 unauthorized) — export a fresh key or pass --openai-api-key",
            )
        )));
        assert!(is_repromptable_openai_key_error(&anyhow::anyhow!(
            openai_key_error(
                "OpenAI rejected the key (403 forbidden) — check project access and billing",
            )
        )));
        assert!(is_repromptable_openai_key_error(&anyhow::anyhow!(
            openai_key_error("OPENAI_API_KEY is empty")
        )));
        assert!(is_repromptable_openai_key_error(&anyhow::anyhow!(
            openai_key_error(
                "OPENAI_API_KEY must start with sk- (paste a valid OpenAI secret key)",
            )
        )));
        assert!(!is_repromptable_openai_key_error(&anyhow::anyhow!(
            openai_key_error("OpenAI rate-limited the validation probe — retry in a moment")
        )));
        assert!(!is_repromptable_openai_key_error(&anyhow::anyhow!(
            "OpenAI key validation request failed (network)"
        )));
    }
}
