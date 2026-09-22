//! Removal regressions exercising real Docker argv against an isolated fake executable.

use super::*;
use crate::config::ResolvedProfile;
use crate::instance::storage::{ObservedStorage, StorageIdentity, StorageVolumes};
use std::os::unix::fs::PermissionsExt;

struct Fixture {
    directory: tempfile::TempDir,
    docker: RealDockerRunner,
    registry: RuntimeStore,
    profile: ResolvedProfile,
}

impl Fixture {
    fn new(created_at: &str) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let binary = directory.path().join("fake-docker");
        let log = directory.path().join("calls");
        let json = serde_json::json!([{"Labels": null, "CreatedAt":created_at}]);
        let script = format!(
            "#!/bin/sh\nprintf '%s\\n' \"$*\" >> '{}'\nif [ \"$1 $2\" = 'volume inspect' ]; then printf '%s\\n' '{}'; fi\n",
            log.display(),
            json
        );
        let staging = directory.path().join("fake-docker.staging");
        std::fs::write(&staging, script).unwrap();
        std::fs::set_permissions(&staging, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::rename(&staging, &binary).unwrap();
        let registry = RuntimeStore::at(&directory.path().join("runtimes.json")).unwrap();
        Self {
            directory,
            registry,
            docker: RealDockerRunner {
                docker_bin: binary.to_string_lossy().into(),
            },
            profile: ResolvedProfile {
                name: "local-test".into(),
                base_url: "https://api.atomicstrata.ai".into(),
                kind: ProfileKind::Local,
                project_id: Some("project-one".into()),
                memory_base_url: "http://127.0.0.1:17350".into(),
                api_key: Some("amc_owner".into()),
                oauth: None,
            },
        }
    }

    fn calls(&self) -> String {
        match std::fs::read_to_string(self.directory.path().join("calls")) {
            Ok(calls) => calls,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(err) => panic!("read fake Docker calls: {err}"),
        }
    }

    fn legacy_container(&self) -> ContainerInspect {
        ContainerInspect {
            name: DEFAULT_CONTAINER_NAME.into(),
            image: "fixture".into(),
            state: ContainerState::Running,
            managed_by_cli: true,
            profile_label: Some(self.profile.name.clone()),
            atomicmemory_api_url: Some(self.profile.base_url.clone()),
            cloud_jwks_url: Some(jwks_url(&self.profile.base_url).unwrap()),
            core_api_key: None,
            atomicmemory_api_key: self.profile.api_key.clone(),
            local_url: Some(self.profile.memory_base_url.clone()),
            storage: Some(ObservedStorage {
                provider: Provider::Openai,
                volumes: StorageVolumes::legacy(),
                project_id: None,
            }),
        }
    }

    fn adopt_legacy(&mut self, created_at: &str) {
        self.registry
            .select(
                &self.profile,
                Provider::Openai,
                Some(&self.legacy_container()),
            )
            .unwrap();
        let identity = StorageIdentity {
            data: Some(created_at.into()),
            state: Some(created_at.into()),
        };
        self.registry
            .record_identity(
                &self.profile,
                Provider::Openai,
                &StorageVolumes::legacy(),
                identity,
            )
            .unwrap();
        self.registry.save().unwrap();
    }
}

#[tokio::test]
async fn purge_does_not_invent_a_dataset_for_unregistered_profile() {
    let mut fixture = Fixture::new("foreign");
    let result = remove_selected_dataset(
        &fixture.profile,
        &fixture.docker,
        &mut fixture.registry,
        None,
        true,
    )
    .await;
    assert!(
        result
            .unwrap_err()
            .to_string()
            .contains("no proven dataset")
    );
    assert!(fixture.calls().is_empty());
}

#[tokio::test]
async fn purge_refuses_foreign_volume_before_any_destructive_docker_command() {
    let mut fixture = Fixture::new("foreign");
    fixture
        .registry
        .select(&fixture.profile, Provider::Openai, None)
        .unwrap();
    let result = remove_selected_dataset(
        &fixture.profile,
        &fixture.docker,
        &mut fixture.registry,
        None,
        true,
    )
    .await;
    assert!(result.unwrap_err().to_string().contains("ownership"));
    let calls = fixture.calls();
    assert_eq!(calls.lines().count(), 2);
    assert!(
        calls
            .lines()
            .all(|line| line.starts_with("volume inspect "))
    );
}

#[tokio::test]
async fn purge_rejects_legacy_names_recreated_after_adoption() {
    let mut fixture = Fixture::new("replacement");
    fixture.adopt_legacy("original");
    let result = remove_selected_dataset(
        &fixture.profile,
        &fixture.docker,
        &mut fixture.registry,
        None,
        true,
    )
    .await;
    assert!(
        result
            .unwrap_err()
            .to_string()
            .contains("legacy creation identity")
    );
    assert!(!fixture.calls().contains("volume rm"));
}

#[tokio::test]
async fn purge_accepts_retired_legacy_pair_with_durable_creation_identity() {
    let mut fixture = Fixture::new("original");
    fixture.adopt_legacy("original");
    let removed = remove_selected_dataset(
        &fixture.profile,
        &fixture.docker,
        &mut fixture.registry,
        None,
        true,
    )
    .await
    .unwrap();
    assert_eq!(removed, StorageVolumes::legacy());
    assert_eq!(
        fixture
            .calls()
            .lines()
            .filter(|line| line.starts_with("volume rm "))
            .count(),
        2
    );
}

#[tokio::test]
async fn legacy_project_mismatch_is_rejected_before_docker_mutation() {
    let mut fixture = Fixture::new("original");
    let mut current = fixture.legacy_container();
    current.atomicmemory_api_key = Some("amc_other_project".into());
    let result = remove_selected_dataset(
        &fixture.profile,
        &fixture.docker,
        &mut fixture.registry,
        Some(&current),
        true,
    )
    .await;
    assert!(result.unwrap_err().to_string().contains("ownership"));
    assert!(fixture.calls().is_empty());
}

#[tokio::test]
async fn preflight_saves_only_outgoing_legacy_proof_before_cloud_key_rotation() {
    let mut fixture = Fixture::new("original");
    let binary = fixture.directory.path().join("fake-docker");
    let log = fixture.directory.path().join("calls");
    let volumes = StorageVolumes::legacy();
    let container = serde_json::json!([{
        "State":{"Status":"running"},
        "Config":{"Image":"fixture", "Labels":{
            "ai.atomicstrata.managed-by":"am-cli", "ai.atomicstrata.profile":"local-test"
        }, "Env":["OPENAI_API_KEY=test", "ATOMICMEMORY_API_URL=https://api.atomicstrata.ai", "ATOMICMEMORY_API_KEY=amc_owner"]},
        "Mounts":[
            {"Type":"volume", "Name":volumes.data, "Destination":"/var/lib/atomicmemory/postgres"},
            {"Type":"volume", "Name":volumes.state, "Destination":"/var/lib/atomicmemory/state"}
        ]
    }]);
    let script = format!(
        "#!/bin/sh\nprintf '%s\\n' \"$*\" >> '{}'\nif [ \"$1\" = inspect ]; then printf '%s\\n' '{}'; exit 0; fi\nif [ \"$3\" = '{}' ] || [ \"$3\" = '{}' ]; then printf '%s\\n' '[{{\"Labels\":null,\"CreatedAt\":\"original\"}}]'; exit 0; fi\nprintf '%s\\n' 'No such volume' >&2\nexit 1\n",
        log.display(),
        container,
        volumes.data,
        volumes.state
    );
    let staging = fixture.directory.path().join("fake-docker.staging");
    std::fs::write(&staging, script).unwrap();
    std::fs::set_permissions(&staging, std::fs::Permissions::from_mode(0o700)).unwrap();
    std::fs::rename(&staging, &binary).unwrap();
    crate::instance::storage::preflight_storage_with(
        &fixture.profile,
        Provider::Slm,
        false,
        &fixture.docker,
        &mut fixture.registry,
    )
    .await
    .unwrap();
    assert!(
        fixture
            .calls()
            .lines()
            .all(|line| line.starts_with("inspect ") || line.starts_with("volume inspect "))
    );
    drop(fixture.registry);
    fixture.profile.api_key = Some("amc_rotated".into());
    let registry = RuntimeStore::at(&fixture.directory.path().join("runtimes.json")).unwrap();
    assert_eq!(
        registry.selected_dataset(&fixture.profile).unwrap(),
        Some((Provider::Openai, StorageVolumes::legacy()))
    );
    assert_eq!(
        registry
            .identity(&fixture.profile, Provider::Openai)
            .unwrap()
            .unwrap()
            .data
            .as_deref(),
        Some("original")
    );
}
