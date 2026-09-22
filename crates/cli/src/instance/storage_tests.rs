//! Regression coverage for durable provider datasets, ownership, and lifecycle locks.

use crate::config::{ProfileKind, ResolvedProfile};
use crate::instance::docker::{ContainerInspect, ContainerState};
use crate::instance::storage::{ObservedStorage, Provider, RuntimeStore, StorageVolumes};

fn profile(project: &str, origin: &str) -> ResolvedProfile {
    ResolvedProfile {
        name: "local-test".into(),
        base_url: origin.into(),
        kind: ProfileKind::Cloud,
        project_id: Some(project.into()),
        memory_base_url: "http://127.0.0.1:18800".into(),
        api_key: Some("amc_test_credential".into()),
        oauth: None,
    }
}

fn legacy(profile: &ResolvedProfile, provider: Provider) -> ContainerInspect {
    ContainerInspect {
        name: "atomic-memory".into(),
        image: "example/core:fixture".into(),
        state: ContainerState::Running,
        managed_by_cli: true,
        profile_label: Some(profile.name.clone()),
        atomicmemory_api_url: Some(profile.base_url.clone()),
        cloud_jwks_url: None,
        core_api_key: None,
        atomicmemory_api_key: profile.api_key.clone(),
        local_url: Some(profile.memory_base_url.clone()),
        storage: Some(ObservedStorage {
            provider,
            volumes: StorageVolumes::legacy(),
            project_id: profile.project_id.clone(),
        }),
    }
}

#[test]
fn provider_switch_round_trip_reopens_the_original_datasets() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("runtimes.json");
    let profile = profile("project-one", "https://cloud.example.test");
    let mut store = RuntimeStore::at(&path).unwrap();
    let openai = store.select(&profile, Provider::Openai, None).unwrap();
    store.save().unwrap();
    drop(store);

    let mut store = RuntimeStore::at(&path).unwrap();
    let slm = store.select(&profile, Provider::Slm, None).unwrap();
    assert_ne!(openai.data, slm.data);
    assert_ne!(openai.state, slm.state);
    store.save().unwrap();
    drop(store);

    let mut store = RuntimeStore::at(&path).unwrap();
    assert_eq!(store.provider(&profile, None, None).unwrap(), Provider::Slm);
    assert_eq!(
        store.select(&profile, Provider::Openai, None).unwrap(),
        openai
    );
    store.save().unwrap();
    drop(store);
    let mut store = RuntimeStore::at(&path).unwrap();
    assert_eq!(
        store.provider(&profile, None, None).unwrap(),
        Provider::Openai
    );
    assert_eq!(store.select(&profile, Provider::Slm, None).unwrap(), slm);
}

#[test]
fn storage_is_isolated_by_project_and_cloud_origin() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = RuntimeStore::at(&directory.path().join("runtimes.json")).unwrap();
    let first = profile("project-one", "https://cloud.example.test");
    let second = profile("project-two", "https://cloud.example.test");
    let foreign = profile("project-one", "https://other.example.test");
    let first_volumes = store.select(&first, Provider::Slm, None).unwrap();
    for other in [&second, &foreign] {
        assert_eq!(store.provider(other, None, None).unwrap(), Provider::Openai);
        let volumes = store.select(other, Provider::Slm, None).unwrap();
        assert_ne!(first_volumes.data, volumes.data);
        assert_ne!(first_volumes.state, volumes.state);
    }
    let mut alias = profile("project-one", "https://cloud.example.test:443/api/");
    alias.name = "another-profile".into();
    assert_eq!(
        store.select(&alias, Provider::Slm, None).unwrap(),
        first_volumes
    );
}

#[test]
fn proven_legacy_dataset_survives_a_provider_switch() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("runtimes.json");
    let profile = profile("project-one", "https://cloud.example.test");
    let observed = legacy(&profile, Provider::Openai);
    let mut store = RuntimeStore::at(&path).unwrap();
    let slm = store
        .select(&profile, Provider::Slm, Some(&observed))
        .unwrap();
    assert_ne!(slm, StorageVolumes::legacy());
    store.save().unwrap();
    drop(store);
    let mut store = RuntimeStore::at(&path).unwrap();
    assert_eq!(
        store.select(&profile, Provider::Openai, None).unwrap(),
        StorageVolumes::legacy()
    );
    assert_eq!(store.select(&profile, Provider::Slm, None).unwrap(), slm);
}

#[test]
fn unknown_or_foreign_observations_never_adopt_legacy_volumes() {
    let profile = profile("project-one", "https://cloud.example.test");
    for variation in 0..7 {
        let directory = tempfile::tempdir().unwrap();
        let mut store = RuntimeStore::at(&directory.path().join("runtimes.json")).unwrap();
        let mut observed = legacy(&profile, Provider::Slm);
        match variation {
            0 => observed.managed_by_cli = false,
            1 => observed.profile_label = Some("someone-else".into()),
            2 => observed.atomicmemory_api_url = Some("https://foreign.example.test".into()),
            3 => observed.atomicmemory_api_url = None,
            4 => observed.storage.as_mut().unwrap().project_id = Some("foreign-project".into()),
            5 => observed.storage = None,
            6 => observed.profile_label = None,
            _ => unreachable!(),
        }
        assert_eq!(
            store.provider(&profile, None, Some(&observed)).unwrap(),
            Provider::Openai
        );
        let selected = store
            .select(&profile, Provider::Slm, Some(&observed))
            .unwrap();
        assert_ne!(
            selected,
            StorageVolumes::legacy(),
            "adopted unproven variant {variation}"
        );
    }
}

#[test]
fn legacy_without_project_label_requires_matching_cloud_credential() {
    let profile = profile("project-one", "https://cloud.example.test");
    for matches in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let mut store = RuntimeStore::at(&directory.path().join("runtimes.json")).unwrap();
        let mut observed = legacy(&profile, Provider::Slm);
        observed.storage.as_mut().unwrap().project_id = None;
        if !matches {
            observed.atomicmemory_api_key = Some("amc_foreign_credential".into());
        }
        let selected = store
            .select(&profile, Provider::Slm, Some(&observed))
            .unwrap();
        assert_eq!(selected == StorageVolumes::legacy(), matches);
    }
}

#[test]
fn corrupt_registry_is_rejected_without_overwriting_it() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("runtimes.json");
    let bytes = b"{broken-registry";
    std::fs::write(&path, bytes).unwrap();
    let error = RuntimeStore::at(&path)
        .err()
        .expect("corrupt registry must fail closed");
    assert!(
        error
            .to_string()
            .contains("invalid runtime storage registry")
    );
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
}

#[test]
fn lifecycle_lock_rejects_overlapping_operations_and_releases_on_drop() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("runtimes.json");
    let store = RuntimeStore::at(&path).unwrap();
    let error = RuntimeStore::at(&path)
        .err()
        .expect("second lifecycle operation must not race");
    assert!(
        error
            .to_string()
            .contains("another managed Core lifecycle command")
    );
    drop(store);
    assert!(RuntimeStore::at(&path).is_ok());
}

#[test]
fn invalid_observed_volume_names_are_never_persisted() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("runtimes.json");
    let profile = profile("project-one", "https://cloud.example.test");
    let mut observed = legacy(&profile, Provider::Openai);
    observed.storage.as_mut().unwrap().volumes.data = "../../foreign-data".into();
    let mut store = RuntimeStore::at(&path).unwrap();
    assert!(
        store
            .select(&profile, Provider::Slm, Some(&observed))
            .is_err()
    );
    assert!(!path.exists());
}

#[test]
fn a_legacy_dataset_already_claimed_by_another_project_cannot_be_adopted() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("runtimes.json");
    let first = profile("project-one", "https://cloud.example.test");
    let second = profile("project-two", "https://cloud.example.test");
    let mut store = RuntimeStore::at(&path).unwrap();
    let volumes = store
        .select(
            &first,
            Provider::Openai,
            Some(&legacy(&first, Provider::Openai)),
        )
        .unwrap();
    store.save().unwrap();
    drop(store);
    let mut store = RuntimeStore::at(&path).unwrap();
    let result = store.select(
        &second,
        Provider::Openai,
        Some(&legacy(&second, Provider::Openai)),
    );
    assert!(
        result.is_err(),
        "one dataset must never belong to two projects"
    );
    assert_eq!(
        store.select(&first, Provider::Openai, None).unwrap(),
        volumes
    );
}

#[test]
fn selected_dataset_lookup_never_claims_unseen_names() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("runtimes.json");
    let profile = profile("unseen-project", "https://cloud.example.test");
    let store = RuntimeStore::at(&path).unwrap();
    assert!(store.selected_dataset(&profile).unwrap().is_none());
    assert!(!path.exists());
}

#[test]
fn adopted_legacy_identity_survives_switching_and_reopening_registry() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("runtimes.json");
    let profile = profile("legacy-project", "https://cloud.example.test");
    let mut store = RuntimeStore::at(&path).unwrap();
    store
        .select(
            &profile,
            Provider::Slm,
            Some(&legacy(&profile, Provider::Openai)),
        )
        .unwrap();
    let identity = crate::instance::storage::StorageIdentity {
        data: Some("2026-01-01T00:00:00Z".into()),
        state: Some("2026-01-01T00:00:01Z".into()),
    };
    store
        .record_identity(
            &profile,
            Provider::Openai,
            &StorageVolumes::legacy(),
            identity.clone(),
        )
        .unwrap();
    store.save().unwrap();
    drop(store);
    let mut store = RuntimeStore::at(&path).unwrap();
    assert_eq!(
        store.identity(&profile, Provider::Openai).unwrap(),
        Some(&identity)
    );
    assert_eq!(
        store.select(&profile, Provider::Openai, None).unwrap(),
        StorageVolumes::legacy()
    );
}

#[test]
fn precredential_adoption_preserves_previous_selection_across_key_rotation() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("runtimes.json");
    let mut profile = profile("legacy-project", "https://cloud.example.test");
    let mut observed = legacy(&profile, Provider::Slm);
    observed.storage.as_mut().unwrap().project_id = None;
    let mut store = RuntimeStore::at(&path).unwrap();
    store.adopt_observed(&profile, Some(&observed)).unwrap();
    let identity = crate::instance::storage::StorageIdentity {
        data: Some("original-data".into()),
        state: Some("original-state".into()),
    };
    store
        .record_identity(
            &profile,
            Provider::Slm,
            &StorageVolumes::legacy(),
            identity.clone(),
        )
        .unwrap();
    store.save().unwrap();
    store
        .select(&profile, Provider::Openai, Some(&observed))
        .unwrap();
    drop(store);
    profile.api_key = Some("amc_rotated_key".into());
    let mut store = RuntimeStore::at(&path).unwrap();
    assert_eq!(
        store.provider(&profile, None, Some(&observed)).unwrap(),
        Provider::Slm
    );
    assert_eq!(
        store
            .select(&profile, Provider::Slm, Some(&observed))
            .unwrap(),
        StorageVolumes::legacy()
    );
    assert_eq!(
        store.identity(&profile, Provider::Slm).unwrap(),
        Some(&identity)
    );
}
