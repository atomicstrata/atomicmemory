//! Exercise managed Docker inspection and credential recovery through actual subprocess boundaries.

use super::{DockerRunner, RealDockerRunner, default_instance_config};
use crate::instance::credentials::resolve_dataset_key;
use crate::instance::storage::{Provider, StorageVolumes};
use serde_json::{Value, json};
use std::os::unix::fs::PermissionsExt;

fn fake_docker(script: &str) -> (tempfile::TempDir, RealDockerRunner) {
    let directory = tempfile::tempdir().unwrap();
    let executable = directory.path().join("docker");
    // Write via rename so spawn never hits ETXTBSY on a still-open writer FD.
    let staging = directory.path().join("docker.staging");
    std::fs::write(&staging, format!("#!/bin/sh\nset -eu\n{script}\n")).unwrap();
    std::fs::set_permissions(&staging, std::fs::Permissions::from_mode(0o700)).unwrap();
    std::fs::rename(&staging, &executable).unwrap();
    let docker = RealDockerRunner {
        docker_bin: executable.to_string_lossy().into_owned(),
    };
    (directory, docker)
}

fn inspect_fixture() -> Value {
    json!([{
        "State": { "Status": "running" },
        "Config": {
            "Image": "example/core:fixture",
            "Labels": {
                "ai.atomicstrata.managed-by": "am-cli",
                "ai.atomicstrata.profile": "test-profile",
                "ai.atomicstrata.project-id": "project-one",
                "ai.atomicstrata.local-url": "http://127.0.0.1:17350"
            },
            "Env": ["OPENAI_API_KEY=fixture-openai-key", "EMBEDDING_DIMENSIONS=1536"]
        },
        "Mounts": [
            { "Type": "volume", "Name": "provider-data", "Destination": "/var/lib/atomicmemory/postgres" },
            { "Type": "volume", "Name": "provider-state", "Destination": "/var/lib/atomicmemory/state" }
        ],
        "NetworkSettings": { "Ports": { "17350/tcp": [{ "HostIp": "127.0.0.1", "HostPort": "17352" }] } }
    }])
}

async fn inspect_fixture_with(fixture: Value) -> super::ContainerInspect {
    let (directory, docker) = fake_docker("cat \"$(dirname \"$0\")/inspect.json\"");
    std::fs::write(directory.path().join("inspect.json"), fixture.to_string()).unwrap();
    docker.inspect("atomic-memory").await.unwrap().unwrap()
}

#[tokio::test]
async fn actual_inspect_binding_wins_over_a_misleading_url_label() {
    let inspected = inspect_fixture_with(inspect_fixture()).await;
    assert_eq!(
        inspected.local_url.as_deref(),
        Some("http://127.0.0.1:17352")
    );
    let storage = inspected.storage.unwrap();
    assert_eq!(storage.provider, Provider::Openai);
    assert_eq!(storage.project_id.as_deref(), Some("project-one"));
    assert_eq!(
        storage.volumes,
        StorageVolumes {
            data: "provider-data".into(),
            state: "provider-state".into()
        }
    );
}

#[tokio::test]
async fn wildcard_or_ambiguous_bindings_never_prove_a_safe_destination() {
    for bindings in [
        json!([{ "HostIp": "0.0.0.0", "HostPort": "17352" }]),
        json!([{ "HostIp": "::", "HostPort": "17352" }]),
        json!([{ "HostIp": "127.0.0.1", "HostPort": "0" }]),
        json!([{ "HostIp": "127.0.0.1", "HostPort": "17352" }, { "HostIp": "0.0.0.0", "HostPort": "17352" }]),
        Value::Null,
    ] {
        let mut fixture = inspect_fixture();
        fixture[0]["NetworkSettings"]["Ports"]["17350/tcp"] = bindings;
        assert!(inspect_fixture_with(fixture).await.local_url.is_none());
    }
}

#[tokio::test]
async fn unknown_embedding_configurations_never_prove_provider_storage() {
    for env in [
        json!(["OPENAI_API_KEY=fixture", "EMBEDDING_PROVIDER=custom"]),
        json!(["OPENAI_API_KEY=fixture", "EMBEDDING_DIMENSIONS=768"]),
        json!([]),
        json!([
            "EMBEDDING_PROVIDER=openai-compatible",
            "EMBEDDING_DIMENSIONS=768"
        ]),
    ] {
        let mut fixture = inspect_fixture();
        fixture[0]["Config"]["Env"] = env;
        assert!(inspect_fixture_with(fixture).await.storage.is_none());
    }
}

#[tokio::test]
async fn provider_proof_requires_both_named_docker_volumes() {
    for index in [0, 1] {
        let mut fixture = inspect_fixture();
        fixture[0]["Mounts"][index]["Type"] = json!("bind");
        assert!(inspect_fixture_with(fixture).await.storage.is_none());
    }
    let mut fixture = inspect_fixture();
    fixture[0]["Mounts"][1]["Name"] = Value::Null;
    assert!(inspect_fixture_with(fixture).await.storage.is_none());
}

#[tokio::test]
async fn slm_storage_is_identified_from_observed_models_and_mounts() {
    let mut fixture = inspect_fixture();
    fixture[0]["Config"]["Env"] = json!([
        "EMBEDDING_PROVIDER=openai-compatible",
        "EMBEDDING_DIMENSIONS=768",
        format!("EMBEDDING_MODEL={}", crate::slm::SLM_EMBED_MODEL),
        format!("LLM_MODEL={}", crate::slm::SLM_CHAT_MODEL),
    ]);
    let inspected = inspect_fixture_with(fixture).await;
    assert_eq!(inspected.storage.unwrap().provider, Provider::Slm);
}

#[tokio::test]
async fn credential_resolution_reads_only_the_target_state_volume() {
    let (directory, docker) = fake_docker(
        r#"
        printf '%s\n' "$@" >> "$(dirname "$0")/calls"
        case "$1" in
            volume) printf '[{}]' ;;
            run)
                case "$*" in
                    *src=slm-state,dst=/state,readonly*) printf 'saved-slm-key\n' ;;
                    *) printf 'outgoing-openai-key\n' ;;
                esac ;;
            *) exit 91 ;;
        esac
    "#,
    );
    let mut config = default_instance_config("test-profile", "example/core:fixture");
    config.provider = Provider::Slm;
    config.storage = StorageVolumes {
        data: "slm-data".into(),
        state: "slm-state".into(),
    };
    let key = resolve_dataset_key(&docker, &config, false, None, false)
        .await
        .unwrap();
    assert_eq!(key, "saved-slm-key");
    let calls = std::fs::read_to_string(directory.path().join("calls")).unwrap();
    assert!(calls.contains("type=volume,src=slm-state,dst=/state,readonly"));
    assert!(calls.contains("--network\nnone\n"));
    for forbidden in ["atomic-memory\n", "openai-state", "saved-slm-key", "exec\n"] {
        assert!(
            !calls.contains(forbidden),
            "unexpected argument {forbidden}"
        );
    }
}

#[tokio::test]
async fn target_state_read_failure_does_not_generate_a_replacement_key() {
    let (_directory, docker) =
        fake_docker("case \"$1\" in volume) printf '[{}]' ;; run) exit 1 ;; esac");
    let config = default_instance_config("test-profile", "example/core:fixture");
    let error = resolve_dataset_key(&docker, &config, false, None, false)
        .await
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("could not read selected provider's Core key")
    );
}

#[tokio::test]
async fn missing_docker_and_unavailable_daemon_have_distinct_recovery_messages() {
    let directory = tempfile::tempdir().unwrap();
    let missing = RealDockerRunner {
        docker_bin: directory
            .path()
            .join("missing-docker")
            .to_string_lossy()
            .into_owned(),
    };
    assert!(
        missing
            .version()
            .await
            .unwrap_err()
            .to_string()
            .contains("not installed")
    );
    let (_directory, unavailable) = fake_docker("printf 'daemon private diagnostic' >&2; exit 1");
    let message = unavailable.version().await.unwrap_err().to_string();
    assert!(message.contains("daemon is unavailable"));
    assert!(!message.contains("not installed"));
    assert!(!message.contains("private diagnostic"));
}

#[tokio::test]
async fn inspect_distinguishes_missing_container_from_unavailable_daemon() {
    let (_directory, missing) =
        fake_docker("printf 'Error: No such container: atomic-memory' >&2; exit 1");
    assert!(missing.inspect("atomic-memory").await.unwrap().is_none());
    let (_directory, unavailable) =
        fake_docker("printf 'Cannot connect to Docker daemon' >&2; exit 1");
    assert!(unavailable.inspect("atomic-memory").await.is_err());
}

#[tokio::test]
async fn stopped_container_binding_is_available_only_for_restart_preparation() {
    let mut fixture = inspect_fixture();
    fixture[0]["State"]["Status"] = json!("exited");
    fixture[0]["NetworkSettings"]["Ports"] = json!({});
    fixture[0]["HostConfig"] =
        json!({"PortBindings": {"17350/tcp": [{"HostIp": "127.0.0.1", "HostPort": "17352"}]}});
    let (directory, docker) = fake_docker("cat \"$(dirname \"$0\")/inspect.json\"");
    std::fs::write(directory.path().join("inspect.json"), fixture.to_string()).unwrap();
    assert!(
        docker
            .inspect("atomic-memory")
            .await
            .unwrap()
            .unwrap()
            .local_url
            .is_none()
    );
    assert_eq!(
        docker
            .configured_local_url("atomic-memory")
            .await
            .unwrap()
            .as_deref(),
        Some("http://127.0.0.1:17352")
    );
    fixture[0]["HostConfig"]["PortBindings"]["17350/tcp"][0]["HostIp"] = json!("0.0.0.0");
    std::fs::write(directory.path().join("inspect.json"), fixture.to_string()).unwrap();
    assert!(
        docker
            .configured_local_url("atomic-memory")
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn repeated_purge_accepts_missing_volume_but_not_other_daemon_errors() {
    let (_directory, docker) =
        fake_docker("echo 'Error response from daemon: get selected: no such volume' >&2; exit 1");
    docker.volume_rm("selected").await.unwrap();
    let (_directory, docker) = fake_docker("echo 'permission denied' >&2; exit 1");
    assert!(docker.volume_rm("selected").await.is_err());
}
