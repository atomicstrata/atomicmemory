//! Stable JSON status document for `am slm status`.

use serde::Serialize;

use super::DEFAULT_SLM_PORT;
use super::RUNTIME_API_COMPAT;
use super::cache::slm_hf_home;
use super::cache_probe::models_cache_flags_with_disk;
use super::health::RequiredModels;
use super::manifest::{VersionManifest, current_platform_label, current_target, fetch_manifest};
use super::manifest_url_from_env;
use super::models::status_models_json;
use super::paths::SlmPaths;
use super::process::pid_alive;

/// Stable automation-facing status payload.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SlmStatusJson {
    pub supported: bool,
    pub platform: String,
    pub target: Option<String>,
    pub installed: bool,
    pub installed_version: Option<String>,
    pub manifest_version: Option<String>,
    pub update_available: bool,
    pub process: ProcessStatus,
    pub health: HealthStatus,
    pub models: ModelsStatus,
    pub cache: CacheStatus,
    pub disk: DiskStatus,
    pub endpoint: String,
    pub runtime_api_compat: String,
    pub managed: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ProcessStatus {
    pub managed: bool,
    pub pid: Option<u32>,
    pub alive: bool,
    pub port: u16,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct HealthStatus {
    pub ok: bool,
    pub endpoint: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ModelsStatus {
    pub am_slm_core: bool,
    pub nomic_embed_text: bool,
    pub ready: bool,
}

/// Disk cache readiness (independent of a live `/v1/models` probe).
#[derive(Debug, Clone, Serialize, PartialEq, Default)]
pub struct CacheStatus {
    pub qwen: bool,
    pub nomic: bool,
    pub am_slm_core: bool,
    pub ready: bool,
    /// Set when `am-slm models status --json` cannot be executed or parsed.
    /// `ready: false` without `error` means a successful inspection found gaps.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct DiskStatus {
    pub binary_only_bytes: u64,
    pub with_models_bytes: u64,
}

/// Collect status using optional live health/manifest probes.
pub async fn collect_status(
    client: &reqwest::Client,
    paths: &SlmPaths,
    manifest: Option<&VersionManifest>,
    models: Option<RequiredModels>,
    health_ok: bool,
) -> anyhow::Result<SlmStatusJson> {
    let target = current_target().map(str::to_string);
    let supported = target.is_some();
    let state = paths.read_state().unwrap_or_default();
    let installed = paths.binary().is_file();
    let port = state.port.unwrap_or(DEFAULT_SLM_PORT);
    let endpoint_base = format!("http://127.0.0.1:{port}");
    let pid = state.pid;
    let alive = pid.map(pid_alive).unwrap_or(false);

    let (manifest_version, disk, runtime_compat) = if let Some(m) = manifest {
        (
            Some(m.version.clone()),
            DiskStatus {
                binary_only_bytes: m.min_disk_bytes.binary_only,
                with_models_bytes: m.min_disk_bytes.with_models,
            },
            m.runtime_api_compat.clone(),
        )
    } else {
        match fetch_manifest(client, &manifest_url_from_env()).await {
            Ok(m) => (
                Some(m.version.clone()),
                DiskStatus {
                    binary_only_bytes: m.min_disk_bytes.binary_only,
                    with_models_bytes: m.min_disk_bytes.with_models,
                },
                m.runtime_api_compat.clone(),
            ),
            Err(_) => (
                None,
                DiskStatus {
                    binary_only_bytes: 0,
                    with_models_bytes: 0,
                },
                RUNTIME_API_COMPAT.to_string(),
            ),
        }
    };

    let installed_version = state.installed_version.clone();
    let update_available = match (&installed_version, &manifest_version) {
        (Some(local), Some(remote)) => local != remote,
        _ => false,
    };

    let models = models.unwrap_or_default();
    Ok(SlmStatusJson {
        supported,
        platform: current_platform_label(),
        target,
        installed,
        installed_version,
        manifest_version,
        update_available,
        process: ProcessStatus {
            managed: state.managed_process,
            pid,
            alive,
            port,
        },
        health: HealthStatus {
            ok: health_ok,
            endpoint: endpoint_base.clone(),
        },
        models: ModelsStatus {
            am_slm_core: models.chat,
            nomic_embed_text: models.embed,
            ready: models.ready(),
        },
        cache: disk_cache_status(paths, installed).await,
        disk,
        endpoint: format!("{endpoint_base}/v1"),
        runtime_api_compat: runtime_compat,
        managed: state.managed_process,
    })
}

async fn disk_cache_status(paths: &SlmPaths, installed: bool) -> CacheStatus {
    if !installed {
        return CacheStatus::default();
    }
    match status_models_json(paths).await {
        Ok(status) => {
            let flags = models_cache_flags_with_disk(&status, &slm_hf_home(paths));
            CacheStatus {
                qwen: flags.qwen,
                nomic: flags.nomic,
                am_slm_core: flags.am_slm_core,
                ready: flags.ready(),
                error: None,
            }
        }
        Err(err) => CacheStatus {
            error: Some(format!("{err:#}")),
            ..CacheStatus::default()
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::slm::manifest::parse_manifest;
    use tempfile::tempdir;

    #[tokio::test]
    async fn status_json_shape_from_fixture() {
        let body = include_str!("../../tests/fixtures/am-slm-version.json");
        let manifest = parse_manifest(body).unwrap();
        let dir = tempdir().unwrap();
        let paths = SlmPaths::at(dir.path().to_path_buf());
        let client = reqwest::Client::new();
        let status = collect_status(
            &client,
            &paths,
            Some(&manifest),
            Some(RequiredModels {
                chat: true,
                embed: true,
            }),
            true,
        )
        .await
        .unwrap();
        let value = serde_json::to_value(&status).unwrap();
        for key in [
            "supported",
            "platform",
            "target",
            "installed",
            "installed_version",
            "manifest_version",
            "update_available",
            "process",
            "health",
            "models",
            "cache",
            "disk",
            "endpoint",
            "runtime_api_compat",
            "managed",
        ] {
            assert!(value.get(key).is_some(), "missing {key}");
        }
        assert_eq!(status.manifest_version.as_deref(), Some("0.1.1"));
        assert_eq!(status.runtime_api_compat, "am-slm-openai-v1");
        assert!(status.models.ready);
        assert!(!status.cache.ready);
        assert!(status.cache.error.is_none());
        assert_eq!(status.disk.binary_only_bytes, 52_428_800);
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn cache_ready_when_process_is_down() {
        use std::fs;
        use std::os::unix::fs::PermissionsExt;

        let body = include_str!("../../tests/fixtures/am-slm-version.json");
        let manifest = parse_manifest(body).unwrap();
        let dir = tempdir().unwrap();
        let paths = SlmPaths::at(dir.path().to_path_buf());
        paths.ensure().unwrap();
        let ready = include_str!("../../tests/fixtures/am-slm-models-status.json");
        fs::write(
            paths.binary(),
            format!("#!/bin/sh\nprintf '%s\\n' '{ready}'\n"),
        )
        .unwrap();
        fs::set_permissions(paths.binary(), fs::Permissions::from_mode(0o755)).unwrap();
        let client = reqwest::Client::new();
        let status = collect_status(&client, &paths, Some(&manifest), None, false)
            .await
            .unwrap();
        assert!(status.cache.ready);
        assert!(status.cache.qwen && status.cache.nomic && status.cache.am_slm_core);
        assert!(status.cache.error.is_none());
        assert!(!status.models.ready);
        assert!(!status.health.ok);
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn cache_error_on_nonzero_status_exit() {
        let status = collect_with_binary("#!/bin/sh\necho broken-status >&2\nexit 7\n").await;
        assert!(!status.cache.ready);
        let error = status.cache.error.expect("inspection error");
        assert!(
            error.contains("7") && error.contains("broken-status"),
            "{error}"
        );
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn cache_errors_preserve_diagnostics_without_credentials() {
        let status = collect_with_binary("#!/bin/sh\necho 'broken-status access_token=private-token user@example.com' >&2\nexit 7\n").await;
        let error = status.cache.error.unwrap();
        assert!(error.contains("broken-status"));
        assert!(!error.contains("private-token"));
        assert!(!error.contains("user@example.com"));
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn cache_error_on_malformed_status_json() {
        let status = collect_with_binary("#!/bin/sh\nprintf 'not-json\\n'\nexit 0\n").await;
        assert!(!status.cache.ready);
        let error = status.cache.error.expect("parse error");
        assert!(error.contains("parse am-slm models status"), "{error}");
    }

    #[cfg(unix)]
    async fn collect_with_binary(script: &str) -> SlmStatusJson {
        use std::fs;
        use std::os::unix::fs::PermissionsExt;

        let body = include_str!("../../tests/fixtures/am-slm-version.json");
        let manifest = parse_manifest(body).unwrap();
        let dir = tempdir().unwrap();
        let paths = SlmPaths::at(dir.path().to_path_buf());
        paths.ensure().unwrap();
        fs::write(paths.binary(), script).unwrap();
        fs::set_permissions(paths.binary(), fs::Permissions::from_mode(0o755)).unwrap();
        let client = reqwest::Client::new();
        collect_status(&client, &paths, Some(&manifest), None, false)
            .await
            .unwrap()
    }
}
