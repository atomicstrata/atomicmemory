//! Per-command agent output sanitizers — fail closed when unregistered.

use std::collections::HashMap;
use std::sync::LazyLock;

use anyhow::{Result, bail};
use serde::Serialize;
use serde_json::Value;

use crate::hooks::sanitize::redact_secrets;

type SanitizerFn = fn(Value) -> Result<Value>;

static SANITIZERS: LazyLock<HashMap<String, SanitizerFn>> = LazyLock::new(|| {
    let mut map: HashMap<String, SanitizerFn> = HashMap::new();
    map.insert("memory ingest".into(), sanitize_ingest);
    map.insert("memory search".into(), sanitize_search);
    map.insert("memory list".into(), sanitize_list);
    map.insert("memory get".into(), sanitize_memory_row);
    map.insert("memory delete".into(), sanitize_delete);
    map.insert("memory package".into(), sanitize_package);
    map.insert("hooks install".into(), passthrough);
    map.insert("hooks uninstall".into(), passthrough);
    map.insert("hooks doctor".into(), passthrough);
    map.insert("hooks run".into(), sanitize_hooks_run);
    map
});

#[cfg(test)]
pub fn registered_agent_commands() -> Vec<String> {
    SANITIZERS.keys().cloned().collect()
}

/// True when `command` can produce an agent envelope.
///
/// Checked *before* dispatch so an unsupported command is rejected instead of
/// running: `emit` only refuses at print time, which let mutating commands
/// change state and then fail (or, for commands that call `emit` directly,
/// print raw output under `--agent` and exit 0).
pub fn supports_agent_output(command: &str) -> bool {
    SANITIZERS.contains_key(command)
}

/// Sorted command list for the "unsupported command" error message.
pub fn agent_command_list() -> Vec<String> {
    let mut names: Vec<String> = SANITIZERS.keys().cloned().collect();
    names.sort();
    names
}

pub fn sanitize_for_agent(command: &str, input: &impl Serialize) -> Result<Value> {
    let value = serde_json::to_value(input)?;
    let Some(sanitize) = SANITIZERS.get(command) else {
        bail!("agent output is not supported for command \"{command}\" — no sanitizer registered");
    };
    sanitize(value)
}

fn passthrough(value: Value) -> Result<Value> {
    Ok(value)
}

fn strip_object_keys(mut value: Value, keys: &[&str]) -> Value {
    if let Some(map) = value.as_object_mut() {
        for key in keys {
            map.remove(*key);
        }
    }
    value
}

fn sanitize_ingest(value: Value) -> Result<Value> {
    Ok(strip_object_keys(value, &["audn_trace", "ingest_trace_id"]))
}

fn sanitize_search(value: Value) -> Result<Value> {
    Ok(strip_object_keys(
        value,
        &[
            "observability",
            "consensus",
            "lesson_check",
            "tier_assignments",
            "expand_ids",
            "scope",
        ],
    ))
}

fn sanitize_list(value: Value) -> Result<Value> {
    Ok(value)
}

fn sanitize_memory_row(value: Value) -> Result<Value> {
    Ok(value)
}

fn sanitize_delete(value: Value) -> Result<Value> {
    Ok(value)
}

fn sanitize_package(value: Value) -> Result<Value> {
    Ok(value)
}

fn sanitize_hooks_run(value: Value) -> Result<Value> {
    if let Some(obj) = value.as_object() {
        let mut out = obj.clone();
        if let Some(data) = out.get_mut("data") {
            redact_hook_data(data);
        }
        return Ok(Value::Object(out));
    }
    Ok(value)
}

fn redact_hook_data(data: &mut Value) {
    if let Some(map) = data.as_object_mut() {
        if let Some(hook_output) = map.get_mut("hookSpecificOutput") {
            if let Some(inner) = hook_output.as_object_mut() {
                if let Some(ctx) = inner.get_mut("additionalContext") {
                    if let Some(s) = ctx.as_str() {
                        *ctx = Value::String(redact_secrets(s));
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn search_strips_observability_fields() {
        let raw = json!({
            "count": 1,
            "memories": [],
            "observability": {"debug": true},
            "consensus": {"x": 1}
        });
        let out = sanitize_search(raw).expect("sanitize");
        assert!(out.get("observability").is_none());
        assert!(out.get("consensus").is_none());
        assert_eq!(out["count"], 1);
    }

    #[test]
    fn unregistered_command_fails_closed() {
        let err = sanitize_for_agent("config env show", &json!({})).unwrap_err();
        assert!(err.to_string().contains("not supported"));
    }
}
