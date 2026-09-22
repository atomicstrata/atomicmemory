//! Local Core instance lifecycle — Docker-backed operator surface.

use anyhow::Result;
use rand::Rng;

pub mod address;
pub mod credentials;
pub mod docker;
pub mod storage;

pub use docker::{ContainerInspect, DockerRunner, RealDockerRunner};

/// Canonical container name for CLI-managed Core.
pub const DEFAULT_CONTAINER_NAME: &str = "atomic-memory";

/// Managed-by label value.
pub const MANAGED_BY_LABEL: &str = "ai.atomicstrata.managed-by=am-cli";

/// Profile label prefix.
pub const PROFILE_LABEL_PREFIX: &str = "ai.atomicstrata.profile=";

/// Local Core URL label key (`ai.atomicstrata.local-url=<memory_base_url>`).
pub const LOCAL_URL_LABEL: &str = "ai.atomicstrata.local-url";

/// Named volumes persisted across container recreation.
pub const VOLUME_DATA: &str = "atomic-memory-data";
pub const VOLUME_STATE: &str = "atomic-memory-state";

/// Default health wait timeout (seconds).
pub const DEFAULT_WAIT_SECS: u64 = 60;

/// Poll interval while waiting for Core health.
pub const HEALTH_POLL_INTERVAL_SECS: u64 = 2;

/// Max stderr/log lines surfaced on failure.
pub const MAX_FAILURE_LOG_LINES: usize = 20;

/// Base API key name when auto-provisioning a per-installation credential.
pub const AUTO_KEY_NAME: &str = "connected-local-runtime";

/// Path inside Core containers where the entrypoint persists `CORE_API_KEY`.
pub const CORE_STATE_KEY_PATH: &str = "/var/lib/atomicmemory/state/core-api-key";

/// Generate a fresh local Core bearer for first-run / `--purge-data` installs.
pub fn generate_core_api_key() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

/// True when a CLI-managed container was started for a different local profile.
pub fn managed_core_profile_mismatch(inspect: &ContainerInspect, profile_name: &str) -> bool {
    inspect.managed_by_cli && inspect.profile_label.as_deref() != Some(profile_name)
}

/// Normalize Cloud API / JWKS endpoint strings the same way container env is written.
fn canonical_cloud_endpoint_url(url: &str) -> String {
    url.trim().trim_end_matches('/').to_string()
}

/// True when the running container still points Core at a different Cloud tier than the profile.
pub fn managed_core_cloud_env_mismatch(
    inspect: &ContainerInspect,
    expected_api_url: &str,
    expected_jwks_url: &str,
) -> bool {
    if !inspect.managed_by_cli {
        return false;
    }
    let expected_api = canonical_cloud_endpoint_url(expected_api_url);
    let expected_jwks = canonical_cloud_endpoint_url(expected_jwks_url);
    match (
        inspect.atomicmemory_api_url.as_deref(),
        inspect.cloud_jwks_url.as_deref(),
    ) {
        (Some(api_url), Some(jwks_url)) => {
            canonical_cloud_endpoint_url(api_url) != expected_api
                || canonical_cloud_endpoint_url(jwks_url) != expected_jwks
        }
        _ => true,
    }
}

/// Whether Core must be recreated so trace sync and JWT validation match the linked Cloud project.
pub async fn managed_core_needs_env_sync(
    docker: &dyn DockerRunner,
    profile_name: &str,
    profile_relinked: bool,
    expected_api_url: &str,
    expected_jwks_url: &str,
) -> Result<bool> {
    if profile_relinked {
        return Ok(true);
    }
    let Some(inspect) = docker.inspect(DEFAULT_CONTAINER_NAME).await? else {
        return Ok(false);
    };
    if !inspect.managed_by_cli {
        return Ok(false);
    }
    Ok(managed_core_profile_mismatch(&inspect, profile_name)
        || managed_core_cloud_env_mismatch(&inspect, expected_api_url, expected_jwks_url))
}

/// Read a managed Core key only for the resolved project's active dataset.
pub async fn read_managed_core_api_key(
    profile: &crate::config::ResolvedProfile,
) -> Result<Option<String>> {
    read_managed_core_api_key_with(&RealDockerRunner::new(), profile).await
}

/// Resolve the managed credential through the shared Cloud and dataset ownership gate.
pub async fn read_managed_core_api_key_with(
    docker: &dyn DockerRunner,
    profile: &crate::config::ResolvedProfile,
) -> Result<Option<String>> {
    read_managed_core_api_key_using(docker, profile, storage::RuntimeStore::open).await
}

async fn read_managed_core_api_key_using<F>(
    docker: &dyn DockerRunner,
    profile: &crate::config::ResolvedProfile,
    load_registry: F,
) -> Result<Option<String>>
where
    F: FnOnce() -> Result<storage::RuntimeStore>,
{
    // External Core destinations retain their explicit-key / Cloud JWT path.
    let Ok(destination) = address::ManagedAddress::parse(&profile.memory_base_url) else {
        return Ok(None);
    };
    // Keep inspection and key retrieval in the same lifecycle transaction.
    let registry = load_registry()?;
    let inspect = match docker.inspect(DEFAULT_CONTAINER_NAME).await {
        Ok(inspect) => inspect,
        Err(error)
            if error.chain().any(|cause| {
                cause
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|io| io.kind() == std::io::ErrorKind::NotFound)
            }) =>
        {
            return Ok(None);
        }
        Err(error) => return Err(error),
    };
    let Some(inspect) = inspect else {
        return Ok(None);
    };
    if !inspect.managed_by_cli || !inspect.state.is_running() {
        return Ok(None);
    }
    let bound = inspect
        .local_url
        .as_deref()
        .and_then(|url| address::ManagedAddress::parse(url).ok());
    if bound != Some(destination) {
        return Ok(None);
    }
    if !storage::matches_profile_context(profile, &inspect) {
        anyhow::bail!(
            "managed Core belongs to a different Cloud project or origin; run `am instance start --replace` before using this profile"
        );
    }
    let observed = inspect.storage.as_ref().ok_or_else(|| {
        anyhow::anyhow!(
            "managed Core provider and mounts could not be verified; administrator key withheld"
        )
    })?;
    if let Some((provider, volumes)) = registry.selected_dataset(profile)?
        && (provider != observed.provider || volumes != observed.volumes)
    {
        anyhow::bail!(
            "managed Core is still running a different dataset from the saved selection; finish `am instance start` before using this profile"
        );
    }
    let identity = registry.identity(profile, observed.provider)?;
    if let Some(identity) = identity {
        let mut config = docker::default_instance_config(&profile.name, &inspect.image);
        config.provider = observed.provider;
        config.storage = observed.volumes.clone();
        config.project_id = profile.project_id.clone();
        docker
            .validate_storage(&config, Some(identity), false)
            .await?;
    } else if storage::owned_storage(profile, Some(&inspect)).is_none() {
        anyhow::bail!(
            "managed Core project ownership could not be verified; administrator key withheld"
        );
    }
    if let Some(key) = docker.read_core_api_key(DEFAULT_CONTAINER_NAME).await? {
        return Ok(Some(key));
    }
    Ok(inspect.core_api_key)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::instance::docker::ContainerState;
    use anyhow::bail;

    fn inspect_with_profile(profile: Option<&str>) -> ContainerInspect {
        ContainerInspect {
            storage: None,
            name: DEFAULT_CONTAINER_NAME.into(),
            image: "test".into(),
            state: ContainerState::Running,
            managed_by_cli: true,
            profile_label: profile.map(str::to_string),
            local_url: Some("http://127.0.0.1:17350".into()),
            atomicmemory_api_url: Some("https://api.dev.example.com".into()),
            cloud_jwks_url: Some(
                "https://api.dev.example.com/.well-known/atomic-core/jwks.json".into(),
            ),
            core_api_key: None,
            atomicmemory_api_key: None,
        }
    }

    #[test]
    fn generate_core_api_key_is_non_empty_hex() {
        let key = generate_core_api_key();
        assert_eq!(key.len(), 64);
        assert!(key.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn profile_mismatch_when_labels_differ() {
        let inspect = inspect_with_profile(Some("atomic-strata-project"));
        assert!(managed_core_profile_mismatch(&inspect, "atomic-strata"));
    }

    #[test]
    fn profile_match_when_labels_equal() {
        let inspect = inspect_with_profile(Some("atomic-strata"));
        assert!(!managed_core_profile_mismatch(&inspect, "atomic-strata"));
    }

    #[test]
    fn foreign_container_is_not_a_mismatch() {
        let mut inspect = inspect_with_profile(Some("other"));
        inspect.managed_by_cli = false;
        assert!(!managed_core_profile_mismatch(&inspect, "atomic-strata"));
    }

    #[test]
    fn cloud_env_mismatch_when_api_url_differs() {
        let inspect = inspect_with_profile(Some("default"));
        assert!(managed_core_cloud_env_mismatch(
            &inspect,
            "https://api.staging.example.com",
            "https://api.staging.example.com/.well-known/atomic-core/jwks.json",
        ));
    }

    #[test]
    fn cloud_env_matches_when_only_trailing_slash_differs() {
        let inspect = inspect_with_profile(Some("default"));
        assert!(!managed_core_cloud_env_mismatch(
            &inspect,
            "https://api.dev.example.com/",
            "https://api.dev.example.com/.well-known/atomic-core/jwks.json/",
        ));
    }

    #[test]
    fn cloud_env_matches_when_urls_align() {
        let inspect = inspect_with_profile(Some("default"));
        assert!(!managed_core_cloud_env_mismatch(
            &inspect,
            "https://api.dev.example.com",
            "https://api.dev.example.com/.well-known/atomic-core/jwks.json",
        ));
    }

    #[derive(Default)]
    struct StubDocker {
        state_key: Option<String>,
        inspect: Option<ContainerInspect>,
        observed_identity: Option<storage::StorageIdentity>,
        inspect_lock_path: Option<std::path::PathBuf>,
        read_calls: std::sync::atomic::AtomicUsize,
    }

    #[async_trait::async_trait]
    impl DockerRunner for StubDocker {
        async fn version(&self) -> Result<()> {
            Ok(())
        }

        async fn inspect(&self, _name: &str) -> Result<Option<ContainerInspect>> {
            if let Some(path) = &self.inspect_lock_path {
                assert!(
                    storage::RuntimeStore::at(path).is_err(),
                    "inspection must happen while the lifecycle lock is held"
                );
            }
            Ok(self.inspect.clone())
        }

        async fn run(
            &self,
            _config: &docker::InstanceConfig,
            _env: &docker::InstanceEnv,
        ) -> Result<String> {
            bail!("not used")
        }

        async fn start(&self, _name: &str) -> Result<()> {
            bail!("not used")
        }

        async fn stop(&self, _name: &str) -> Result<()> {
            bail!("not used")
        }

        async fn rm_force(&self, _name: &str) -> Result<()> {
            bail!("not used")
        }

        async fn logs_tail(&self, _name: &str, _tail: u32) -> Result<String> {
            Ok(String::new())
        }

        async fn logs_follow(&self, _name: &str, _tail: u32) -> Result<()> {
            Ok(())
        }

        async fn volume_rm(&self, _name: &str) -> Result<()> {
            Ok(())
        }

        async fn read_core_api_key(&self, _name: &str) -> Result<Option<String>> {
            self.read_calls
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(self.state_key.clone())
        }
        async fn validate_storage(
            &self,
            config: &docker::InstanceConfig,
            recorded: Option<&storage::StorageIdentity>,
            live_legacy: bool,
        ) -> Result<storage::StorageIdentity> {
            assert!(
                !live_legacy,
                "rotated credentials require durable ownership proof"
            );
            assert_eq!(config.storage, storage::StorageVolumes::legacy());
            let actual = self
                .observed_identity
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("missing identity fixture"))?;
            if recorded != Some(actual) {
                bail!("legacy volume creation identity changed");
            }
            Ok(actual.clone())
        }
    }

    fn key_profile(destination: &str) -> crate::config::ResolvedProfile {
        crate::config::ResolvedProfile {
            name: "default".into(),
            base_url: "https://api.dev.example.com".into(),
            project_id: Some("project-one".into()),
            kind: crate::config::ProfileKind::Local,
            memory_base_url: destination.into(),
            api_key: Some("amc_current".into()),
            oauth: None,
        }
    }

    async fn read_test_key(
        docker: &dyn DockerRunner,
        profile: &crate::config::ResolvedProfile,
    ) -> Result<Option<String>> {
        let directory = tempfile::tempdir().unwrap();
        read_managed_core_api_key_using(docker, profile, || {
            storage::RuntimeStore::at(&directory.path().join("runtimes.json"))
        })
        .await
    }

    fn managed_inspect_with_key(
        profile: &str,
        local_url: &str,
        core_api_key: Option<&str>,
    ) -> ContainerInspect {
        ContainerInspect {
            storage: Some(storage::ObservedStorage {
                provider: storage::Provider::Openai,
                volumes: storage::StorageVolumes::legacy(),
                project_id: Some("project-one".into()),
            }),
            name: DEFAULT_CONTAINER_NAME.into(),
            image: "test".into(),
            state: ContainerState::Running,
            managed_by_cli: true,
            profile_label: Some(profile.into()),
            local_url: Some(local_url.into()),
            atomicmemory_api_url: Some("https://api.dev.example.com".into()),
            cloud_jwks_url: Some(
                "https://api.dev.example.com/.well-known/atomic-core/jwks.json".into(),
            ),
            atomicmemory_api_key: None,
            core_api_key: core_api_key.map(str::to_string),
        }
    }

    #[tokio::test]
    async fn read_managed_key_rejects_same_label_and_port_for_foreign_cloud_context() {
        for foreign_origin in [false, true] {
            let mut inspect = managed_inspect_with_key(
                "default",
                "http://127.0.0.1:17350",
                Some("outgoing-admin"),
            );
            inspect.storage = Some(storage::ObservedStorage {
                provider: storage::Provider::Openai,
                volumes: storage::StorageVolumes::legacy(),
                project_id: Some(
                    if foreign_origin {
                        "project-one"
                    } else {
                        "project-other"
                    }
                    .into(),
                ),
            });
            if foreign_origin {
                inspect.atomicmemory_api_url = Some("https://foreign.example.test".into());
            }
            let docker = StubDocker {
                state_key: Some("outgoing-admin".into()),
                inspect: Some(inspect),
                ..Default::default()
            };
            let result = read_test_key(&docker, &key_profile("http://127.0.0.1:17350")).await;
            assert!(
                result.is_err(),
                "foreign dataset leaked its administrator key"
            );
        }
    }

    #[tokio::test]
    async fn read_managed_key_requires_matching_local_url_label() {
        let docker = StubDocker {
            state_key: Some("core-from-state".into()),
            inspect: Some(managed_inspect_with_key(
                "default",
                "http://127.0.0.1:17350",
                None,
            )),
            ..Default::default()
        };
        let key = read_test_key(&docker, &key_profile("http://127.0.0.1:17350"))
            .await
            .unwrap();
        assert_eq!(key.as_deref(), Some("core-from-state"));

        let mismatched = read_test_key(&docker, &key_profile("http://127.0.0.1:9999"))
            .await
            .unwrap();
        assert!(mismatched.is_none());
    }

    #[tokio::test]
    async fn read_managed_key_withholds_when_local_url_label_missing() {
        let mut inspect = managed_inspect_with_key("default", "http://127.0.0.1:17350", None);
        inspect.local_url = None;
        let docker = StubDocker {
            state_key: Some("core-from-state".into()),
            inspect: Some(inspect),
            ..Default::default()
        };
        let key = read_test_key(&docker, &key_profile("http://127.0.0.1:17350"))
            .await
            .unwrap();
        assert!(key.is_none());
    }
    #[tokio::test]
    async fn read_managed_key_rejects_outgoing_provider_or_mapping_after_failed_switch() {
        for requested in [storage::Provider::Slm, storage::Provider::Openai] {
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join("runtimes.json");
            let profile = key_profile("http://127.0.0.1:17350");
            let mut registry = storage::RuntimeStore::at(&path).unwrap();
            registry.select(&profile, requested, None).unwrap();
            registry.save().unwrap();
            drop(registry);
            let docker = StubDocker {
                state_key: Some("outgoing-admin".into()),
                inspect: Some(managed_inspect_with_key(
                    "default",
                    &profile.memory_base_url,
                    Some("outgoing-env-admin"),
                )),
                ..Default::default()
            };
            let result = read_managed_core_api_key_using(&docker, &profile, || {
                storage::RuntimeStore::at(&path)
            })
            .await;
            assert!(
                result.is_err(),
                "saved selection mismatch must withhold both state and env keys"
            );
            assert_eq!(
                docker.read_calls.load(std::sync::atomic::Ordering::SeqCst),
                0
            );
        }
    }

    #[tokio::test]
    async fn read_managed_key_requires_unchanged_legacy_identity_after_cloud_key_rotation() {
        for recreated in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join("runtimes.json");
            let mut profile = key_profile("http://127.0.0.1:17350");
            let mut inspect = managed_inspect_with_key("default", &profile.memory_base_url, None);
            inspect.storage.as_mut().unwrap().project_id = None;
            inspect.atomicmemory_api_key = profile.api_key.clone();
            let identity = storage::StorageIdentity {
                data: Some("created-data".into()),
                state: Some("created-state".into()),
            };
            let mut registry = storage::RuntimeStore::at(&path).unwrap();
            let volumes = registry
                .select(&profile, storage::Provider::Openai, Some(&inspect))
                .unwrap();
            registry
                .record_identity(
                    &profile,
                    storage::Provider::Openai,
                    &volumes,
                    identity.clone(),
                )
                .unwrap();
            registry.save().unwrap();
            drop(registry);
            profile.api_key = Some("amc_rotated".into());
            let mut actual = identity;
            if recreated {
                actual.state = Some("different-creation".into());
            }
            let docker = StubDocker {
                state_key: Some("retained-admin".into()),
                inspect: Some(inspect),
                observed_identity: Some(actual),
                ..Default::default()
            };
            let result = read_managed_core_api_key_using(&docker, &profile, || {
                storage::RuntimeStore::at(&path)
            })
            .await;
            if recreated {
                assert!(result.is_err());
            } else {
                assert_eq!(result.unwrap().as_deref(), Some("retained-admin"));
            }
            assert_eq!(
                docker.read_calls.load(std::sync::atomic::Ordering::SeqCst),
                usize::from(!recreated)
            );
        }
    }

    #[tokio::test]
    async fn read_managed_key_holds_lifecycle_lock_before_inspecting_container() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("runtimes.json");
        let docker = StubDocker {
            inspect_lock_path: Some(path.clone()),
            ..Default::default()
        };
        let profile = key_profile("http://127.0.0.1:17350");
        let result =
            read_managed_core_api_key_using(&docker, &profile, || storage::RuntimeStore::at(&path))
                .await
                .unwrap();
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn read_managed_key_keeps_external_and_missing_docker_paths_available() {
        let docker = StubDocker::default();
        let profile = key_profile("https://external-core.example.test");
        let result = read_managed_core_api_key_using(&docker, &profile, || {
            panic!("external Core must not load managed state")
        })
        .await
        .unwrap();
        assert!(result.is_none());
        let directory = tempfile::tempdir().unwrap();
        let missing = RealDockerRunner {
            docker_bin: directory
                .path()
                .join("missing-docker")
                .to_string_lossy()
                .into_owned(),
        };
        let profile = key_profile("http://127.0.0.1:17350");
        let result = read_managed_core_api_key_using(&missing, &profile, || {
            storage::RuntimeStore::at(&directory.path().join("runtimes.json"))
        })
        .await
        .unwrap();
        assert!(result.is_none());
    }
}

/// Validate known prerequisites before provisioning Cloud resources or downloading models.
pub async fn preflight_managed(
    local_url: Option<&str>,
    provider: Option<storage::Provider>,
    interactive: bool,
) -> Result<()> {
    if let Some(url) = local_url {
        address::ManagedAddress::parse(url)?;
    }
    if provider == Some(storage::Provider::Slm) && crate::slm::current_target().is_none() {
        anyhow::bail!("Connected Local SLM requires Apple Silicon macOS");
    }
    docker::ensure_docker_available_with_preflight(&RealDockerRunner::new(), interactive).await
}

/// Pick the shared smoke mode from the selected provider, including saved selections.
pub async fn smoke_options(
    profile: &crate::config::ResolvedProfile,
) -> Result<crate::verification::smoke::SmokeOptions> {
    if profile.kind != crate::config::ProfileKind::Local {
        return Ok(Default::default());
    }
    let observed = RealDockerRunner::new()
        .inspect(DEFAULT_CONTAINER_NAME)
        .await?;
    let provider = storage::RuntimeStore::open()?.provider(profile, None, observed.as_ref())?;
    Ok(if provider == storage::Provider::Slm {
        crate::verification::smoke::SmokeOptions::full_extraction()
    } else {
        Default::default()
    })
}

#[cfg(test)]
mod storage_tests;
