//! Shared hook types and environment limit parsing.

use anyhow::{Result, bail};

pub const COMPACT_MAX_SUMMARY_CHARS: usize = 2400;
pub const STOP_MAX_SUMMARY_CHARS: usize = 600;
pub const STOP_MIN_ASSISTANT_CHARS: usize = 200;
pub const PROMPT_CONTEXT_PER_HIT_CHARS: usize = 800;
pub const PROMPT_CONTEXT_TOTAL_CHARS: usize = 4000;
pub const MIN_PROMPT_CHARS: usize = 20;
pub const DEFAULT_PROMPT_SEARCH_LIMIT: i64 = 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookHost {
    Codex,
    ClaudeCode,
}

impl HookHost {
    pub fn id(self) -> &'static str {
        match self {
            HookHost::Codex => "codex",
            HookHost::ClaudeCode => "claude-code",
        }
    }

    pub fn parse(raw: &str) -> Result<Self> {
        match raw.to_ascii_lowercase().as_str() {
            "codex" => Ok(HookHost::Codex),
            "claude-code" | "claude_code" | "claude" => Ok(HookHost::ClaudeCode),
            other => bail!("--host must be codex|claude-code; got \"{other}\""),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookEvent {
    UserPromptSubmit,
    PostCompact,
    Stop,
}

impl HookEvent {
    pub fn parse(raw: &str) -> Result<Self> {
        let normalized = raw.replace('_', "-").to_ascii_lowercase();
        match normalized.as_str() {
            "user-prompt-submit" => Ok(HookEvent::UserPromptSubmit),
            "post-compact" => Ok(HookEvent::PostCompact),
            "stop" => Ok(HookEvent::Stop),
            other => bail!(
                "hooks run requires event user-prompt-submit, post-compact, or stop; got \"{other}\""
            ),
        }
    }

    pub fn cli_name(self) -> &'static str {
        match self {
            HookEvent::UserPromptSubmit => "user-prompt-submit",
            HookEvent::PostCompact => "post-compact",
            HookEvent::Stop => "stop",
        }
    }

    pub fn host_event_key(self) -> &'static str {
        match self {
            HookEvent::UserPromptSubmit => "UserPromptSubmit",
            HookEvent::PostCompact => "PostCompact",
            HookEvent::Stop => "Stop",
        }
    }

    pub fn status_message(self) -> Option<&'static str> {
        match self {
            HookEvent::UserPromptSubmit => Some("Searching AtomicMemory..."),
            HookEvent::PostCompact => Some("Saving AtomicMemory compact summary..."),
            HookEvent::Stop => None,
        }
    }
}

pub fn read_positive_usize_env(name: &str, fallback: usize) -> Result<usize> {
    match std::env::var(name) {
        Ok(raw) if raw.trim().is_empty() => Ok(fallback),
        Ok(raw) => {
            let value: usize = raw
                .parse()
                .map_err(|_| anyhow::anyhow!("{name} must be a positive integer; got \"{raw}\""))?;
            if value == 0 {
                bail!("{name} must be a positive integer; got \"{raw}\"");
            }
            Ok(value)
        }
        Err(_) => Ok(fallback),
    }
}
