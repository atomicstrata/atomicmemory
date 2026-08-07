//! Supported agent hosts and their config path conventions.

use std::path::{Path, PathBuf};

use anyhow::{Result, bail};
use clap::ValueEnum;
use serde::Serialize;

use crate::integrate::path_util::home_dir;

pub const MCP_SERVER_NAME: &str = "atomicmemory";
pub const PROJECT_SCOPE_UNSUPPORTED: &str =
    "project-scoped host installs are not supported yet — use global install (omit --project)";

/// Agent host that can load AtomicMemory via MCP.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, ValueEnum)]
#[serde(rename_all = "kebab-case")]
#[value(rename_all = "kebab-case")]
pub enum Host {
    Cursor,
    ClaudeCode,
    Codex,
}

impl Host {
    pub fn id(self) -> &'static str {
        match self {
            Host::Cursor => "cursor",
            Host::ClaudeCode => "claude-code",
            Host::Codex => "codex",
        }
    }

    pub fn scope_agent(self) -> &'static str {
        self.id()
    }

    pub fn display_name(self) -> &'static str {
        match self {
            Host::Cursor => "Cursor",
            Host::ClaudeCode => "Claude Code",
            Host::Codex => "Codex",
        }
    }

    pub fn config_path(self, scope: InstallScope, _cwd: &Path) -> Result<PathBuf> {
        if scope == InstallScope::Project {
            bail!("{PROJECT_SCOPE_UNSUPPORTED}");
        }
        let home = home_dir()?;
        Ok(match self {
            Host::Cursor => home.join(".cursor/mcp.json"),
            Host::ClaudeCode => home.join(".claude.json"),
            Host::Codex => home.join(".codex/config.toml"),
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ValueEnum, Default)]
#[serde(rename_all = "lowercase")]
pub enum InstallScope {
    #[default]
    Global,
    Project,
}

impl InstallScope {
    pub fn id(self) -> &'static str {
        match self {
            InstallScope::Global => "global",
            InstallScope::Project => "project",
        }
    }
}

pub fn all_hosts() -> [Host; 3] {
    [Host::Cursor, Host::ClaudeCode, Host::Codex]
}

pub fn parse_host(raw: &str) -> Result<Host> {
    match raw.to_ascii_lowercase().as_str() {
        "cursor" => Ok(Host::Cursor),
        "claude-code" | "claude_code" | "claude" => Ok(Host::ClaudeCode),
        "codex" => Ok(Host::Codex),
        other => bail!("unknown host {other:?} — expected cursor, claude-code, or codex"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_scope_is_refused() {
        let err = Host::Cursor
            .config_path(InstallScope::Project, Path::new("/tmp"))
            .unwrap_err();
        assert!(err.to_string().contains("not supported"));
    }
}
