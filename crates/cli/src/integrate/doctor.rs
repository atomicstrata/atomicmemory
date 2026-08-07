//! Validate installed host MCP entries against the active profile.

use std::path::Path;

use anyhow::Result;
use serde::Serialize;

use crate::integrate::codex_edit::{current_codex_entry, read_codex_document};
use crate::integrate::fingerprint::{fingerprint_json, fingerprint_toml};
use crate::integrate::host::{Host, InstallScope};
use crate::integrate::path_util::binary_on_path;
use crate::integrate::spec::{IntegrateCredentials, codex_mcp_table, json_mcp_server};
use crate::integrate::state::load_record;
use crate::integrate::write::{current_json_entry, read_json_file};

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
    creds: Option<&IntegrateCredentials>,
) -> DoctorReport {
    let mut entries = Vec::new();
    for &host in hosts {
        match doctor_one(host, scope, cwd, creds) {
            Ok(Some(entry)) => entries.push(entry),
            Ok(None) => {}
            Err(err) => entries.push(failed_doctor_entry(host, scope, cwd, err)),
        }
    }
    DoctorReport { entries }
}

fn failed_doctor_entry(
    host: Host,
    scope: InstallScope,
    cwd: &Path,
    err: anyhow::Error,
) -> HostDoctorEntry {
    let path = host
        .config_path(scope, cwd)
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
    creds: Option<&IntegrateCredentials>,
) -> Result<Option<HostDoctorEntry>> {
    let path = host.config_path(scope, cwd)?;
    let path_str = path.display().to_string();
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
        Host::Cursor | Host::ClaudeCode => {
            let existing = read_json_file(&path);
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
    let current = current_json_entry(existing);
    let (status, detail) = match current {
        None => (
            DoctorStatus::Missing,
            Some("no atomicmemory server entry".into()),
        ),
        Some(entry) => diagnose_entry(
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
    path: &str,
    entry: &serde_json::Value,
    expected: Option<&serde_json::Value>,
    current_fp: String,
    profile_name: Option<&str>,
) -> Result<(DoctorStatus, Option<String>)> {
    if entry
        .get("env")
        .and_then(|e| e.get("ATOMICMEMORY_SCOPE_LOCK"))
        != Some(&serde_json::Value::String("true".into()))
    {
        return Ok((
            DoctorStatus::Drift,
            Some("missing ATOMICMEMORY_SCOPE_LOCK=true — run `am integrate update`".into()),
        ));
    }
    let record = load_record(Path::new(path))?;
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
}
