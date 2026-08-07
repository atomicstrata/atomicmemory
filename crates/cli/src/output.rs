//! Render CLI output as human tables, JSON, or agent envelopes.

use am_cloud_client::CloudClientError;
use anyhow::Result;
use serde::Serialize;

use crate::agent_sanitize::sanitize_for_agent;
use crate::cli::{GlobalOptions, OutputFormat};
use crate::envelope::EmitContext;

pub fn emit_command<T: Serialize>(
    global: &GlobalOptions,
    ctx: &EmitContext,
    value: &T,
    count: Option<i32>,
) -> Result<()> {
    if global.agent_output() {
        let data = sanitize_for_agent(&ctx.command, value)?;
        let envelope = crate::envelope::success_envelope_value(ctx, data, count);
        println!("{}", serde_json::to_string(&envelope)?);
        return Ok(());
    }
    emit(global.output, value, global.quiet)
}

pub fn emit<T: Serialize>(format: OutputFormat, value: &T, quiet: bool) -> Result<()> {
    if format == OutputFormat::Agent {
        anyhow::bail!(
            "internal error: agent output must use emit_command with a registered command path"
        );
    }
    match format {
        OutputFormat::Json => {
            println!("{}", serde_json::to_string_pretty(value)?);
        }
        OutputFormat::Table if !quiet => {
            println!("{}", serde_json::to_string_pretty(value)?);
        }
        OutputFormat::Table => {}
        OutputFormat::Agent => {}
    }
    Ok(())
}

/// The line to print, or `None` when output is suppressed.
///
/// The flag means "should print", not "quiet": every caller passes `!quiet`,
/// or a literal `true` for output that must always appear (for example the
/// `am connect env` blocks and the non-TTY device-login code). Inverting it
/// silences normal runs and makes `--quiet` the only mode that prints, which
/// is how the verification URL went missing from headless `am auth login`.
fn message_line(should_print: bool, text: &str) -> Option<&str> {
    should_print.then_some(text)
}

pub fn message(should_print: bool, text: &str) {
    if let Some(line) = message_line(should_print, text) {
        eprintln!("{line}");
    }
}

/// Exit codes: 0 success, 1 general, 2 auth, 3 network/timeout, 4 server HTTP error.
pub fn exit_code_for_error(err: &anyhow::Error) -> i32 {
    for cause in err.chain() {
        if let Some(cloud) = cause.downcast_ref::<CloudClientError>() {
            return cloud.exit_code();
        }
    }
    let s = err.to_string().to_ascii_lowercase();
    if s.contains("not logged in")
        || s.contains("authentication")
        || s.contains("oauth")
        || s.contains("401")
        || s.contains("403")
    {
        2
    } else if s.contains("timed out") || s.contains("timeout") || s.contains("network") {
        3
    } else if s.contains("server returned") {
        4
    } else {
        1
    }
}

pub fn error_code_for_message(message: &str) -> &'static str {
    let s = message.to_ascii_lowercase();
    if s.contains("not logged in")
        || s.contains("authentication")
        || s.contains("oauth")
        || s.contains("401")
        || s.contains("403")
    {
        "auth"
    } else if s.contains("timed out") || s.contains("timeout") || s.contains("network") {
        "network"
    } else if s.contains("server returned") {
        "server"
    } else if s.contains("required")
        || s.contains("invalid")
        || s.contains("unexpected")
        || s.contains("unknown")
        || s.contains("missing")
    {
        "usage"
    } else {
        "runtime"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::GlobalOptions;
    use crate::envelope::EmitContext;

    #[test]
    fn agent_emit_via_command_produces_envelope() {
        let global = GlobalOptions {
            agent: true,
            ..GlobalOptions::default()
        };
        let ctx = EmitContext::new("memory search", &global);
        let data = crate::agent_sanitize::sanitize_for_agent(
            "memory search",
            &serde_json::json!({"count": 0, "memories": []}),
        )
        .expect("sanitize");
        let envelope = crate::envelope::success_envelope_value(&ctx, data, Some(0));
        assert_eq!(envelope.status, "success");
        assert_eq!(envelope.command, "memory search");
    }

    #[test]
    fn emit_agent_format_fails_closed() {
        let err = emit(OutputFormat::Agent, &serde_json::json!({}), false).unwrap_err();
        assert!(err.to_string().contains("emit_command"));
    }
}
