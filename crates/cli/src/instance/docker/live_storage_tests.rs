//! Opt-in Docker integration for retained provider data and credential volumes.

use super::*;
use crate::config::{ProfileKind, ResolvedProfile};
use crate::instance::storage::{Provider, RuntimeStore};

#[tokio::test]
#[ignore = "requires a Docker daemon and debian:bookworm-slim image"]
async fn live_provider_switch_preserves_data_and_state() {
    let docker = RealDockerRunner::new();
    docker.version().await.unwrap();
    let directory = tempfile::tempdir().unwrap();
    let mut registry = RuntimeStore::at(&directory.path().join("runtimes.json")).unwrap();
    let profile = ResolvedProfile {
        name: "provider-test".into(),
        base_url: "https://cloud.example.test".into(),
        kind: ProfileKind::Local,
        project_id: Some(uuid::Uuid::now_v7().to_string()),
        memory_base_url: "http://127.0.0.1:17352".into(),
        api_key: None,
        oauth: None,
    };
    let mut datasets = Vec::new();
    for provider in [Provider::Openai, Provider::Slm] {
        let mut config = default_instance_config(&profile.name, "debian:bookworm-slim");
        config.provider = provider;
        config.storage = registry.select(&profile, provider, None).unwrap();
        datasets.push(config);
    }
    let result: Result<()> = async {
        for index in [0, 1, 0, 1, 0] {
            let config = &datasets[index];
            docker.prepare_storage(config, None, false).await?;
            let data = format!("type=volume,src={},dst=/data", config.storage.data);
            let state = format!("type=volume,src={},dst=/state", config.storage.state);
            let expected = format!("{}-retained-memory", config.provider.as_str());
            let (code, _, _) = docker.exec_capture(&[
                "run", "--rm", "--network", "none", "--mount", &data, "--mount", &state,
                &config.image, "sh", "-eu", "-c",
                "if test -f /data/memory; then test \"$(cat /data/memory)\" = \"$1\"; else printf %s \"$1\" > /data/memory; fi; if ! test -f /state/core-api-key; then printf %s \"$1-key\" > /state/core-api-key; fi",
                "provider-test", &expected,
            ], None).await?;
            anyhow::ensure!(code == 0, "provider data changed after container replacement");
            let key = crate::instance::credentials::resolve_dataset_key(&docker, config, false, None, false).await?;
            anyhow::ensure!(key == format!("{expected}-key"), "selected provider credential changed");
            registry.select(&profile, config.provider, None)?;
            registry.save()?;
        }
        // Purging one selected pair must leave the other provider's credential readable.
        docker.volume_rm(&datasets[1].storage.data).await?;
        docker.volume_rm(&datasets[1].storage.state).await?;
        anyhow::ensure!(docker.read_volume_core_api_key(&datasets[0].storage.state, &datasets[0].image).await?.as_deref() == Some("openai-retained-memory-key"));
        Ok(())
    }.await;
    for config in datasets {
        docker.volume_rm(&config.storage.data).await.unwrap();
        docker.volume_rm(&config.storage.state).await.unwrap();
    }
    result.unwrap();
}
