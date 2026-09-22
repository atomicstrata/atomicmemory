//! Supported agent hosts and their config path conventions.

use std::path::{Path, PathBuf};

use anyhow::{Result, bail};
use clap::ValueEnum;
use serde::Serialize;

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
    #[serde(rename = "opencode")]
    #[value(name = "opencode")]
    OpenCode,
}

impl Host {
    pub fn id(self) -> &'static str {
        match self {
            Host::Cursor => "cursor",
            Host::ClaudeCode => "claude-code",
            Host::Codex => "codex",
            Host::OpenCode => "opencode",
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
            Host::OpenCode => "OpenCode",
        }
    }
}

/// Resolved process-boundary roots used to locate host configuration files.
#[derive(Debug, Clone)]
pub struct HostConfigPaths {
    home: PathBuf,
    config_home: PathBuf,
}

impl HostConfigPaths {
    /// Build host paths from home and an optional process-resolved XDG config root.
    pub fn new(home: PathBuf, xdg_config_home: Option<PathBuf>) -> Self {
        let config_home = xdg_config_home.unwrap_or_else(|| home.join(".config"));
        Self { home, config_home }
    }

    /// Return the configuration file used by a host at the requested scope.
    pub fn config_path(&self, host: Host, scope: InstallScope, _cwd: &Path) -> Result<PathBuf> {
        if scope == InstallScope::Project {
            bail!("{PROJECT_SCOPE_UNSUPPORTED}");
        }
        Ok(self.global_config_path(host))
    }

    /// Return the global configuration file for a host.
    pub fn global_config_path(&self, host: Host) -> PathBuf {
        match host {
            Host::Cursor => self.home.join(".cursor/mcp.json"),
            Host::ClaudeCode => self.home.join(".claude.json"),
            Host::Codex => self.home.join(".codex/config.toml"),
            Host::OpenCode => opencode_config_path(&self.config_home),
        }
    }

    /// Return every OpenCode V2 global config file in merge order.
    pub fn opencode_global_config_paths(&self) -> [PathBuf; 3] {
        let dir = self.config_home.join("opencode");
        [
            dir.join("config.json"),
            dir.join("opencode.json"),
            dir.join("opencode.jsonc"),
        ]
    }

    /// Return whether a host-specific support directory or file exists.
    pub fn support_path_exists(&self, host: Host) -> bool {
        match host {
            Host::Cursor => self.home.join(".cursor").is_dir(),
            Host::ClaudeCode => {
                self.home.join(".claude").is_dir() || self.home.join(".claude.json").exists()
            }
            Host::Codex => self.home.join(".codex").is_dir(),
            Host::OpenCode => self.config_home.join("opencode").is_dir(),
        }
    }
}

fn opencode_config_path(config_home: &Path) -> PathBuf {
    let dir = config_home.join("opencode");
    let jsonc = dir.join("opencode.jsonc");
    if jsonc.exists() {
        jsonc
    } else {
        dir.join("opencode.json")
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

pub fn all_hosts() -> [Host; 4] {
    [Host::Cursor, Host::ClaudeCode, Host::Codex, Host::OpenCode]
}

pub fn parse_host(raw: &str) -> Result<Host> {
    match raw.to_ascii_lowercase().as_str() {
        "cursor" => Ok(Host::Cursor),
        "claude-code" | "claude_code" | "claude" => Ok(Host::ClaudeCode),
        "codex" => Ok(Host::Codex),
        "opencode" => Ok(Host::OpenCode),
        other => bail!("unknown host {other:?} — expected cursor, claude-code, codex, or opencode"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn project_scope_is_refused() {
        let paths = HostConfigPaths::new(PathBuf::from("/home/test"), None);
        let err = paths
            .config_path(Host::Cursor, InstallScope::Project, Path::new("/tmp"))
            .unwrap_err();
        assert!(err.to_string().contains("not supported"));
    }

    #[test]
    fn opencode_path_uses_default_config_home() {
        let home = tempfile::tempdir().unwrap();
        let paths = HostConfigPaths::new(home.path().to_path_buf(), None);
        assert_eq!(
            paths
                .config_path(Host::OpenCode, InstallScope::Global, Path::new("."))
                .unwrap(),
            home.path().join(".config/opencode/opencode.json")
        );
    }

    #[test]
    fn opencode_path_respects_xdg_and_existing_jsonc() {
        let xdg = tempfile::tempdir().unwrap();
        let dir = xdg.path().join("opencode");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("opencode.jsonc"), "{}\n").unwrap();

        let paths = HostConfigPaths::new(PathBuf::from("/home/test"), Some(xdg.path().into()));
        assert_eq!(
            paths
                .config_path(Host::OpenCode, InstallScope::Global, Path::new("."))
                .unwrap(),
            dir.join("opencode.jsonc")
        );
    }

    #[test]
    fn opencode_serializes_with_public_host_id() {
        assert_eq!(
            serde_json::to_string(&Host::OpenCode).unwrap(),
            "\"opencode\""
        );
    }
}
