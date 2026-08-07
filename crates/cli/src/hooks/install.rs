//! Install and uninstall lifecycle hook snippets in host configs.

use anyhow::{Context, Result};
use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use toml_edit::DocumentMut;

use crate::hooks::edit::{
    merge_claude_hooks, merge_codex_hooks, remove_claude_hooks, remove_codex_hooks,
    write_codex_text,
};
use crate::hooks::types::HookHost;
use crate::integrate::codex_edit::read_codex_document;
use crate::integrate::path_util::home_dir;
use crate::integrate::write::{backup_host_config, read_json_file, write_secure_file};

#[derive(Debug, Serialize)]
pub struct HooksInstallReport {
    pub host: String,
    pub path: String,
    pub changed: bool,
    pub dry_run: bool,
    pub command_template: String,
}

pub fn install_host(host: HookHost, dry_run: bool) -> Result<HooksInstallReport> {
    let am_path = std::env::current_exe()
        .context("resolve am binary path")?
        .display()
        .to_string();
    let command_template = format!("{} hooks run <event> --host {}", am_path, host.id());
    let (path, changed) = match host {
        HookHost::Codex => install_codex(&am_path, host, dry_run)?,
        HookHost::ClaudeCode => install_claude_code(&am_path, host, dry_run)?,
    };
    Ok(HooksInstallReport {
        host: host.id().into(),
        path: path.display().to_string(),
        changed,
        dry_run,
        command_template,
    })
}

pub fn uninstall_host(host: HookHost, dry_run: bool) -> Result<HooksInstallReport> {
    let am_path = std::env::current_exe()
        .context("resolve am binary path")?
        .display()
        .to_string();
    let command_template = format!("{} hooks run <event> --host {}", am_path, host.id());
    let (path, changed) = match host {
        HookHost::Codex => uninstall_codex(dry_run)?,
        HookHost::ClaudeCode => uninstall_claude_code(dry_run)?,
    };
    Ok(HooksInstallReport {
        host: host.id().into(),
        path: path.display().to_string(),
        changed,
        dry_run,
        command_template,
    })
}

pub fn codex_config_path() -> Result<PathBuf> {
    Ok(home_dir()?.join(".codex/config.toml"))
}

pub fn claude_settings_path() -> Result<PathBuf> {
    Ok(home_dir()?.join(".claude/settings.json"))
}

// `changed` is the STRUCTURAL result from the merge/remove helpers, never a
// text diff of the reserialized document. Comparing reserialized text made a
// no-op uninstall report `changed: true` and rewrite (reformatting) a user's
// settings file that contained no hooks of ours at all.
fn install_codex(am_path: &str, host: HookHost, dry_run: bool) -> Result<(PathBuf, bool)> {
    let path = codex_config_path()?;
    let mut doc = read_codex_document(&path)?;
    let changed = merge_codex_hooks(&mut doc, am_path, host)?;
    apply_text_change(&path, &doc.to_string(), changed, dry_run)?;
    Ok((path, changed))
}

fn uninstall_codex(dry_run: bool) -> Result<(PathBuf, bool)> {
    let path = codex_config_path()?;
    if !path.exists() {
        return Ok((path, false));
    }
    let mut doc = read_codex_document(&path)?;
    let changed = remove_codex_hooks(&mut doc)?;
    apply_text_change(&path, &doc.to_string(), changed, dry_run)?;
    Ok((path, changed))
}

fn install_claude_code(am_path: &str, host: HookHost, dry_run: bool) -> Result<(PathBuf, bool)> {
    let path = claude_settings_path()?;
    let mut root = if path.exists() {
        read_json_file(&path)?
    } else {
        Value::Object(serde_json::Map::new())
    };
    let changed = merge_claude_hooks(&mut root, am_path, host)?;
    let after = serde_json::to_string_pretty(&root)?;
    apply_text_change(&path, &after, changed, dry_run)?;
    Ok((path, changed))
}

fn uninstall_claude_code(dry_run: bool) -> Result<(PathBuf, bool)> {
    let path = claude_settings_path()?;
    if !path.exists() {
        return Ok((path, false));
    }
    let mut root = read_json_file(&path)?;
    let changed = remove_claude_hooks(&mut root)?;
    let after = serde_json::to_string_pretty(&root)?;
    apply_text_change(&path, &after, changed, dry_run)?;
    Ok((path, changed))
}

fn ensure_parent(path: &std::path::Path) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    Ok(())
}

fn apply_text_change(
    path: &std::path::Path,
    after: &str,
    content_changed: bool,
    dry_run: bool,
) -> Result<()> {
    if content_changed && !dry_run {
        // Create the host config directory only when a write actually
        // happens: `--dry-run` must not touch the filesystem, and it used to
        // create ~/.codex / ~/.claude before deciding not to write.
        ensure_parent(path)?;
        let _backup = backup_host_config(path)?;
        if path.extension().and_then(|s| s.to_str()) == Some("toml") {
            let doc = after
                .parse::<DocumentMut>()
                .context("serialize codex config")?;
            write_codex_text(path, &doc)?;
        } else {
            write_secure_file(path, after)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_target(name: &str) -> PathBuf {
        let mut dir = std::env::temp_dir();
        dir.push(format!(
            "am-hooks-install-test-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        dir.join("settings.json")
    }

    #[test]
    fn dry_run_does_not_create_the_host_config_directory() {
        // `ensure_parent` used to run before the dry-run guard, so
        // `am hooks install --dry-run` created ~/.codex / ~/.claude.
        let path = temp_target("dry-run");
        let parent = path.parent().expect("parent").to_path_buf();
        apply_text_change(&path, "{}", true, true).expect("dry run");
        assert!(
            !parent.exists(),
            "--dry-run must not touch the filesystem, created {}",
            parent.display()
        );
    }

    #[test]
    fn unchanged_config_is_never_rewritten() {
        // A no-op uninstall used to reformat (and report changed) a file that
        // held no hooks of ours, because the decision came from comparing
        // reserialized text rather than the structural result.
        let path = temp_target("noop");
        let parent = path.parent().expect("parent").to_path_buf();
        apply_text_change(&path, "{}", false, false).expect("no-op");
        assert!(!parent.exists(), "no-op must not create or write anything");
        let _ = fs::remove_dir_all(&parent);
    }

    #[test]
    fn live_run_creates_the_directory_and_writes() {
        let path = temp_target("live");
        let parent = path.parent().expect("parent").to_path_buf();
        apply_text_change(&path, "{\"hooks\":{}}", true, false).expect("write");
        assert!(path.exists(), "expected {} to be written", path.display());
        let _ = fs::remove_dir_all(&parent);
    }
}
