//! Hook runtime invoked by host configs (`am hooks run`).

use anyhow::{Context, Result};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::{self, Read};

use am_core_types::CoreIngestRequest;

use crate::cli::GlobalOptions;
use crate::commands::client::memory_client;
use crate::commands::memory::scope::{MemoryScope, NamespaceSupport, resolve_memory_scope_with};
use crate::hooks::sanitize::{
    clean_compact_summary_text, clean_summary_text, format_additional_context, redact_secrets,
    sanitize_prompt_context,
};
use crate::hooks::types::{
    COMPACT_MAX_SUMMARY_CHARS, DEFAULT_PROMPT_SEARCH_LIMIT, HookEvent, HookHost, MIN_PROMPT_CHARS,
    PROMPT_CONTEXT_PER_HIT_CHARS, PROMPT_CONTEXT_TOTAL_CHARS, STOP_MAX_SUMMARY_CHARS,
    STOP_MIN_ASSISTANT_CHARS, read_positive_usize_env,
};

#[derive(Debug, Serialize)]
pub struct UserPromptSubmitOutput {
    #[serde(rename = "hookSpecificOutput")]
    pub hook_specific_output: UserPromptSubmitBody,
}

#[derive(Debug, Serialize)]
pub struct UserPromptSubmitBody {
    #[serde(rename = "hookEventName")]
    pub hook_event_name: &'static str,
    /// MUST serialize as `additionalContext`: this is the host wire contract
    /// (Claude Code reads `hookSpecificOutput.additionalContext`, and so does
    /// the npm runtime this ports). Emitting the snake_case field name makes
    /// the host silently ignore the payload and inject no context at all.
    #[serde(rename = "additionalContext")]
    pub additional_context: String,
}

#[derive(Debug, Serialize)]
pub struct HookRunReport {
    pub skipped: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<UserPromptSubmitOutput>,
}

pub async fn run_event(
    global: &GlobalOptions,
    event: HookEvent,
    host: HookHost,
    limit: Option<i64>,
) -> Result<HookRunReport> {
    let input = read_hook_json()?;
    match event {
        HookEvent::UserPromptSubmit => run_user_prompt_submit(global, host, limit, &input).await,
        HookEvent::PostCompact => run_post_compact(global, host, &input).await,
        HookEvent::Stop => run_stop(global, host, &input).await,
    }
}

/// `_host` is deliberately unused: Claude Code and Codex consume the *same*
/// `hookSpecificOutput.additionalContext` wire shape for UserPromptSubmit (the
/// host only varies the ingest-side dedupe key / source, see
/// [`ingest_hook_record`]). The parameter stays for signature symmetry with the
/// other events.
async fn run_user_prompt_submit(
    global: &GlobalOptions,
    _host: HookHost,
    limit: Option<i64>,
    input: &serde_json::Map<String, Value>,
) -> Result<HookRunReport> {
    let prompt = first_string(
        input,
        &["prompt", "user_prompt", "userPrompt", "message", "text"],
    );
    let Some(prompt) = prompt else {
        return Ok(skip("no_content"));
    };
    if prompt.len() < MIN_PROMPT_CHARS {
        return Ok(skip("prompt_too_short"));
    }
    let scope = resolve_memory_scope_with(global, None, None, None, NamespaceSupport::Supported)?;
    let (_profile, client) = memory_client(global).await?;
    let req = am_core_types::CoreSearchRequest {
        user_id: scope.user_id,
        query: prompt,
        limit: Some(limit.unwrap_or(DEFAULT_PROMPT_SEARCH_LIMIT)),
        threshold: None,
        token_budget: None,
        retrieval_mode: None,
        skip_repair: None,
        source_site: None,
        agent_id: scope.agent_id,
        workspace_id: scope.workspace_id,
        session_id: scope.session_id,
        visibility: None,
        as_of: None,
        namespace_scope: scope.namespace_scope,
        config_override: None,
    };
    let resp = client.search_fast(&req).await?;
    if resp.memories.is_empty() {
        return Ok(skip("no_hits"));
    }
    let per_hit = read_positive_usize_env(
        "ATOMICMEMORY_PROMPT_CONTEXT_PER_HIT_CHARS",
        PROMPT_CONTEXT_PER_HIT_CHARS,
    )?;
    let total = read_positive_usize_env(
        "ATOMICMEMORY_PROMPT_CONTEXT_TOTAL_CHARS",
        PROMPT_CONTEXT_TOTAL_CHARS,
    )?;
    let sanitized = sanitize_prompt_context(
        &resp
            .memories
            .iter()
            .map(|hit| hit.memory.content.clone())
            .collect::<Vec<_>>(),
        per_hit,
        total,
    );
    if sanitized.lines.is_empty() {
        return Ok(skip("no_hits"));
    }
    let data = UserPromptSubmitOutput {
        hook_specific_output: UserPromptSubmitBody {
            hook_event_name: "UserPromptSubmit",
            additional_context: format_additional_context(&sanitized.lines),
        },
    };
    Ok(HookRunReport {
        skipped: false,
        reason: None,
        data: Some(data),
    })
}

async fn run_post_compact(
    global: &GlobalOptions,
    host: HookHost,
    input: &serde_json::Map<String, Value>,
) -> Result<HookRunReport> {
    let raw = first_string(input, &["compact_summary", "compactSummary", "summary"]);
    let Some(raw) = raw else {
        return Ok(skip("no_content"));
    };
    let max = read_positive_usize_env(
        "ATOMICMEMORY_COMPACT_MAX_SUMMARY_CHARS",
        COMPACT_MAX_SUMMARY_CHARS,
    )?;
    let cleaned = clean_compact_summary_text(&redact_secrets(&raw), max);
    if cleaned.is_empty() {
        return Ok(skip("no_content"));
    }
    ingest_hook_record(global, host, HookEvent::PostCompact, &cleaned).await?;
    Ok(HookRunReport {
        skipped: false,
        reason: None,
        data: None,
    })
}

async fn run_stop(
    global: &GlobalOptions,
    host: HookHost,
    input: &serde_json::Map<String, Value>,
) -> Result<HookRunReport> {
    let raw = first_string(
        input,
        &[
            "last_assistant_message",
            "lastAssistantMessage",
            "assistant_response",
            "assistantResponse",
            "response",
            "message",
            "content",
        ],
    );
    let Some(raw) = raw else {
        return Ok(skip("no_content"));
    };
    let max = read_positive_usize_env(
        "ATOMICMEMORY_STOP_MAX_SUMMARY_CHARS",
        STOP_MAX_SUMMARY_CHARS,
    )?;
    let min = read_positive_usize_env(
        "ATOMICMEMORY_STOP_MIN_ASSISTANT_CHARS",
        STOP_MIN_ASSISTANT_CHARS,
    )?;
    let cleaned = clean_summary_text(&redact_secrets(&raw), max);
    if cleaned.is_empty() {
        return Ok(skip("no_content"));
    }
    if cleaned.len() < min {
        return Ok(skip("low_signal"));
    }
    ingest_hook_record(global, host, HookEvent::Stop, &cleaned).await?;
    Ok(HookRunReport {
        skipped: false,
        reason: None,
        data: None,
    })
}

async fn ingest_hook_record(
    global: &GlobalOptions,
    host: HookHost,
    event: HookEvent,
    content: &str,
) -> Result<()> {
    // `CoreIngestRequest` carries no namespace field.
    let scope = resolve_memory_scope_with(global, None, None, None, NamespaceSupport::Unsupported)?;
    let dedupe_key = hook_dedupe_key(host, event, &scope, content);
    let metadata = serde_json::json!({
        "source": host.id(),
        "event": event.cli_name().replace('-', "_"),
        "externalId": dedupe_key,
        "dedupe_key": dedupe_key,
        "schema_version": 1,
    });
    let req = CoreIngestRequest {
        user_id: scope.user_id,
        source_site: host.id().into(),
        conversation: content.to_string(),
        agent_id: scope.agent_id,
        workspace_id: scope.workspace_id,
        session_id: scope.session_id,
        source_url: Some(format!(
            "atomicmemory://{}/{}/{}",
            host.id(),
            event.cli_name(),
            dedupe_key
        )),
        metadata: Some(metadata),
        skip_extraction: Some(true),
        content_class: Some("summary".into()),
        visibility: None,
        config_override: None,
    };
    let (_profile, client) = memory_client(global).await?;
    client.ingest_quick(&req).await?;
    Ok(())
}

fn skip(reason: &'static str) -> HookRunReport {
    HookRunReport {
        skipped: true,
        reason: Some(reason),
        data: None,
    }
}

/// Upper bound on hook stdin. Hook payloads are a prompt or one assistant
/// message; anything past this is a runaway or hostile producer. The cap is
/// applied *before* sanitization because the sanitizers allocate several full
/// copies of the input, so an unbounded read is a memory-exhaustion vector on
/// a path that runs automatically on every agent lifecycle event.
const MAX_HOOK_INPUT_BYTES: u64 = 4 * 1024 * 1024;

fn read_hook_json() -> Result<serde_json::Map<String, Value>> {
    read_hook_json_from(io::stdin().lock())
}

fn read_hook_json_from<R: Read>(reader: R) -> Result<serde_json::Map<String, Value>> {
    let mut buf = String::new();
    let read = reader
        .take(MAX_HOOK_INPUT_BYTES + 1)
        .read_to_string(&mut buf)?;
    if read as u64 > MAX_HOOK_INPUT_BYTES {
        // Fail closed: a truncated payload would parse as invalid JSON or,
        // worse, as a valid prefix that silently loses content.
        anyhow::bail!(
            "hook input exceeds {MAX_HOOK_INPUT_BYTES} bytes; refusing to process a payload this large"
        );
    }
    let trimmed = buf.trim();
    if trimmed.is_empty() {
        return Ok(serde_json::Map::new());
    }
    let parsed: Value = serde_json::from_str(trimmed).context("hook input is not valid JSON")?;
    parsed
        .as_object()
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("hook input must be a JSON object"))
}

fn first_string(input: &serde_json::Map<String, Value>, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(Value::String(value)) = input.get(*key) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

fn hook_dedupe_key(host: HookHost, event: HookEvent, scope: &MemoryScope, content: &str) -> String {
    let payload = serde_json::json!({
        "content": content,
        "event": event.cli_name(),
        "host": host.id(),
        "user": scope.user_id,
        "agent": scope.agent_id,
        "workspace": scope.workspace_id,
        "session": scope.session_id,
        "namespace": scope.namespace_scope,
    });
    let mut hasher = Sha256::new();
    hasher.update(payload.to_string().as_bytes());
    hex::encode(hasher.finalize())
}

pub fn print_hook_stdout(report: &HookRunReport) -> Result<()> {
    if let Some(data) = &report.data {
        println!("{}", serde_json::to_string(data)?);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_prompt_submit_uses_the_host_camel_case_key() {
        // The host reads `hookSpecificOutput.additionalContext`. Emitting the
        // Rust field name (`additional_context`) makes Claude Code ignore the
        // payload silently, so no context is ever injected.
        let out = UserPromptSubmitOutput {
            hook_specific_output: UserPromptSubmitBody {
                hook_event_name: "UserPromptSubmit",
                additional_context: "prior context".into(),
            },
        };
        let value = serde_json::to_value(&out).expect("serialize");
        let body = &value["hookSpecificOutput"];
        assert_eq!(body["hookEventName"], "UserPromptSubmit");
        assert_eq!(body["additionalContext"], "prior context");
        assert!(
            body.get("additional_context").is_none(),
            "snake_case key must not be emitted: {value}"
        );
    }

    #[test]
    fn hook_input_within_the_cap_parses() {
        let input = br#"{"prompt":"hello"}"#;
        let parsed = read_hook_json_from(&input[..]).expect("parse");
        assert_eq!(parsed["prompt"], "hello");
    }

    #[test]
    fn oversized_hook_input_fails_closed() {
        // Unbounded reads let a runaway/hostile producer exhaust memory on a
        // path that runs automatically on every lifecycle event.
        let oversized = vec![b'x'; (MAX_HOOK_INPUT_BYTES + 1024) as usize];
        let err = read_hook_json_from(&oversized[..]).unwrap_err().to_string();
        assert!(err.contains("exceeds"), "{err}");
    }

    #[test]
    fn empty_hook_input_is_an_empty_object() {
        let parsed = read_hook_json_from(&b""[..]).expect("parse");
        assert!(parsed.is_empty());
    }
}
