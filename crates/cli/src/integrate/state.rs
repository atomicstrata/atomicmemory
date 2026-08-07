//! Persist integration install records in `config.toml` (path-keyed ownership).

use chrono::Utc;

use anyhow::{Result, bail};
use serde::Serialize;

use crate::config::{ConfigStore, IntegrationRecord};
use crate::integrate::codex_edit::{current_codex_entry, read_codex_document};
use crate::integrate::fingerprint::{fingerprint_json, fingerprint_toml};
use crate::integrate::host::{Host, InstallScope};
use crate::integrate::path_util::canonical_path;
use crate::integrate::write::{current_json_entry, read_json_file};
use std::path::Path;

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

pub fn list_owned_status(hosts: &[Host]) -> Result<Vec<OwnedInstallStatus>> {
    let cfg = ConfigStore::production()?.load()?;
    let mut out = Vec::new();
    for host in hosts {
        let path = host.config_path(InstallScope::Global, Path::new("."))?;
        let key = record_key(&path)?;
        let record = cfg.integrations.get(&key);
        let fingerprint_match = match (record, host) {
            (Some(record), Host::Cursor | Host::ClaudeCode) => read_json_file(&path)
                .ok()
                .and_then(|doc| current_json_entry(&doc))
                .and_then(|entry| fingerprint_json_entry(&entry).ok())
                .is_some_and(|fp| fp == record.entry_fingerprint),
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
            profile: record.map(|r| r.profile.clone()),
        });
    }
    Ok(out)
}

pub fn assert_install_allowed(
    config_path: &Path,
    current_fingerprint: Option<&str>,
    force: bool,
) -> Result<Option<String>> {
    let record = load_record(config_path)?;
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
    config_path: &Path,
    current_fingerprint: Option<&str>,
    force: bool,
) -> Result<Option<String>> {
    let record = load_record(config_path)?;
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
        let err = assert_install_allowed(&path, Some("deadbeef"), false).unwrap_err();
        assert!(err.to_string().contains("not installed by `am integrate`"));
    }

    #[test]
    fn uninstall_refuses_drift_without_force() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mcp.json");
        let err = assert_uninstall_allowed(&path, Some("deadbeef"), false).unwrap_err();
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
