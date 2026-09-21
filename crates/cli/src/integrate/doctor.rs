//! Validate installed host MCP entries against the active profile.

use std::path::Path;

use anyhow::Result;
use serde::Serialize;

use crate::integrate::codex_edit::{current_codex_entry, read_codex_document};
use crate::integrate::fingerprint::{fingerprint_json, fingerprint_toml};
use crate::integrate::host::{Host, HostConfigPaths, InstallScope};
use crate::integrate::path_util::binary_on_path;
use crate::integrate::spec::{IntegrateCredentials, codex_mcp_table, json_mcp_server};
use crate::integrate::state::{load_record_for_host, managed_config_path, validated_config_path};
use crate::integrate::write::{
    current_json_entry, ensure_single_opencode_entry, read_host_json_file,
};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DoctorStatus {
    Ok,
    Missing,
    Drift,
    Unowned,
    Unreadable,
    Runtime,
}

#[derive(Debug, Clone, Serialize)]
pub struct HostDoctorEntry {
    pub host: Host,
    pub scope: InstallScope,
    pub path: String,
    pub status: DoctorStatus,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DoctorReport {
    pub entries: Vec<HostDoctorEntry>,
}

pub fn doctor_hosts(
    hosts: &[Host],
    scope: InstallScope,
    cwd: &Path,
    config_paths: &HostConfigPaths,
    creds: Option<&IntegrateCredentials>,
) -> DoctorReport {
    let mut entries = Vec::new();
    for &host in hosts {
        match doctor_one(host, scope, cwd, config_paths, creds) {
            Ok(Some(entry)) => entries.push(entry),
            Ok(None) => {}
            Err(err) => entries.push(failed_doctor_entry(host, scope, cwd, config_paths, err)),
        }
    }
    DoctorReport { entries }
}

fn failed_doctor_entry(
    host: Host,
    scope: InstallScope,
    cwd: &Path,
    config_paths: &HostConfigPaths,
    err: anyhow::Error,
) -> HostDoctorEntry {
    let path = managed_config_path(config_paths, host, scope, cwd)
        .map(|p| p.display().to_string())
        .unwrap_or_default();
    HostDoctorEntry {
        host,
        scope,
        path,
        status: DoctorStatus::Unreadable,
        detail: Some(err.to_string()),
    }
}

fn doctor_one(
    host: Host,
    scope: InstallScope,
    cwd: &Path,
    config_paths: &HostConfigPaths,
    creds: Option<&IntegrateCredentials>,
) -> Result<Option<HostDoctorEntry>> {
    let path = validated_config_path(config_paths, host, scope, cwd)?;
    let path_str = path.display().to_string();
    if host == Host::OpenCode {
        ensure_single_opencode_entry(&path)?;
    }
    if !binary_on_path("npx") {
        return Ok(Some(HostDoctorEntry {
            host,
            scope,
            path: path_str,
            status: DoctorStatus::Runtime,
            detail: Some("npx not found on PATH".into()),
        }));
    }
    if !path.exists() {
        return Ok(Some(HostDoctorEntry {
            host,
            scope,
            path: path_str,
            status: DoctorStatus::Missing,
            detail: Some("config file not found".into()),
        }));
    }

    match host {
        Host::Cursor | Host::ClaudeCode | Host::OpenCode => {
            let existing = read_host_json_file(&path, host);
            match existing {
                Ok(doc) => Ok(Some(compare_json(host, scope, &path_str, &doc, creds)?)),
                Err(err) => Ok(Some(HostDoctorEntry {
                    host,
                    scope,
                    path: path_str,
                    status: DoctorStatus::Unreadable,
                    detail: Some(err.to_string()),
                })),
            }
        }
        Host::Codex => match read_codex_document(&path) {
            Ok(doc) => Ok(Some(compare_codex(host, scope, &path_str, &doc, creds)?)),
            Err(err) => Ok(Some(HostDoctorEntry {
                host,
                scope,
                path: path_str,
                status: DoctorStatus::Unreadable,
                detail: Some(err.to_string()),
            })),
        },
    }
}

fn compare_json(
    host: Host,
    scope: InstallScope,
    path: &str,
    existing: &serde_json::Value,
    creds: Option<&IntegrateCredentials>,
) -> Result<HostDoctorEntry> {
    let expected = creds.map(|c| json_mcp_server(c, host));
    let current = current_json_entry(existing, host);
    let (status, detail) = match current {
        None => (
            DoctorStatus::Missing,
            Some("no atomicmemory server entry".into()),
        ),
        Some(entry) => diagnose_entry(
            host,
            scope,
            path,
            &entry,
            expected.as_ref(),
            fingerprint_json(&entry)?,
            creds.map(|c| c.profile_name.as_str()),
        )?,
    };
    Ok(HostDoctorEntry {
        host,
        scope,
        path: path.to_string(),
        status,
        detail,
    })
}

fn compare_codex(
    host: Host,
    scope: InstallScope,
    path: &str,
    doc: &toml_edit::DocumentMut,
    creds: Option<&IntegrateCredentials>,
) -> Result<HostDoctorEntry> {
    let expected_json =
        creds.map(|c| serde_json::to_value(codex_mcp_table(c, host)).unwrap_or_default());
    let current = current_codex_entry(doc);
    let (status, detail) = match current {
        None => (
            DoctorStatus::Missing,
            Some("no atomicmemory server entry".into()),
        ),
        Some(entry) => diagnose_entry(
            host,
            scope,
            path,
            &serde_json::to_value(&entry).unwrap_or_default(),
            expected_json.as_ref(),
            fingerprint_toml(&entry)?,
            creds.map(|c| c.profile_name.as_str()),
        )?,
    };
    Ok(HostDoctorEntry {
        host,
        scope,
        path: path.to_string(),
        status,
        detail,
    })
}

fn diagnose_entry(
    host: Host,
    scope: InstallScope,
    path: &str,
    entry: &serde_json::Value,
    expected: Option<&serde_json::Value>,
    current_fp: String,
    profile_name: Option<&str>,
) -> Result<(DoctorStatus, Option<String>)> {
    let record = load_record_for_host(Path::new(path), host, scope)?;
    diagnose_entry_with_record(entry, expected, current_fp, profile_name, record.as_ref())
}

fn diagnose_entry_with_record(
    entry: &serde_json::Value,
    expected: Option<&serde_json::Value>,
    current_fp: String,
    profile_name: Option<&str>,
    record: Option<&crate::config::IntegrationRecord>,
) -> Result<(DoctorStatus, Option<String>)> {
    if record.is_none() {
        let suffix = profile_name
            .map(|name| format!(" ({name})"))
            .unwrap_or_default();
        return Ok((
            DoctorStatus::Unowned,
            Some(format!(
                "entry not owned by `am integrate` — run `am integrate update --force` to adopt{suffix}"
            )),
        ));
    }
    if entry
        .get("env")
        .or_else(|| entry.get("environment"))
        .and_then(|e| e.get("ATOMICMEMORY_SCOPE_LOCK"))
        != Some(&serde_json::Value::String("true".into()))
    {
        return Ok((
            DoctorStatus::Drift,
            Some("missing ATOMICMEMORY_SCOPE_LOCK=true — run `am integrate update`".into()),
        ));
    }
    let Some(record) = record else { unreachable!() };
    if record.entry_fingerprint != current_fp {
        return Ok((
            DoctorStatus::Drift,
            Some("installed entry drifted from owned fingerprint".into()),
        ));
    }
    if let Some(expected) = expected {
        if entry != expected {
            return Ok((
                DoctorStatus::Drift,
                Some("entry differs from active profile — run `am integrate update`".into()),
            ));
        }
    }
    Ok((DoctorStatus::Ok, None))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{IntegrationRecord, ProfileKind};

    #[test]
    fn missing_entry_reports_missing() {
        let entry = compare_json(
            Host::Cursor,
            InstallScope::Global,
            "/tmp/missing-mcp.json",
            &serde_json::json!({}),
            None,
        )
        .unwrap();
        assert_eq!(entry.status, DoctorStatus::Missing);
    }

    #[test]
    fn opencode_valid_unowned_entry_reports_unowned_not_drift() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("opencode.json");
        let doc = serde_json::json!({
            "mcp": {
                "servers": {
                    "atomicmemory": {
                        "type": "local",
                        "command": ["npx", "server"],
                        "environment": { "ATOMICMEMORY_SCOPE_LOCK": "true" }
                    }
                }
            }
        });

        let entry = compare_json(
            Host::OpenCode,
            InstallScope::Global,
            path.to_str().unwrap(),
            &doc,
            None,
        )
        .unwrap();

        assert_eq!(entry.status, DoctorStatus::Unowned);
    }

    #[test]
    fn opencode_conflicting_entry_without_scope_lock_reports_unowned() {
        let entry = serde_json::json!({
            "type": "remote",
            "url": "https://example.com/mcp"
        });

        let diagnosis = diagnose_entry_with_record(
            &entry,
            None,
            fingerprint_json(&entry).unwrap(),
            Some("local"),
            None,
        )
        .unwrap();

        assert_eq!(diagnosis.0, DoctorStatus::Unowned);
    }

    #[test]
    fn opencode_doctor_classifies_healthy_and_drifted_entries() {
        let creds = IntegrateCredentials {
            api_url: "http://127.0.0.1:17350".into(),
            api_key: "key".into(),
            scope_user: "user".into(),
            scope_namespace: None,
            profile_name: "local".into(),
            profile_kind: ProfileKind::Local,
        };
        let entry = json_mcp_server(&creds, Host::OpenCode);
        let fingerprint = fingerprint_json(&entry).unwrap();
        let record = IntegrationRecord {
            host: "opencode".into(),
            scope: "global".into(),
            config_path: "/tmp/opencode.json".into(),
            profile: "local".into(),
            installed_at: "2026-09-17T00:00:00Z".into(),
            entry_fingerprint: fingerprint.clone(),
            prior_entry: None,
        };

        let healthy = diagnose_entry_with_record(
            &entry,
            Some(&entry),
            fingerprint.clone(),
            Some("local"),
            Some(&record),
        )
        .unwrap();
        assert_eq!(healthy.0, DoctorStatus::Ok);

        let mut changed = entry.clone();
        changed["environment"]["ATOMICMEMORY_API_URL"] =
            serde_json::Value::String("https://changed.example.com".into());
        let drift = diagnose_entry_with_record(
            &changed,
            Some(&entry),
            fingerprint_json(&changed).unwrap(),
            Some("local"),
            Some(&record),
        )
        .unwrap();
        assert_eq!(drift.0, DoctorStatus::Drift);
    }
}
