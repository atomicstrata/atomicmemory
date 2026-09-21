//! Docker volume ownership checks and read-only provider credential retrieval.

use super::{InstanceConfig, RealDockerRunner};
use crate::instance::storage::{StorageIdentity, StorageVolumes};
use anyhow::{Context, Result, bail};
use serde::Deserialize;
use std::collections::HashMap;

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct Volume {
    #[serde(default)]
    labels: Option<HashMap<String, String>>,
    #[serde(default)]
    created_at: Option<String>,
}

async fn inspect(docker: &RealDockerRunner, name: &str) -> Result<Option<Volume>> {
    let (code, stdout, stderr) = docker
        .exec_capture(&["volume", "inspect", name], None)
        .await?;
    if code != 0 {
        if stderr.to_ascii_lowercase().contains("no such volume") {
            return Ok(None);
        }
        bail!("could not inspect Core volume; check Docker and retry");
    }
    let volumes: Vec<Volume> =
        serde_json::from_str(&stdout).context("parse Docker volume metadata")?;
    volumes
        .into_iter()
        .next()
        .map(Some)
        .ok_or_else(|| anyhow::anyhow!("Docker returned no volume metadata"))
}

pub(super) async fn exists(docker: &RealDockerRunner, name: &str) -> Result<bool> {
    Ok(inspect(docker, name).await?.is_some())
}

/// Check both existing volumes before any create, attach, or destructive operation.
pub(super) async fn validate(
    docker: &RealDockerRunner,
    config: &InstanceConfig,
    recorded: Option<&StorageIdentity>,
    live_legacy: bool,
) -> Result<StorageIdentity> {
    let data = inspect(docker, &config.storage.data).await?;
    let state = inspect(docker, &config.storage.state).await?;
    for (name, volume, expected) in [
        (
            &config.storage.data,
            &data,
            recorded.and_then(|i| i.data.as_deref()),
        ),
        (
            &config.storage.state,
            &state,
            recorded.and_then(|i| i.state.as_deref()),
        ),
    ] {
        if let Some(volume) = volume {
            validate_volume(config, name, volume, expected, live_legacy)?;
        }
    }
    Ok(StorageIdentity {
        data: data.and_then(|volume| volume.created_at),
        state: state.and_then(|volume| volume.created_at),
    })
}

pub(super) async fn ensure(
    docker: &RealDockerRunner,
    config: &InstanceConfig,
    recorded: Option<&StorageIdentity>,
    live_legacy: bool,
) -> Result<StorageIdentity> {
    let identity = validate(docker, config, recorded, live_legacy).await?;
    let dataset = format!("{}:{}", config.storage.data, config.provider.as_str());
    for name in [&config.storage.data, &config.storage.state] {
        if inspect(docker, name).await?.is_some() {
            continue;
        }
        let label = format!("ai.atomicstrata.dataset={dataset}");
        let (code, _, _) = docker
            .exec_capture(
                &[
                    "volume",
                    "create",
                    "--label",
                    "ai.atomicstrata.managed-by=am-cli",
                    "--label",
                    &label,
                    name,
                ],
                None,
            )
            .await?;
        if code != 0 {
            bail!("could not prepare provider volume '{name}'; existing data was preserved");
        }
    }
    validate(docker, config, Some(&identity), live_legacy).await
}

pub(super) async fn read_key(
    docker: &RealDockerRunner,
    name: &str,
    image: &str,
) -> Result<Option<String>> {
    if !exists(docker, name).await? {
        return Ok(None);
    }
    let mount = format!("type=volume,src={name},dst=/state,readonly");
    let (code, stdout, _) = docker
        .exec_capture(
            &[
                "run",
                "--rm",
                "--network",
                "none",
                "--mount",
                &mount,
                "--entrypoint",
                "sh",
                image,
                "-c",
                "if test -f /state/core-api-key; then cat /state/core-api-key; fi",
            ],
            None,
        )
        .await?;
    if code != 0 {
        bail!(
            "could not read selected provider's Core key; dataset preserved, retry when Docker is ready"
        );
    }
    let key = stdout.trim();
    Ok((!key.is_empty()).then(|| key.to_string()))
}

fn validate_volume(
    config: &InstanceConfig,
    name: &str,
    volume: &Volume,
    recorded: Option<&str>,
    live_legacy: bool,
) -> Result<()> {
    let dataset = format!("{}:{}", config.storage.data, config.provider.as_str());
    if volume.labels.as_ref().is_some_and(|labels| {
        labels.get("ai.atomicstrata.dataset") == Some(&dataset)
            && labels.get("ai.atomicstrata.managed-by").map(String::as_str) == Some("am-cli")
    }) {
        return Ok(());
    }
    if config.storage == StorageVolumes::legacy() {
        let created = volume
            .created_at
            .as_deref()
            .filter(|value| !value.is_empty());
        if created.is_some() && (live_legacy || recorded.is_some() && created == recorded) {
            return Ok(());
        }
    }
    bail!(
        "volume '{name}' lacks matching managed dataset ownership or legacy creation identity; preserved without attaching or deleting it"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(legacy: bool) -> InstanceConfig {
        let mut config = crate::instance::docker::default_instance_config("local", "core-test");
        if !legacy {
            config.storage = crate::instance::storage::StorageVolumes {
                data: "known-data".into(),
                state: "known-state".into(),
            };
        }
        config
    }

    fn volume(created_at: &str) -> Volume {
        Volume {
            labels: None,
            created_at: Some(created_at.into()),
        }
    }

    #[test]
    fn foreign_named_volume_is_rejected_before_removal() {
        assert!(
            validate_volume(
                &config(false),
                "known-data",
                &volume("foreign"),
                None,
                false
            )
            .is_err()
        );
    }

    #[test]
    fn retired_legacy_volume_requires_the_recorded_creation_identity() {
        let config = config(true);
        assert!(
            validate_volume(
                &config,
                &config.storage.data,
                &volume("original"),
                Some("original"),
                false
            )
            .is_ok()
        );
        assert!(
            validate_volume(
                &config,
                &config.storage.data,
                &volume("replacement"),
                Some("original"),
                false
            )
            .is_err()
        );
        assert!(
            validate_volume(
                &config,
                &config.storage.data,
                &volume("original"),
                None,
                false
            )
            .is_err()
        );
    }

    #[test]
    fn live_legacy_adoption_requires_a_creation_timestamp() {
        let config = config(true);
        assert!(
            validate_volume(
                &config,
                &config.storage.data,
                &volume("original"),
                None,
                true
            )
            .is_ok()
        );
        let missing = Volume {
            labels: None,
            created_at: None,
        };
        assert!(validate_volume(&config, &config.storage.data, &missing, None, true).is_err());
    }
}
