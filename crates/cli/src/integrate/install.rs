//! Install, update, and uninstall host MCP configuration files.

use std::env;
use std::path::Path;

use anyhow::{Context, Result, bail};
use serde::Serialize;
use serde_json::Value;

use crate::integrate::codex_edit::{
    merge_codex_mcp, read_codex_document, remove_or_restore_codex_mcp, serialize_codex_entry,
    write_codex_document,
};
use crate::integrate::host::{Host, InstallScope};
use crate::integrate::spec::{
    IntegrateCredentials, codex_mcp_table, json_mcp_server, preflight_install_runtime,
};
use crate::integrate::state::{
    assert_install_allowed, assert_uninstall_allowed, clear_install, clear_stale_record_if_needed,
    fingerprint_json_entry, fingerprint_toml_entry, record_install,
};
use crate::integrate::write::{
    backup_host_config, current_json_entry, merge_json_mcp, read_json_file,
    remove_or_restore_json_mcp, restore_host_config, write_secure_file,
};

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InstallAction {
    Install,
    Update,
    Uninstall,
}

#[derive(Debug, Clone, Serialize)]
pub struct HostInstallResult {
    pub host: Host,
    pub scope: InstallScope,
    pub path: String,
    pub action: InstallAction,
    pub changed: bool,
    pub dry_run: bool,
    pub backup: Option<String>,
    pub detail: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct InstallReport {
    pub results: Vec<HostInstallResult>,
    pub partial_failure: bool,
}

pub struct InstallOptions<'a> {
    pub hosts: &'a [Host],
    pub scope: InstallScope,
    pub cwd: &'a Path,
    pub creds: &'a IntegrateCredentials,
    pub force: bool,
    pub dry_run: bool,
    pub action: InstallAction,
}

pub fn install_hosts(opts: &InstallOptions<'_>) -> Result<InstallReport> {
    preflight_install_runtime()?;
    let mut results = Vec::new();
    let mut partial_failure = false;
    for host in opts.hosts {
        match plan_host(*host, opts) {
            Ok(plan) => match execute_plan(plan, opts) {
                Ok(row) => {
                    if row.error.is_some() {
                        partial_failure = true;
                    }
                    results.push(row);
                }
                Err(err) => {
                    partial_failure = true;
                    let path = host.config_path(opts.scope, opts.cwd);
                    results.push(HostInstallResult {
                        host: *host,
                        scope: opts.scope,
                        path: path.map(|p| p.display().to_string()).unwrap_or_default(),
                        action: opts.action,
                        changed: false,
                        dry_run: opts.dry_run,
                        backup: None,
                        detail: None,
                        error: Some(err.to_string()),
                    });
                }
            },
            Err(err) => {
                partial_failure = true;
                results.push(HostInstallResult {
                    host: *host,
                    scope: opts.scope,
                    path: host
                        .config_path(opts.scope, opts.cwd)
                        .map(|p| p.display().to_string())
                        .unwrap_or_default(),
                    action: opts.action,
                    changed: false,
                    dry_run: opts.dry_run,
                    backup: None,
                    detail: None,
                    error: Some(err.to_string()),
                });
            }
        }
    }
    if partial_failure {
        return Ok(InstallReport {
            results,
            partial_failure: true,
        });
    }
    Ok(InstallReport {
        results,
        partial_failure: false,
    })
}

struct HostPlan {
    host: Host,
    path: std::path::PathBuf,
    changed: bool,
    adopt_only: bool,
    merged_json: Option<Value>,
    codex_doc: Option<toml_edit::DocumentMut>,
    new_fingerprint: String,
    prior_entry: Option<String>,
}

fn plan_host(host: Host, opts: &InstallOptions<'_>) -> Result<HostPlan> {
    let path = host.config_path(opts.scope, opts.cwd)?;
    match host {
        Host::Cursor | Host::ClaudeCode => plan_json_host(host, opts, &path),
        Host::Codex => plan_codex_host(host, opts, &path),
    }
}

fn plan_json_host(host: Host, opts: &InstallOptions<'_>, path: &Path) -> Result<HostPlan> {
    let existing = read_json_file(path)?;
    let current = current_json_entry(&existing);
    let current_fp = current.as_ref().map(fingerprint_json_entry).transpose()?;
    let owned = is_owned(path, current_fp.as_deref())?;
    assert_install_allowed(path, current_fp.as_deref(), opts.force)?;
    let entry = json_mcp_server(opts.creds, host);
    let effective_force = opts.force || owned;
    let (merged, changed) = merge_json_mcp(&existing, &entry, effective_force)?;
    let new_fp = fingerprint_json_entry(&entry)?;
    let adopt_only = !changed && opts.force && !owned && current.is_some();
    let prior_entry = if changed {
        if owned {
            crate::integrate::state::load_record(path)?.and_then(|r| r.prior_entry)
        } else {
            current.as_ref().and_then(|v| serde_json::to_string(v).ok())
        }
    } else if adopt_only {
        current.as_ref().and_then(|v| serde_json::to_string(v).ok())
    } else {
        None
    };
    Ok(HostPlan {
        host,
        path: path.to_path_buf(),
        changed,
        adopt_only,
        merged_json: Some(merged),
        codex_doc: None,
        new_fingerprint: new_fp,
        prior_entry,
    })
}

fn plan_codex_host(host: Host, opts: &InstallOptions<'_>, path: &Path) -> Result<HostPlan> {
    let mut doc = read_codex_document(path)?;
    let current = crate::integrate::codex_edit::current_codex_entry(&doc);
    let current_fp = current.as_ref().map(fingerprint_toml_entry).transpose()?;
    let owned = is_owned(path, current_fp.as_deref())?;
    assert_install_allowed(path, current_fp.as_deref(), opts.force)?;
    let entry = codex_mcp_table(opts.creds, host);
    let effective_force = opts.force || owned;
    let changed = merge_codex_mcp(&mut doc, entry.clone(), effective_force)?;
    let new_fp = fingerprint_toml_entry(&entry)?;
    let adopt_only = !changed && opts.force && !owned && current.is_some();
    let prior_entry = if changed {
        if owned {
            crate::integrate::state::load_record(path)?.and_then(|r| r.prior_entry)
        } else {
            current.as_ref().and_then(|v| serialize_codex_entry(v).ok())
        }
    } else if adopt_only {
        current.as_ref().and_then(|v| serialize_codex_entry(v).ok())
    } else {
        None
    };
    Ok(HostPlan {
        host,
        path: path.to_path_buf(),
        changed,
        adopt_only,
        merged_json: None,
        codex_doc: Some(doc),
        new_fingerprint: new_fp,
        prior_entry,
    })
}

fn execute_plan(plan: HostPlan, opts: &InstallOptions<'_>) -> Result<HostInstallResult> {
    if opts.dry_run {
        return Ok(result_row(
            plan.host,
            opts,
            &plan.path,
            plan.changed || plan.adopt_only,
            None,
            None,
            None,
        ));
    }
    if plan.adopt_only {
        if let Err(err) = record_install(
            plan.host,
            opts.scope,
            &plan.path,
            &opts.creds.profile_name,
            &plan.new_fingerprint,
            plan.prior_entry,
        ) {
            return Ok(result_row(
                plan.host,
                opts,
                &plan.path,
                false,
                None,
                None,
                Some(format!("ownership record failed: {err:#}")),
            ));
        }
        return Ok(result_row(
            plan.host,
            opts,
            &plan.path,
            false,
            None,
            Some("adopted ownership for existing entry".into()),
            None,
        ));
    }
    if !plan.changed {
        return Ok(result_row(
            plan.host,
            opts,
            &plan.path,
            false,
            None,
            Some("already up to date".into()),
            None,
        ));
    }
    let backup = backup_host_config(&plan.path)?;
    let backup_path = backup.as_deref();
    let write_result = (|| -> Result<()> {
        if let Some(merged) = &plan.merged_json {
            let rendered = serde_json::to_string_pretty(merged).context("serialize JSON")?;
            write_secure_file(&plan.path, &format!("{rendered}\n"))?;
        } else if let Some(doc) = &plan.codex_doc {
            write_codex_document(&plan.path, doc)?;
        }
        Ok(())
    })();
    if let Err(err) = write_result {
        return Ok(result_row(
            plan.host,
            opts,
            &plan.path,
            false,
            backup.map(|p| p.display().to_string()),
            None,
            Some(err.to_string()),
        ));
    }
    if let Err(err) = record_install(
        plan.host,
        opts.scope,
        &plan.path,
        &opts.creds.profile_name,
        &plan.new_fingerprint,
        plan.prior_entry,
    ) {
        if let Err(restore_err) = restore_host_config(&plan.path, backup_path) {
            return Ok(result_row(
                plan.host,
                opts,
                &plan.path,
                false,
                backup.map(|p| p.display().to_string()),
                None,
                Some(format!(
                    "ownership record failed: {err:#}; restore also failed: {restore_err:#}"
                )),
            ));
        }
        return Ok(result_row(
            plan.host,
            opts,
            &plan.path,
            false,
            backup.map(|p| p.display().to_string()),
            None,
            Some(format!("ownership record failed: {err:#}")),
        ));
    }
    Ok(result_row(
        plan.host,
        opts,
        &plan.path,
        true,
        backup.map(|p| p.display().to_string()),
        None,
        None,
    ))
}

pub fn uninstall_hosts(
    hosts: &[Host],
    scope: InstallScope,
    cwd: &Path,
    force: bool,
    dry_run: bool,
) -> Result<InstallReport> {
    let mut results = Vec::new();
    let mut partial_failure = false;
    for host in hosts {
        match uninstall_host(*host, scope, cwd, force, dry_run) {
            Ok(row) => {
                if row.error.is_some() {
                    partial_failure = true;
                }
                results.push(row);
            }
            Err(err) => {
                partial_failure = true;
                results.push(HostInstallResult {
                    host: *host,
                    scope,
                    path: String::new(),
                    action: InstallAction::Uninstall,
                    changed: false,
                    dry_run,
                    backup: None,
                    detail: None,
                    error: Some(err.to_string()),
                });
            }
        }
    }
    if partial_failure {
        return Ok(InstallReport {
            results,
            partial_failure: true,
        });
    }
    Ok(InstallReport {
        results,
        partial_failure: false,
    })
}

fn is_owned(path: &Path, current_fp: Option<&str>) -> Result<bool> {
    let Some(current_fp) = current_fp else {
        return Ok(false);
    };
    Ok(crate::integrate::state::load_record(path)?
        .is_some_and(|r| r.entry_fingerprint == current_fp))
}

fn merge_uninstall_detail(base: Option<String>, stale: Option<String>) -> Option<String> {
    match (base, stale) {
        (Some(base), Some(stale)) => Some(format!("{base}; {stale}")),
        (Some(base), None) => Some(base),
        (None, Some(stale)) => Some(stale),
        (None, None) => None,
    }
}

fn stale_uninstall_outcome(
    path: &Path,
    dry_run: bool,
    base_detail: Option<String>,
) -> Result<UninstallOutcome> {
    let cleanup = clear_stale_record_if_needed(path, dry_run)?;
    Ok(UninstallOutcome {
        changed: cleanup.had_stale_record,
        dry_run,
        backup: None,
        detail: merge_uninstall_detail(base_detail, cleanup.detail),
        error: None,
    })
}

fn uninstall_host(
    host: Host,
    scope: InstallScope,
    cwd: &Path,
    force: bool,
    dry_run: bool,
) -> Result<HostInstallResult> {
    let path = host.config_path(scope, cwd)?;
    if !path.exists() {
        return Ok(uninstall_row(
            host,
            scope,
            &path,
            stale_uninstall_outcome(&path, dry_run, Some("config file not found".into()))?,
        ));
    }
    match host {
        Host::Cursor | Host::ClaudeCode => uninstall_json_host(host, scope, &path, force, dry_run),
        Host::Codex => uninstall_codex_host(host, scope, &path, force, dry_run),
    }
}

fn uninstall_json_host(
    host: Host,
    scope: InstallScope,
    path: &Path,
    force: bool,
    dry_run: bool,
) -> Result<HostInstallResult> {
    let existing = read_json_file(path)?;
    let current = current_json_entry(&existing);
    let current_fp = current.as_ref().map(fingerprint_json_entry).transpose()?;
    if current.is_none() {
        return Ok(uninstall_row(
            host,
            scope,
            path,
            stale_uninstall_outcome(path, dry_run, None)?,
        ));
    }
    let restore = assert_uninstall_allowed(path, current_fp.as_deref(), force)?;
    if dry_run {
        return Ok(uninstall_row(
            host,
            scope,
            path,
            UninstallOutcome {
                changed: true,
                dry_run: true,
                backup: None,
                detail: None,
                error: None,
            },
        ));
    }
    let backup = backup_host_config(path)?;
    let backup_path = backup.as_deref();
    let (merged, removed) = remove_or_restore_json_mcp(&existing, restore.as_deref())?;
    if !removed {
        return Ok(uninstall_row(
            host,
            scope,
            path,
            UninstallOutcome {
                changed: false,
                dry_run: false,
                backup: backup.map(|p| p.display().to_string()),
                detail: None,
                error: None,
            },
        ));
    }
    let rendered = serde_json::to_string_pretty(&merged).context("serialize JSON")?;
    write_secure_file(path, &format!("{rendered}\n"))?;
    if let Err(err) = clear_install(path) {
        restore_host_config(path, backup_path)?;
        return Ok(uninstall_row(
            host,
            scope,
            path,
            UninstallOutcome {
                changed: false,
                dry_run: false,
                backup: backup.map(|p| p.display().to_string()),
                detail: None,
                error: Some(format!("ownership record failed: {err:#}")),
            },
        ));
    }
    Ok(uninstall_row(
        host,
        scope,
        path,
        UninstallOutcome {
            changed: true,
            dry_run: false,
            backup: backup.map(|p| p.display().to_string()),
            detail: None,
            error: None,
        },
    ))
}

fn uninstall_codex_host(
    host: Host,
    scope: InstallScope,
    path: &Path,
    force: bool,
    dry_run: bool,
) -> Result<HostInstallResult> {
    let mut doc = read_codex_document(path)?;
    let current = crate::integrate::codex_edit::current_codex_entry(&doc);
    let current_fp = current.as_ref().map(fingerprint_toml_entry).transpose()?;
    if current.is_none() {
        return Ok(uninstall_row(
            host,
            scope,
            path,
            stale_uninstall_outcome(path, dry_run, None)?,
        ));
    }
    let restore = assert_uninstall_allowed(path, current_fp.as_deref(), force)?;
    if dry_run {
        return Ok(uninstall_row(
            host,
            scope,
            path,
            UninstallOutcome {
                changed: true,
                dry_run: true,
                backup: None,
                detail: None,
                error: None,
            },
        ));
    }
    let backup = backup_host_config(path)?;
    let backup_path = backup.as_deref();
    let removed = remove_or_restore_codex_mcp(&mut doc, restore.as_deref())?;
    if !removed {
        return Ok(uninstall_row(
            host,
            scope,
            path,
            UninstallOutcome {
                changed: false,
                dry_run: false,
                backup: backup.map(|p| p.display().to_string()),
                detail: None,
                error: None,
            },
        ));
    }
    write_codex_document(path, &doc)?;
    if let Err(err) = clear_install(path) {
        restore_host_config(path, backup_path)?;
        return Ok(uninstall_row(
            host,
            scope,
            path,
            UninstallOutcome {
                changed: false,
                dry_run: false,
                backup: backup.map(|p| p.display().to_string()),
                detail: None,
                error: Some(format!("ownership record failed: {err:#}")),
            },
        ));
    }
    Ok(uninstall_row(
        host,
        scope,
        path,
        UninstallOutcome {
            changed: true,
            dry_run: false,
            backup: backup.map(|p| p.display().to_string()),
            detail: None,
            error: None,
        },
    ))
}

fn result_row(
    host: Host,
    opts: &InstallOptions<'_>,
    path: &Path,
    changed: bool,
    backup: Option<String>,
    detail: Option<String>,
    error: Option<String>,
) -> HostInstallResult {
    HostInstallResult {
        host,
        scope: opts.scope,
        path: path.display().to_string(),
        action: opts.action,
        changed,
        dry_run: opts.dry_run,
        backup,
        detail,
        error,
    }
}

struct UninstallOutcome {
    changed: bool,
    dry_run: bool,
    backup: Option<String>,
    detail: Option<String>,
    error: Option<String>,
}

fn uninstall_row(
    host: Host,
    scope: InstallScope,
    path: &Path,
    outcome: UninstallOutcome,
) -> HostInstallResult {
    HostInstallResult {
        host,
        scope,
        path: path.display().to_string(),
        action: InstallAction::Uninstall,
        changed: outcome.changed,
        dry_run: outcome.dry_run,
        backup: outcome.backup,
        detail: outcome.detail,
        error: outcome.error,
    }
}

pub fn default_cwd() -> Result<std::path::PathBuf> {
    env::current_dir().context("resolve current directory")
}

/// Interpret a host-selection `read_line` result.
///
/// `bytes_read == 0` is EOF (Ctrl-D / closed stdin) and must fail closed —
/// an empty line after a successful read still means "use detected hosts".
pub fn selection_from_read(
    bytes_read: usize,
    line: &str,
    all: &[Host],
    detected: &[Host],
) -> Result<Vec<Host>> {
    if bytes_read == 0 {
        bail!("host selection cancelled");
    }
    parse_host_selection(line.trim(), all, detected)
}

/// Parse comma- or whitespace-separated host indices from an interactive selection line.
pub fn parse_host_selection(trimmed: &str, all: &[Host], detected: &[Host]) -> Result<Vec<Host>> {
    if trimmed.is_empty() {
        if detected.is_empty() {
            bail!("no hosts selected");
        }
        return Ok(detected.to_vec());
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower == "q" || lower == "quit" || lower == "abort" {
        bail!("host selection cancelled");
    }
    let valid = format!("1-{}", all.len());
    let mut selected = Vec::new();
    for part in trimmed
        .split(|c: char| c == ',' || c.is_whitespace())
        .filter(|p| !p.is_empty())
    {
        let idx: usize = part
            .parse()
            .with_context(|| format!("invalid selection {part:?} — enter numbers {valid}"))?;
        let host = *all
            .get(idx.checked_sub(1).unwrap_or(usize::MAX))
            .with_context(|| format!("selection out of range: {idx} — enter numbers {valid}"))?;
        if !selected.contains(&host) {
            selected.push(host);
        }
    }
    if selected.is_empty() {
        bail!("no hosts selected");
    }
    Ok(selected)
}

pub fn select_hosts_interactive(
    detected: &[Host],
    all: &[Host],
    yes: bool,
    is_tty: bool,
) -> Result<Vec<Host>> {
    if !detected.is_empty() && yes {
        return Ok(detected.to_vec());
    }
    if !is_tty {
        bail!("non-interactive session requires --yes and/or explicit --host");
    }
    if yes && detected.is_empty() {
        bail!("no hosts detected — pass --host cursor|claude-code|codex");
    }
    if detected.is_empty() {
        eprintln!("No hosts auto-detected. Select hosts to configure:");
    } else {
        eprintln!("Select hosts to configure (detected hosts marked with *):");
    }
    for (idx, host) in all.iter().enumerate() {
        let mark = if detected.contains(host) { '*' } else { ' ' };
        eprintln!("  {}. [{mark}] {}", idx + 1, host.display_name());
    }
    eprint!("Enter numbers (comma- or space-separated, empty = detected, q = cancel): ");
    std::io::Write::flush(&mut std::io::stderr())?;
    let mut line = String::new();
    let bytes_read = std::io::stdin().read_line(&mut line)?;
    selection_from_read(bytes_read, &line, all, detected)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::ProfileKind;
    use crate::integrate::all_hosts;
    use crate::integrate::spec::json_mcp_server;
    use serde_json::json;

    #[test]
    fn parse_host_selection_empty_uses_detected() {
        let all = all_hosts().to_vec();
        let detected = vec![Host::Cursor, Host::Codex];
        let got = parse_host_selection("", &all, &detected).unwrap();
        assert_eq!(got, detected);
    }

    #[test]
    fn selection_from_read_eof_cancels_instead_of_defaults() {
        let all = all_hosts().to_vec();
        let detected = vec![Host::Cursor];
        let err = selection_from_read(0, "", &all, &detected).unwrap_err();
        assert!(err.to_string().contains("cancelled"));
        let got = selection_from_read(1, "\n", &all, &detected).unwrap();
        assert_eq!(got, detected);
    }

    #[test]
    fn parse_host_selection_comma_and_space() {
        let all = all_hosts().to_vec();
        let detected = vec![Host::Cursor];
        assert_eq!(
            parse_host_selection("1,3", &all, &detected).unwrap(),
            vec![Host::Cursor, Host::Codex]
        );
        assert_eq!(
            parse_host_selection("1 2", &all, &detected).unwrap(),
            vec![Host::Cursor, Host::ClaudeCode]
        );
    }

    #[test]
    fn parse_host_selection_cancel_and_invalid() {
        let all = all_hosts().to_vec();
        let detected = vec![Host::Cursor];
        assert!(
            parse_host_selection("q", &all, &detected)
                .unwrap_err()
                .to_string()
                .contains("cancelled")
        );
        assert!(
            parse_host_selection("1111223311111", &all, &detected)
                .unwrap_err()
                .to_string()
                .contains("out of range")
        );
        assert!(
            parse_host_selection("foo", &all, &detected)
                .unwrap_err()
                .to_string()
                .contains("invalid selection")
        );
    }

    #[test]
    fn parse_host_selection_zero_is_out_of_range() {
        // Locks in the off-by-one fix: pre-fix `saturating_sub(1)` would silently
        // resolve "0" to host #1; post-fix must surface out-of-range.
        let all = all_hosts().to_vec();
        let detected = vec![Host::Cursor];
        let err = parse_host_selection("0", &all, &detected).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("out of range"), "unexpected error: {msg}");
        // Range hint uses a plain hyphen, not a U+2013 en dash.
        let expected_range = format!("1-{}", all.len());
        assert!(
            msg.contains(&expected_range),
            "expected range hint {expected_range:?} in {msg:?}"
        );
        assert!(
            !msg.contains('\u{2013}'),
            "range separator must be a plain hyphen, not U+2013: {msg:?}"
        );
    }

    #[test]
    fn parse_host_selection_dedups_repeated_indices() {
        let all = all_hosts().to_vec();
        let detected = vec![Host::Cursor];
        assert_eq!(
            parse_host_selection("1,1", &all, &detected).unwrap(),
            vec![Host::Cursor]
        );
        assert_eq!(
            parse_host_selection("2 2 1", &all, &detected).unwrap(),
            vec![Host::ClaudeCode, Host::Cursor]
        );
    }

    #[test]
    fn parse_host_selection_cancel_tokens_are_case_insensitive() {
        let all = all_hosts().to_vec();
        let detected = vec![Host::Cursor];
        for token in ["Q", "Quit", "QUIT", "Abort", "ABORT"] {
            let err = parse_host_selection(token, &all, &detected).unwrap_err();
            assert!(
                err.to_string().contains("cancelled"),
                "expected cancel for {token:?}"
            );
        }
    }

    #[test]
    fn identical_entry_is_noop() {
        let creds = IntegrateCredentials {
            api_url: "http://127.0.0.1:17350".into(),
            api_key: "k".into(),
            scope_user: "u".into(),
            scope_namespace: None,
            profile_name: "local".into(),
            profile_kind: ProfileKind::Local,
        };
        let entry = json_mcp_server(&creds, Host::Cursor);
        let existing = json!({ "mcpServers": { "atomicmemory": entry.clone() } });
        let (_, changed) = merge_json_mcp(&existing, &entry, false).unwrap();
        assert!(!changed);
    }

    #[test]
    fn restore_prior_entry_on_uninstall() {
        let prior = json!({ "command": "legacy" });
        let existing = json!({ "mcpServers": { "atomicmemory": { "command": "npx" } } });
        let (merged, changed) =
            remove_or_restore_json_mcp(&existing, Some(&prior.to_string())).unwrap();
        assert!(changed);
        assert_eq!(merged["mcpServers"]["atomicmemory"], prior);
    }

    #[test]
    fn adopt_only_captures_existing_entry_for_restore() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mcp.json");
        let creds = IntegrateCredentials {
            api_url: "http://127.0.0.1:17350".into(),
            api_key: "k".into(),
            scope_user: "u".into(),
            scope_namespace: None,
            profile_name: "local".into(),
            profile_kind: ProfileKind::Local,
        };
        let entry = json_mcp_server(&creds, Host::Cursor);
        let existing = json!({ "mcpServers": { "atomicmemory": entry.clone() } });
        std::fs::write(&path, serde_json::to_string_pretty(&existing).unwrap()).unwrap();

        let hosts = [Host::Cursor];
        let opts = InstallOptions {
            hosts: &hosts,
            scope: InstallScope::Global,
            cwd: dir.path(),
            creds: &creds,
            force: true,
            dry_run: false,
            action: InstallAction::Install,
        };
        let plan = plan_json_host(Host::Cursor, &opts, &path).unwrap();

        assert!(plan.adopt_only);
        assert!(!plan.changed);
        let prior = plan.prior_entry.expect("prior entry captured");
        assert_eq!(serde_json::from_str::<Value>(&prior).unwrap(), entry);
    }
}
