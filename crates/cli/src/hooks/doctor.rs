//! Doctor checks for installed lifecycle hooks.

use anyhow::Result;
use serde::Serialize;
use std::path::Path;

use crate::hooks::edit::{HookOwner, claude_hook_owners, codex_hook_owners};
use crate::hooks::types::HookHost;
use crate::integrate::codex_edit::read_codex_document;
use crate::integrate::write::read_json_file;

#[derive(Debug, Serialize)]
pub struct HooksDoctorReport {
    pub host: String,
    pub path: String,
    pub installed: bool,
    pub uses_am: bool,
    pub warnings: Vec<String>,
}

pub fn doctor_host(host: HookHost) -> Result<HooksDoctorReport> {
    let path = match host {
        HookHost::Codex => super::install::codex_config_path()?,
        HookHost::ClaudeCode => super::install::claude_settings_path()?,
    };
    // Parse the host config and read the declared hook commands. Scanning raw
    // lines cannot work: a serialized command is one quoted value, so the argv
    // grammar never sees `am` as argv[0] and every real install looked absent.
    let owners = if path.exists() {
        match host {
            HookHost::Codex => codex_hook_owners(&read_codex_document(&path)?),
            HookHost::ClaudeCode => claude_hook_owners(&read_json_file(&path)?),
        }
    } else {
        Vec::new()
    };
    let uses_am = owners.contains(&HookOwner::Am);
    let installed = uses_am;
    let mut warnings = Vec::new();
    if owners.contains(&HookOwner::LegacyNpm) {
        warnings.push(
            "legacy atomicmemory hooks command detected — run `am hooks install` to retarget"
                .into(),
        );
    }
    if host == HookHost::ClaudeCode && plugin_hooks_present() {
        warnings.push(
            "Claude Code plugin shell hooks detected — pick plugin OR `am hooks`, not both".into(),
        );
    }
    Ok(HooksDoctorReport {
        host: host.id().into(),
        path: path.display().to_string(),
        installed,
        uses_am,
        warnings,
    })
}

fn plugin_hooks_present() -> bool {
    let home = crate::integrate::path_util::home_dir().ok();
    let Some(home) = home else {
        return false;
    };
    let plugin_hooks = home.join(".claude/plugins/atomicmemory/hooks/hooks.json");
    Path::new(&plugin_hooks).exists()
}
