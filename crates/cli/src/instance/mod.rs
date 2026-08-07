//! Local Core instance lifecycle — Docker-backed operator surface.

use anyhow::Result;
use rand::Rng;

use crate::auth::origin::same_origin;
use crate::config::resolve_core_api_key;

pub mod docker;

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

/// Default API key name when auto-provisioning.
pub const AUTO_KEY_NAME: &str = "connected-local-runtime";

/// Path inside Core containers where the entrypoint persists `CORE_API_KEY`.
pub const CORE_STATE_KEY_PATH: &str = "/var/lib/atomicmemory/state/core-api-key";

/// Generate a fresh local Core bearer for first-run / `--purge-data` installs.
pub fn generate_core_api_key() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

/// Resolve the `CORE_API_KEY` to inject on `docker run` and use for health checks.
///
/// Precedence: shell override → persisted state file → container env → generate.
/// A new key is minted only when `purge_data` is true or no persisted/env key exists
/// (`--replace` alone must not rotate the local Core bearer).
pub async fn resolve_instance_core_api_key(
    docker: &dyn DockerRunner,
    purge_data: bool,
) -> Result<String> {
    if let Some(key) = resolve_core_api_key() {
        return Ok(key);
    }
    if !purge_data {
        if let Some(key) = docker.read_core_api_key(DEFAULT_CONTAINER_NAME).await? {
            return Ok(key);
        }
        if let Some(inspect) = docker.inspect(DEFAULT_CONTAINER_NAME).await?
            && let Some(key) = inspect.core_api_key
        {
            return Ok(key);
        }
    }
    Ok(generate_core_api_key())
}

/// True when a CLI-managed container was started for a different local profile.
pub fn managed_core_profile_mismatch(inspect: &ContainerInspect, profile_name: &str) -> bool {
    inspect.managed_by_cli && inspect.profile_label.as_deref() != Some(profile_name)
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
    match (
        inspect.atomicmemory_api_url.as_deref(),
        inspect.cloud_jwks_url.as_deref(),
    ) {
        (Some(api_url), Some(jwks_url)) => {
            api_url != expected_api_url || jwks_url != expected_jwks_url
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

/// Read `CORE_API_KEY` from the CLI-managed Core container when it matches `profile_name`.
pub async fn read_managed_core_api_key(
    profile_name: &str,
    destination_url: &str,
) -> Option<String> {
    let docker = RealDockerRunner::new();
    read_managed_core_api_key_with(&docker, profile_name, destination_url)
        .await
        .ok()
        .flatten()
}

pub async fn read_managed_core_api_key_with(
    docker: &dyn DockerRunner,
    profile_name: &str,
    destination_url: &str,
) -> Result<Option<String>> {
    let inspect = docker.inspect(DEFAULT_CONTAINER_NAME).await?;
    let Some(inspect) = inspect else {
        return Ok(None);
    };
    if !inspect.managed_by_cli || !inspect.state.is_running() {
        return Ok(None);
    }
    if inspect.profile_label.as_deref() != Some(profile_name) {
        return Ok(None);
    }
    let Some(ref local_url) = inspect.local_url else {
        return Ok(None);
    };
    if !same_origin(local_url, destination_url) {
        return Ok(None);
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
    fn cloud_env_matches_when_urls_align() {
        let inspect = inspect_with_profile(Some("default"));
        assert!(!managed_core_cloud_env_mismatch(
            &inspect,
            "https://api.dev.example.com",
            "https://api.dev.example.com/.well-known/atomic-core/jwks.json",
        ));
    }

    struct StubDocker {
        state_key: Option<String>,
        inspect: Option<ContainerInspect>,
    }

    #[async_trait::async_trait]
    impl DockerRunner for StubDocker {
        async fn version(&self) -> Result<()> {
            Ok(())
        }

        async fn inspect(&self, _name: &str) -> Result<Option<ContainerInspect>> {
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
            Ok(self.state_key.clone())
        }
    }

    fn managed_inspect_with_key(
        profile: &str,
        local_url: &str,
        core_api_key: Option<&str>,
    ) -> ContainerInspect {
        ContainerInspect {
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
    async fn resolve_reuses_persisted_key_without_purge() {
        let docker = StubDocker {
            state_key: Some("persisted-core-key".into()),
            inspect: None,
        };
        let key = resolve_instance_core_api_key(&docker, false).await.unwrap();
        assert_eq!(key, "persisted-core-key");
    }

    #[tokio::test]
    async fn resolve_generates_when_purge_data_even_if_persisted() {
        let docker = StubDocker {
            state_key: Some("persisted-core-key".into()),
            inspect: None,
        };
        let key = resolve_instance_core_api_key(&docker, true).await.unwrap();
        assert_ne!(key, "persisted-core-key");
        assert_eq!(key.len(), 64);
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
        };
        let key = read_managed_core_api_key_with(&docker, "default", "http://127.0.0.1:17350")
            .await
            .unwrap();
        assert_eq!(key.as_deref(), Some("core-from-state"));

        let mismatched =
            read_managed_core_api_key_with(&docker, "default", "http://127.0.0.1:9999")
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
        };
        let key = read_managed_core_api_key_with(&docker, "default", "http://127.0.0.1:17350")
            .await
            .unwrap();
        assert!(key.is_none());
    }
}
