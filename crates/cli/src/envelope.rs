//! Agent/JSON output envelope builders for automation-friendly CLI output.

use serde::Serialize;
use serde_json::Value;

use crate::cli::GlobalOptions;

#[derive(Debug, Clone, Serialize)]
pub struct ScopeEnvelope {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    #[serde(rename = "agent_id", skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub namespace: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ErrorEnvelopeBody {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CliOutputEnvelope<T> {
    pub status: &'static str,
    pub command: String,
    pub duration_ms: u64,
    pub profile: String,
    pub count: i32,
    pub data: T,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<ScopeEnvelope>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meta: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorEnvelopeBody>,
}

pub struct EmitContext {
    pub command: String,
    pub started_at: std::time::Instant,
    pub profile: String,
    pub scope: Option<ScopeEnvelope>,
    pub meta: Option<Value>,
}

impl EmitContext {
    pub fn new(command: impl Into<String>, global: &GlobalOptions) -> Self {
        Self::new_at(command, global, std::time::Instant::now())
    }

    pub fn new_at(
        command: impl Into<String>,
        global: &GlobalOptions,
        started_at: std::time::Instant,
    ) -> Self {
        Self {
            command: command.into(),
            started_at,
            profile: global.profile.clone().unwrap_or_else(|| "default".into()),
            scope: scope_from_global(global),
            meta: None,
        }
    }

    pub fn with_meta(mut self, meta: Value) -> Self {
        self.meta = Some(meta);
        self
    }
}

pub fn scope_from_global(global: &GlobalOptions) -> Option<ScopeEnvelope> {
    let scope = ScopeEnvelope {
        user: global.scope_user.clone(),
        agent_id: global.scope_agent_id.clone(),
        namespace: global.scope_namespace.clone(),
        thread: global.scope_thread.clone(),
    };
    if scope.user.is_none()
        && scope.agent_id.is_none()
        && scope.namespace.is_none()
        && scope.thread.is_none()
    {
        None
    } else {
        Some(scope)
    }
}

pub fn success_envelope_value(
    ctx: &EmitContext,
    data: Value,
    count: Option<i32>,
) -> CliOutputEnvelope<Value> {
    CliOutputEnvelope {
        status: "success",
        command: ctx.command.clone(),
        duration_ms: ctx.started_at.elapsed().as_millis() as u64,
        profile: ctx.profile.clone(),
        count: resolve_count_value(count, &data),
        data,
        scope: ctx.scope.clone(),
        meta: ctx.meta.clone(),
        error: None,
    }
}

fn resolve_count_value(explicit: Option<i32>, data: &Value) -> i32 {
    if let Some(n) = explicit {
        return n;
    }
    if let Some(arr) = data.as_array() {
        return arr.len() as i32;
    }
    if data.is_null() { 0 } else { 1 }
}

pub fn error_envelope(ctx: &EmitContext, code: &str, message: &str) -> CliOutputEnvelope<Value> {
    CliOutputEnvelope {
        status: "error",
        command: ctx.command.clone(),
        duration_ms: ctx.started_at.elapsed().as_millis() as u64,
        profile: ctx.profile.clone(),
        count: 0,
        data: Value::Null,
        scope: ctx.scope.clone(),
        meta: None,
        error: Some(ErrorEnvelopeBody {
            code: code.into(),
            message: message.into(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn success_envelope_uses_explicit_count() {
        let global = crate::cli::GlobalOptions::default();
        let ctx = EmitContext::new("memory search", &global);
        let envelope = success_envelope_value(&ctx, serde_json::json!({"hits": []}), Some(3));
        assert_eq!(envelope.count, 3);
        assert_eq!(envelope.status, "success");
        assert_eq!(envelope.command, "memory search");
    }
}
