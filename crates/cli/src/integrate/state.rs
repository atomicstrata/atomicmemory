//! Persist integration install records in `config.toml` (path-keyed ownership).

use chrono::Utc;

use anyhow::{Result, bail};
use serde::Serialize;

use crate::config::{ConfigFile, ConfigStore, IntegrationRecord};
use crate::integrate::codex_edit::{current_codex_entry, read_codex_document};
use crate::integrate::fingerprint::{fingerprint_json, fingerprint_toml};
use crate::integrate::host::{Host, HostConfigPaths, InstallScope};
use crate::integrate::path_util::canonical_path;
use crate::integrate::write::{
    current_json_entry, ensure_no_opencode_sibling_entry, ensure_single_opencode_entry,
    read_host_json_file,
};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct StaleRecordCleanup {
    pub had_stale_record: bool,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct OwnedInstallStatus {
    pub host: Host,
    pub config_path: String,
    pub owned: bool,
    pub fingerprint_match: bool,
    pub profile: Option<String>,
}

pub fn record_key(config_path: &Path) -> Result<String> {
    Ok(canonical_path(config_path)?.display().to_string())
}

pub(crate) fn load_record_in(
    store: &ConfigStore,
    config_path: &Path,
) -> Result<Option<IntegrationRecord>> {
    let key = record_key(config_path)?;
    let cfg = store.load()?;
    Ok(cfg.integrations.get(&key).cloned())
}

pub fn load_record(config_path: &Path) -> Result<Option<IntegrationRecord>> {
    load_record_in(&ConfigStore::production()?, config_path)
}

fn matching_record_in(
    cfg: &ConfigFile,
    config_path: &Path,
    host: Host,
    scope: InstallScope,
) -> Result<Option<IntegrationRecord>> {
    let key = record_key(config_path)?;
    if let Some(record) = cfg.integrations.get(&key) {
        return Ok(Some(record.clone()));
    }
    if host != Host::OpenCode {
        return Ok(None);
    }
    let mut relocated = cfg.integrations.values().filter(|record| {
        let recorded_path = Path::new(&record.config_path);
        record.host == host.id()
            && record.scope == scope.id()
            && recorded_path.parent() == config_path.parent()
            && !recorded_path.exists()
    });
    let record = relocated.next().cloned();
    if relocated.next().is_some() {
        bail!("multiple stale OpenCode ownership records found");
    }
    Ok(record)
}

pub fn load_record_for_host(
    config_path: &Path,
    host: Host,
    scope: InstallScope,
) -> Result<Option<IntegrationRecord>> {
    let cfg = ConfigStore::production()?.load()?;
    matching_record_in(&cfg, config_path, host, scope)
}

pub(crate) fn record_install_in(
    store: &ConfigStore,
    host: Host,
    scope: InstallScope,
    config_path: &Path,
    profile: &str,
    entry_fingerprint: &str,
    prior_entry: Option<String>,
) -> Result<()> {
    let key = record_key(config_path)?;
    let record = IntegrationRecord {
        host: host.id().to_string(),
        scope: scope.id().to_string(),
        config_path: key.clone(),
        profile: profile.to_string(),
        installed_at: Utc::now().to_rfc3339(),
        entry_fingerprint: entry_fingerprint.to_string(),
        prior_entry,
    };
    store.update(|cfg| {
        if host == Host::OpenCode {
            cfg.integrations
                .retain(|_, existing| existing.host != host.id() || existing.scope != scope.id());
        }
        cfg.integrations.insert(key, record);
        Ok(())
    })
}

pub fn record_install(
    host: Host,
    scope: InstallScope,
    config_path: &Path,
    profile: &str,
    entry_fingerprint: &str,
    prior_entry: Option<String>,
) -> Result<()> {
    record_install_in(
        &ConfigStore::production()?,
        host,
        scope,
        config_path,
        profile,
        entry_fingerprint,
        prior_entry,
    )
}

pub(crate) fn clear_install_in(store: &ConfigStore, config_path: &Path) -> Result<()> {
    let key = record_key(config_path)?;
    store.update(|cfg| {
        cfg.integrations.remove(&key);
        Ok(())
    })
}

pub fn clear_install(config_path: &Path) -> Result<()> {
    clear_install_in(&ConfigStore::production()?, config_path)
}

pub fn clear_install_for_host(config_path: &Path, host: Host, scope: InstallScope) -> Result<()> {
    let key = record_key(config_path)?;
    ConfigStore::production()?.update(|cfg| {
        cfg.integrations.retain(|record_key, record| {
            if record_key == &key {
                return false;
            }
            if host != Host::OpenCode {
                return true;
            }
            let recorded_path = Path::new(&record.config_path);
            !(record.host == host.id()
                && record.scope == scope.id()
                && recorded_path.parent() == config_path.parent()
                && !recorded_path.exists())
        });
        Ok(())
    })
}

pub(crate) fn clear_stale_record_if_needed_in(
    store: &ConfigStore,
    config_path: &Path,
    dry_run: bool,
) -> Result<StaleRecordCleanup> {
    if load_record_in(store, config_path)?.is_none() {
        return Ok(StaleRecordCleanup {
            had_stale_record: false,
            detail: None,
        });
    }
    if dry_run {
        return Ok(StaleRecordCleanup {
            had_stale_record: true,
            detail: Some("would clear stale ownership record".into()),
        });
    }
    clear_install_in(store, config_path)?;
    Ok(StaleRecordCleanup {
        had_stale_record: true,
        detail: Some("cleared stale ownership record".into()),
    })
}

pub fn clear_stale_record_if_needed(
    config_path: &Path,
    dry_run: bool,
) -> Result<StaleRecordCleanup> {
    clear_stale_record_if_needed_in(&ConfigStore::production()?, config_path, dry_run)
}

/// Resolve a host config path, retaining the OpenCode file recorded at install time.
pub fn managed_config_path(
    config_paths: &HostConfigPaths,
    host: Host,
    scope: InstallScope,
    cwd: &Path,
) -> Result<PathBuf> {
    let cfg = ConfigStore::production()?.load()?;
    managed_config_path_in(config_paths, host, scope, cwd, &cfg)
}

fn managed_config_path_in(
    config_paths: &HostConfigPaths,
    host: Host,
    scope: InstallScope,
    cwd: &Path,
    cfg: &ConfigFile,
) -> Result<PathBuf> {
    let default_path = config_paths.config_path(host, scope, cwd)?;
    if host != Host::OpenCode {
        return Ok(default_path);
    }
    let candidates = config_paths.opencode_global_config_paths();
    let mut owned_paths = cfg
        .integrations
        .values()
        .filter(|record| record.host == host.id() && record.scope == scope.id())
        .map(|record| PathBuf::from(&record.config_path))
        .filter(|path| candidates.contains(path) && path.exists());
    let Some(path) = owned_paths.next() else {
        return Ok(default_path);
    };
    if owned_paths.next().is_some() {
        bail!("multiple owned OpenCode config paths found — remove the stale ownership record");
    }
    Ok(path)
}

/// Resolve a host path and reject an OpenCode sibling that defines the same server.
pub fn validated_config_path(
    config_paths: &HostConfigPaths,
    host: Host,
    scope: InstallScope,
    cwd: &Path,
) -> Result<PathBuf> {
    let path = managed_config_path(config_paths, host, scope, cwd)?;
    if host == Host::OpenCode {
        ensure_no_opencode_sibling_entry(config_paths, &path)?;
    }
    Ok(path)
}

pub fn list_owned_status(
    hosts: &[Host],
    config_paths: &HostConfigPaths,
) -> Result<Vec<OwnedInstallStatus>> {
    let cfg = ConfigStore::production()?.load()?;
    let mut out = Vec::new();
    for host in hosts {
        let path = match managed_config_path_in(
            config_paths,
            *host,
            InstallScope::Global,
            Path::new("."),
            &cfg,
        ) {
            Ok(path) => path,
            Err(_) => {
                let path = config_paths.config_path(*host, InstallScope::Global, Path::new("."))?;
                let record = cfg.integrations.values().find(|record| {
                    record.host == host.id() && record.scope == InstallScope::Global.id()
                });
                out.push(OwnedInstallStatus {
                    host: *host,
                    config_path: record_key(&path)?,
                    owned: record.is_some(),
                    fingerprint_match: false,
                    profile: record.map(|record| record.profile.clone()),
                });
                continue;
            }
        };
        let key = record_key(&path)?;
        let record = matching_record_in(&cfg, &path, *host, InstallScope::Global)?;
        let fingerprint_match = match (record.as_ref(), host) {
            (Some(record), Host::Cursor | Host::ClaudeCode | Host::OpenCode) => {
                let sibling_safe = *host != Host::OpenCode
                    || ensure_no_opencode_sibling_entry(config_paths, &path).is_ok();
                let target_unambiguous =
                    *host != Host::OpenCode || ensure_single_opencode_entry(&path).is_ok();
                sibling_safe
                    && target_unambiguous
                    && read_host_json_file(&path, *host)
                        .ok()
                        .and_then(|doc| current_json_entry(&doc, *host))
                        .and_then(|entry| fingerprint_json_entry(&entry).ok())
                        .is_some_and(|fp| fp == record.entry_fingerprint)
            }
            (Some(record), Host::Codex) => read_codex_document(&path)
                .ok()
                .and_then(|doc| current_codex_entry(&doc))
                .and_then(|entry| fingerprint_toml_entry(&entry).ok())
                .is_some_and(|fp| fp == record.entry_fingerprint),
            _ => false,
        };
        out.push(OwnedInstallStatus {
            host: *host,
            config_path: key,
            owned: record.is_some(),
            fingerprint_match,
            profile: record.map(|r| r.profile),
        });
    }
    Ok(out)
}

pub fn assert_install_allowed(
    host: Host,
    scope: InstallScope,
    config_path: &Path,
    current_fingerprint: Option<&str>,
    force: bool,
) -> Result<Option<String>> {
    let record = load_record_for_host(config_path, host, scope)?;
    let Some(current) = current_fingerprint else {
        return Ok(None);
    };
    if let Some(record) = &record {
        if record.entry_fingerprint == current {
            return Ok(record.prior_entry.clone());
        }
        if !force {
            bail!(
                "existing `{MCP}` entry is owned by a prior install with a different fingerprint — pass --force to overwrite",
                MCP = crate::integrate::host::MCP_SERVER_NAME
            );
        }
        return Ok(record.prior_entry.clone());
    }
    if !force {
        bail!(
            "existing `{MCP}` entry was not installed by `am integrate` — pass --force to overwrite",
            MCP = crate::integrate::host::MCP_SERVER_NAME
        );
    }
    Ok(None)
}

pub fn assert_uninstall_allowed(
    host: Host,
    scope: InstallScope,
    config_path: &Path,
    current_fingerprint: Option<&str>,
    force: bool,
) -> Result<Option<String>> {
    let record = load_record_for_host(config_path, host, scope)?;
    let Some(record) = record else {
        if force {
            return Ok(None);
        }
        bail!(
            "no owned `{MCP}` install record for this path — pass --force to remove anyway",
            MCP = crate::integrate::host::MCP_SERVER_NAME
        );
    };
    let Some(current) = current_fingerprint else {
        bail!(
            "no `{MCP}` entry present",
            MCP = crate::integrate::host::MCP_SERVER_NAME
        );
    };
    if record.entry_fingerprint != current {
        if force {
            return Ok(None);
        }
        bail!(
            "installed `{MCP}` entry drifted from owned fingerprint — pass --force to delete without restore",
            MCP = crate::integrate::host::MCP_SERVER_NAME
        );
    }
    Ok(record.prior_entry.clone())
}

pub fn fingerprint_json_entry(entry: &serde_json::Value) -> Result<String> {
    fingerprint_json(entry)
}

pub fn fingerprint_toml_entry(entry: &toml::Value) -> Result<String> {
    fingerprint_toml(entry)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn test_store() -> (tempfile::TempDir, ConfigStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = ConfigStore::at(dir.path().join("config.toml"));
        (dir, store)
    }

    #[test]
    fn record_key_uses_canonical_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mcp.json");
        let key = record_key(&path).unwrap();
        assert!(key.ends_with("mcp.json"));
    }

    #[test]
    fn install_refuses_unowned_without_force() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mcp.json");
        let err = assert_install_allowed(
            Host::Cursor,
            InstallScope::Global,
            &path,
            Some("deadbeef"),
            false,
        )
        .unwrap_err();
        assert!(err.to_string().contains("not installed by `am integrate`"));
    }

    #[test]
    fn uninstall_refuses_drift_without_force() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mcp.json");
        let err = assert_uninstall_allowed(
            Host::Cursor,
            InstallScope::Global,
            &path,
            Some("deadbeef"),
            false,
        )
        .unwrap_err();
        assert!(err.to_string().contains("no owned"));
    }

    #[test]
    fn dry_run_preserves_config_bytes_for_stale_record() {
        let (_dir, store) = test_store();
        let host_path = _dir.path().join("mcp.json");
        record_install_in(
            &store,
            Host::Cursor,
            InstallScope::Global,
            &host_path,
            "local",
            "abc123",
            None,
        )
        .unwrap();
        let before = fs::read(store.path()).unwrap();
        let cleanup = clear_stale_record_if_needed_in(&store, &host_path, true).unwrap();
        assert!(cleanup.had_stale_record);
        assert_eq!(
            cleanup.detail.as_deref(),
            Some("would clear stale ownership record")
        );
        let after = fs::read(store.path()).unwrap();
        assert_eq!(before, after);
    }

    #[test]
    fn live_run_clears_stale_record_and_reports_change() {
        let (_dir, store) = test_store();
        let host_path = _dir.path().join("mcp.json");
        record_install_in(
            &store,
            Host::Cursor,
            InstallScope::Global,
            &host_path,
            "local",
            "abc123",
            None,
        )
        .unwrap();
        let cleanup = clear_stale_record_if_needed_in(&store, &host_path, false).unwrap();
        assert!(cleanup.had_stale_record);
        assert_eq!(
            cleanup.detail.as_deref(),
            Some("cleared stale ownership record")
        );
        assert!(load_record_in(&store, &host_path).unwrap().is_none());
    }
}
