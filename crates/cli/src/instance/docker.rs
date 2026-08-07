//! Docker subprocess adapter for CLI-managed Core instances.

use std::collections::HashMap;
use std::fmt::Debug;
use std::process::Stdio;

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use tokio::process::Command;
use tracing::instrument;

use super::{
    DEFAULT_CONTAINER_NAME, LOCAL_URL_LABEL, MANAGED_BY_LABEL, PROFILE_LABEL_PREFIX, VOLUME_DATA,
    VOLUME_STATE,
};
use crate::environment::{cloud_tier_from_api_url, image_has_registry};

/// Runtime configuration for a managed Core container.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstanceConfig {
    pub container_name: String,
    pub image: String,
    pub host_port: u16,
    pub profile_name: String,
    /// Published local Core URL baked into container labels for origin binding.
    pub local_url: String,
}

/// Environment variables forwarded to `docker run` (values via child env, not argv).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstanceEnv {
    pub openai_api_key: String,
    pub atomicmemory_api_key: String,
    pub atomicmemory_api_url: String,
    pub cloud_jwks_url: String,
    /// Explicit operator override forwarded as `CORE_API_KEY` (omit for Core auto-generation).
    pub core_api_key: Option<String>,
}

/// Map a Cloud API base URL to Core's `CLOUD_ENV` tier label.
///
/// Core's entrypoint defaults `CLOUD_ENV` to `dev` and derives `CLOUD_JWT_ISSUER`
/// from that tier. When the CLI already points `ATOMICMEMORY_API_URL` /
/// `CLOUD_JWKS_URL` at staging/prod, omitting `CLOUD_ENV` leaves issuer on
/// `api.dev…` and Cloud-minted JWTs fail with 401.
/// Docker CLI wording varies: "No such object", "No such container", "not found".
pub(crate) fn inspect_stderr_means_missing(stderr: &str) -> bool {
    let s = stderr.to_ascii_lowercase();
    s.contains("no such object") || s.contains("no such container") || s.contains("not found")
}

impl InstanceEnv {
    /// Env var names passed to Docker — values live in the child process environment.
    pub fn docker_env_names(&self) -> Vec<&'static str> {
        let mut names = vec![
            "OPENAI_API_KEY",
            "ATOMICMEMORY_API_KEY",
            "ATOMICMEMORY_API_URL",
            "CLOUD_TRACE_SYNC_ENABLED",
            "CLOUD_JWKS_URL",
            "CLOUD_ENV",
            "CLOUD_JWT_ISSUER",
            "CLOUD_JWT_AUDIENCE",
        ];
        if self.core_api_key.is_some() {
            names.push("CORE_API_KEY");
        }
        names
    }

    /// Build child-process env map for docker run (secrets never in argv).
    pub fn as_child_env(&self) -> HashMap<String, String> {
        let api_url = self
            .atomicmemory_api_url
            .trim()
            .trim_end_matches('/')
            .to_string();
        let mut env = HashMap::new();
        env.insert("OPENAI_API_KEY".into(), self.openai_api_key.clone());
        env.insert(
            "ATOMICMEMORY_API_KEY".into(),
            self.atomicmemory_api_key.clone(),
        );
        env.insert("ATOMICMEMORY_API_URL".into(), api_url.clone());
        env.insert("CLOUD_TRACE_SYNC_ENABLED".into(), "true".into());
        env.insert("CLOUD_JWKS_URL".into(), self.cloud_jwks_url.clone());
        // Issuer must match Cloud-minted JWT `iss` (the profile base URL), not the
        // entrypoint's CLOUD_ENV-derived default when URLs were already overridden.
        env.insert("CLOUD_ENV".into(), cloud_tier_from_api_url(&api_url).into());
        env.insert("CLOUD_JWT_ISSUER".into(), api_url);
        env.insert("CLOUD_JWT_AUDIENCE".into(), "atomicmemory-core".into());
        if let Some(ref key) = self.core_api_key {
            env.insert("CORE_API_KEY".into(), key.clone());
        }
        env
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ContainerState {
    Running,
    Exited,
    Created,
    Paused,
    Restarting,
    Dead,
    Unknown,
}

impl ContainerState {
    pub fn from_docker(s: &str) -> Self {
        match s {
            "running" => Self::Running,
            "exited" => Self::Exited,
            "created" => Self::Created,
            "paused" => Self::Paused,
            "restarting" => Self::Restarting,
            "dead" => Self::Dead,
            _ => Self::Unknown,
        }
    }

    pub fn is_running(&self) -> bool {
        matches!(self, Self::Running)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContainerInspect {
    pub name: String,
    pub image: String,
    pub state: ContainerState,
    pub managed_by_cli: bool,
    pub profile_label: Option<String>,
    /// Cloud API base URL baked into the container at `docker run` time.
    pub atomicmemory_api_url: Option<String>,
    /// JWKS URL Core uses to verify Cloud-minted local-core JWTs.
    pub cloud_jwks_url: Option<String>,
    /// `CORE_API_KEY` baked into the container env at `docker run` time.
    pub core_api_key: Option<String>,
    /// `ATOMICMEMORY_API_KEY` baked into the container env at `docker run` time.
    /// Compared against the desired key so a rotation interrupted before
    /// recreation is repaired on the next run instead of persisting silently.
    pub atomicmemory_api_key: Option<String>,
    /// Local Core URL label from `docker run` (`ai.atomicstrata.local-url`).
    pub local_url: Option<String>,
}

struct InspectedEnv {
    api_url: Option<String>,
    jwks_url: Option<String>,
    core_api_key: Option<String>,
    /// Cloud key the RUNNING container is actually using.
    ///
    /// Needed to compare observed state against desired state. Whether a
    /// container must be recreated after a key rotation was decided by an
    /// in-memory outcome, so an interrupted run left the container holding an
    /// invalidated key while the next run probed the newly stored key, saw it
    /// work, and reported "already running".
    atomicmemory_api_key: Option<String>,
}

fn env_from_docker_inspect(env: Option<&[String]>) -> InspectedEnv {
    let mut parsed = InspectedEnv {
        api_url: None,
        jwks_url: None,
        core_api_key: None,
        atomicmemory_api_key: None,
    };
    for entry in env.unwrap_or(&[]) {
        if let Some(value) = entry.strip_prefix("ATOMICMEMORY_API_URL=") {
            parsed.api_url = Some(value.to_string());
        } else if let Some(value) = entry.strip_prefix("CLOUD_JWKS_URL=") {
            parsed.jwks_url = Some(value.to_string());
        } else if let Some(value) = entry.strip_prefix("CORE_API_KEY=") {
            parsed.core_api_key = Some(value.to_string());
        } else if let Some(value) = entry.strip_prefix("ATOMICMEMORY_API_KEY=") {
            parsed.atomicmemory_api_key = Some(value.to_string());
        }
    }
    parsed
}

/// Build the config for the managed container.
///
/// `local_url` is DERIVED from the port we actually publish, never accepted
/// from the caller. It becomes the `ai.atomicstrata.local-url` label, and
/// `read_managed_core_api_key_with` decides whether to hand over the container's
/// Core key by comparing a request destination against that label.
///
/// Taking it from `profile.memory_base_url` made that check circular: the
/// profile's local URL comes from the Cloud API's `project.local_url`, so a
/// profile pointed at an attacker host produced a container that still bound
/// 127.0.0.1 but was LABELLED with the attacker origin, and the guard compared
/// that origin against itself and passed. A label describing what we published
/// is the only version that can authenticate a destination.
/// Host interface the managed container publishes on.
pub const DEFAULT_BIND_HOST: &str = "127.0.0.1";
/// Host port the managed container publishes on.
pub const DEFAULT_HOST_PORT: u16 = 17350;

pub fn default_instance_config(profile_name: &str, image: &str) -> InstanceConfig {
    InstanceConfig {
        container_name: DEFAULT_CONTAINER_NAME.to_string(),
        image: image.to_string(),
        host_port: DEFAULT_HOST_PORT,
        profile_name: profile_name.to_string(),
        local_url: managed_core_local_url(),
    }
}

/// The URL the managed container is actually reachable at, derived from the
/// same constants that build the `docker run -p` binding.
///
/// Anything that authenticates against the managed container - the startup
/// health probe included - must target this, never `profile.memory_base_url`:
/// the profile's local URL comes from the Cloud API's `project.local_url`, so
/// probing it sends the bootstrap Core key as a bearer to whatever host the
/// project record names.
pub fn managed_core_local_url() -> String {
    format!("http://{DEFAULT_BIND_HOST}:{DEFAULT_HOST_PORT}")
}

/// Build argv for `docker run` — secrets must NOT appear in argv.
pub fn build_run_argv(config: &InstanceConfig, env: &InstanceEnv) -> Vec<String> {
    let bind = format!(
        "{DEFAULT_BIND_HOST}:{}:{}",
        config.host_port, config.host_port
    );
    let mut argv = vec!["run".into(), "-d".into()];
    if image_has_registry(&config.image) {
        argv.push("--pull".into());
        argv.push("always".into());
    }
    argv.extend([
        "--name".into(),
        config.container_name.clone(),
        "--restart".into(),
        "unless-stopped".into(),
        "-p".into(),
        bind,
        "-v".into(),
        format!("{VOLUME_DATA}:/var/lib/atomicmemory/postgres"),
        "-v".into(),
        format!("{VOLUME_STATE}:/var/lib/atomicmemory/state"),
        "--label".into(),
        MANAGED_BY_LABEL.into(),
        "--label".into(),
        format!("{PROFILE_LABEL_PREFIX}{}", config.profile_name),
        "--label".into(),
        format!("{LOCAL_URL_LABEL}={}", config.local_url),
    ]);
    for name in env.docker_env_names() {
        argv.push("--env".into());
        argv.push(name.into());
    }
    argv.push(config.image.clone());
    argv
}

/// Truncate multi-line output to the last N lines.
pub fn tail_lines(text: &str, max_lines: usize) -> String {
    let lines: Vec<&str> = text.lines().collect();
    if lines.len() <= max_lines {
        return text.trim_end().to_string();
    }
    lines[lines.len() - max_lines..].join("\n")
}

/// Operator-facing install links when Docker is missing (Jul 20 OSS demo decision).
pub fn docker_install_links() -> &'static str {
    "Install Docker:\n\
     • macOS / Windows: https://docs.docker.com/desktop/\n\
     • Linux Engine: https://docs.docker.com/engine/install/\n\
     Then run `docker version` to confirm the daemon is running."
}

/// Fail fast when Docker CLI/daemon is unavailable (used by `am init` preflight).
pub async fn ensure_docker_available(docker: &dyn DockerRunner) -> Result<()> {
    docker.version().await
}

#[async_trait::async_trait]
pub trait DockerRunner: Send + Sync {
    async fn version(&self) -> Result<()>;
    async fn inspect(&self, name: &str) -> Result<Option<ContainerInspect>>;
    async fn run(&self, config: &InstanceConfig, env: &InstanceEnv) -> Result<String>;
    async fn start(&self, name: &str) -> Result<()>;
    async fn stop(&self, name: &str) -> Result<()>;
    async fn rm_force(&self, name: &str) -> Result<()>;
    async fn logs_tail(&self, name: &str, tail: u32) -> Result<String>;
    async fn logs_follow(&self, name: &str, tail: u32) -> Result<()>;
    async fn volume_rm(&self, name: &str) -> Result<()>;
    /// Read Core's persisted local client key from the state volume (secrets not in argv).
    async fn read_core_api_key(&self, name: &str) -> Result<Option<String>>;
}

/// Real Docker CLI runner via `tokio::process::Command`.
pub struct RealDockerRunner {
    pub docker_bin: String,
}

impl RealDockerRunner {
    pub fn new() -> Self {
        Self {
            docker_bin: "docker".to_string(),
        }
    }

    async fn exec_capture(
        &self,
        args: &[&str],
        child_env: Option<&HashMap<String, String>>,
    ) -> Result<(i32, String, String)> {
        let mut cmd = Command::new(&self.docker_bin);
        cmd.args(args);
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());
        if let Some(env) = child_env {
            for (k, v) in env {
                cmd.env(k, v);
            }
        }
        let output = cmd
            .output()
            .await
            .with_context(|| format!("spawn docker {}", args.join(" ")))?;
        let code = output.status.code().unwrap_or(-1);
        let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
        let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
        Ok((code, stdout, stderr))
    }

    async fn exec_inherit(&self, args: &[&str]) -> Result<i32> {
        let output = Command::new(&self.docker_bin)
            .args(args)
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .output()
            .await
            .with_context(|| format!("spawn docker {}", args.join(" ")))?;
        Ok(output.status.code().unwrap_or(-1))
    }
}

impl Default for RealDockerRunner {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait::async_trait]
impl DockerRunner for RealDockerRunner {
    #[instrument(skip(self))]
    async fn version(&self) -> Result<()> {
        let (code, _, stderr) = self.exec_capture(&["version"], None).await?;
        if code != 0 {
            bail!(
                "docker is not available or the daemon is not running\n{stderr}\n\
                 {install_links}",
                install_links = docker_install_links()
            );
        }
        Ok(())
    }

    #[instrument(skip(self), fields(container = name))]
    async fn inspect(&self, name: &str) -> Result<Option<ContainerInspect>> {
        let (code, stdout, stderr) = self
            .exec_capture(&["inspect", "--type", "container", name], None)
            .await?;
        if code != 0 {
            if inspect_stderr_means_missing(&stderr) {
                return Ok(None);
            }
            tracing::warn!(%stderr, "docker inspect failed");
            return Ok(None);
        }
        let entries: Vec<InspectEntry> =
            serde_json::from_str(stdout.trim()).context("parse docker inspect JSON")?;
        let entry = entries
            .into_iter()
            .next()
            .ok_or_else(|| anyhow::anyhow!("docker inspect returned empty array for '{name}'"))?;
        let labels = entry.config.labels.unwrap_or_default();
        let managed = labels
            .get("ai.atomicstrata.managed-by")
            .map(|v| v == "am-cli")
            .unwrap_or(false);
        let profile_label = labels.get("ai.atomicstrata.profile").cloned();
        let local_url = labels.get(LOCAL_URL_LABEL).cloned();
        let env = env_from_docker_inspect(entry.config.env.as_deref());
        Ok(Some(ContainerInspect {
            name: name.to_string(),
            image: entry.config.image,
            state: ContainerState::from_docker(&entry.state.status),
            managed_by_cli: managed,
            profile_label,
            atomicmemory_api_url: env.api_url,
            cloud_jwks_url: env.jwks_url,
            core_api_key: env.core_api_key,
            atomicmemory_api_key: env.atomicmemory_api_key,
            local_url,
        }))
    }

    #[instrument(skip(self, config, env), fields(container = %config.container_name, image = %config.image))]
    async fn run(&self, config: &InstanceConfig, env: &InstanceEnv) -> Result<String> {
        let argv_strings = build_run_argv(config, env);
        let argv: Vec<&str> = argv_strings.iter().map(String::as_str).collect();
        let child_env = env.as_child_env();
        let (code, stdout, stderr) = self.exec_capture(&argv, Some(&child_env)).await?;
        if code != 0 {
            let excerpt = tail_lines(&stderr, super::MAX_FAILURE_LOG_LINES);
            if excerpt.contains("already in use") {
                let name = &config.container_name;
                bail!(
                    "container name '{name}' is already taken (often a manual `docker run --name {name}`).\n\
                     Remove it: docker rm -f {name}\n\
                     Or if it was created by `am instance`, run: am instance start --replace\n\
                     {excerpt}"
                );
            }
            if excerpt.contains("401 Unauthorized")
                || excerpt.contains("403 Forbidden")
                || excerpt.contains("denied")
            {
                bail!(
                    "docker run failed pulling {image} (exit {code})\n\
                     Private GHCR images require authentication:\n\
                       docker login ghcr.io\n\
                     {excerpt}",
                    image = config.image
                );
            }
            bail!("docker run failed (exit {code})\n{excerpt}");
        }
        Ok(stdout.trim().to_string())
    }

    #[instrument(skip(self), fields(container = name))]
    async fn start(&self, name: &str) -> Result<()> {
        let (code, _, stderr) = self.exec_capture(&["start", name], None).await?;
        if code != 0 {
            bail!("docker start failed: {stderr}");
        }
        Ok(())
    }

    #[instrument(skip(self), fields(container = name))]
    async fn stop(&self, name: &str) -> Result<()> {
        let (code, _, stderr) = self.exec_capture(&["stop", name], None).await?;
        if code != 0 && !stderr.contains("No such container") {
            bail!("docker stop failed: {stderr}");
        }
        Ok(())
    }

    #[instrument(skip(self), fields(container = name))]
    async fn rm_force(&self, name: &str) -> Result<()> {
        let (code, _, stderr) = self.exec_capture(&["rm", "-f", name], None).await?;
        if code != 0 && !stderr.contains("No such container") {
            bail!("docker rm failed: {stderr}");
        }
        Ok(())
    }

    #[instrument(skip(self), fields(container = name))]
    async fn logs_tail(&self, name: &str, tail: u32) -> Result<String> {
        let tail_s = tail.to_string();
        let (code, stdout, stderr) = self
            .exec_capture(&["logs", "--tail", &tail_s, name], None)
            .await?;
        if code != 0 {
            bail!("docker logs failed: {stderr}");
        }
        Ok(stdout)
    }

    #[instrument(skip(self), fields(container = name))]
    async fn logs_follow(&self, name: &str, tail: u32) -> Result<()> {
        let tail_s = tail.to_string();
        let code = self
            .exec_inherit(&["logs", "--follow", "--tail", &tail_s, name])
            .await?;
        if code != 0 {
            bail!("docker logs --follow exited with code {code}");
        }
        Ok(())
    }

    #[instrument(skip(self), fields(volume = name))]
    async fn volume_rm(&self, name: &str) -> Result<()> {
        let (code, _, stderr) = self.exec_capture(&["volume", "rm", name], None).await?;
        if code != 0 && !stderr.contains("No such volume") {
            bail!("docker volume rm failed: {stderr}");
        }
        Ok(())
    }

    #[instrument(skip(self), fields(container = name))]
    async fn read_core_api_key(&self, name: &str) -> Result<Option<String>> {
        let (code, stdout, stderr) = self
            .exec_capture(&["exec", name, "cat", super::CORE_STATE_KEY_PATH], None)
            .await?;
        if code != 0 {
            if stderr.contains("No such container")
                || stderr.contains("is not running")
                || stderr.contains("No such file")
            {
                return Ok(None);
            }
            tracing::warn!(%stderr, "docker exec read core-api-key failed");
            return Ok(None);
        }
        let key = stdout.trim().to_string();
        if key.is_empty() {
            return Ok(None);
        }
        Ok(Some(key))
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct InspectEntry {
    #[serde(default)]
    state: InspectState,
    #[serde(default)]
    config: InspectConfig,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "PascalCase")]
struct InspectState {
    #[serde(default)]
    status: String,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "PascalCase")]
struct InspectConfig {
    #[serde(default)]
    image: String,
    #[serde(default)]
    labels: Option<HashMap<String, String>>,
    #[serde(default)]
    env: Option<Vec<String>>,
}

#[cfg(test)]
mod tests {

    /// The container's live Cloud key must be observable, so a run can compare
    /// desired state against actual state.
    ///
    /// The defect: whether to recreate after a key rotation was decided by an
    /// in-memory outcome. If a rotation stored the new key and the process died
    /// before Docker recreation, the next run probed the newly stored key, saw
    /// it work, reported `Reused`, and left the container running the
    /// invalidated one. It looked healthy, Cloud calls failed, and re-running
    /// could not repair it because nothing compared the two.
    #[test]
    fn the_containers_live_cloud_key_is_observable() {
        let env = vec![
            "ATOMICMEMORY_API_KEY=amc_the_key_actually_running".into(),
            "CORE_API_KEY=local-core-key".into(),
        ];
        let parsed = super::env_from_docker_inspect(Some(&env));

        assert_eq!(
            parsed.atomicmemory_api_key.as_deref(),
            Some("amc_the_key_actually_running"),
            "without this, desired-vs-actual cannot be computed at all",
        );
        assert_eq!(parsed.core_api_key.as_deref(), Some("local-core-key"));
    }

    #[test]
    fn a_container_without_a_cloud_key_reports_none() {
        let parsed = super::env_from_docker_inspect(Some(&["CORE_API_KEY=x".to_string()]));
        assert!(
            parsed.atomicmemory_api_key.is_none(),
            "absent must be distinguishable from present-but-different",
        );
    }

    /// The origin label must describe what we published, not what a profile
    /// claimed.
    ///
    /// The defect: the label came from `profile.memory_base_url`, which derives
    /// from the Cloud API's `project.local_url`. `read_managed_core_api_key_with`
    /// then compared a request destination against that same self-attested
    /// value, so a profile pointed at an attacker host produced a container
    /// still bound to 127.0.0.1 but labelled with the attacker origin - and the
    /// guard compared the origin against itself and passed, handing over the
    /// container's Core key.
    #[test]
    fn the_local_url_label_describes_the_real_binding() {
        let config = default_instance_config("any-profile", DEV_IMAGE);

        assert_eq!(
            config.local_url,
            format!("http://{DEFAULT_BIND_HOST}:{DEFAULT_HOST_PORT}"),
            "the label must be derived from the published port",
        );

        let env = InstanceEnv {
            openai_api_key: "sk-test".into(),
            atomicmemory_api_key: "amc_test".into(),
            atomicmemory_api_url: "https://api.atomicstrata.ai".into(),
            cloud_jwks_url: "https://api.atomicstrata.ai/.well-known/jwks.json".into(),
            core_api_key: None,
        };
        let argv = build_run_argv(&config, &env);
        let bind = format!("{DEFAULT_BIND_HOST}:{DEFAULT_HOST_PORT}:{DEFAULT_HOST_PORT}");
        assert!(
            argv.contains(&bind),
            "the label and the actual -p binding must agree; argv: {argv:?}",
        );
    }

    /// There is no caller-supplied path back in: the profile cannot influence
    /// the label at all, whatever it is set to.
    #[test]
    fn the_label_is_identical_regardless_of_profile() {
        let a = default_instance_config("profile-a", DEV_IMAGE);
        let b = default_instance_config("profile-b", PROD_IMAGE);
        assert_eq!(a.local_url, b.local_url);
    }
    use super::*;
    use crate::environment::Environment;

    const DEV_IMAGE: &str = "ghcr.io/atomicstrata/atomicmemory-core:test";
    const PROD_IMAGE: &str = Environment::PROD_CORE_IMAGE;

    #[test]
    fn env_from_docker_inspect_parses_cloud_urls() {
        let env = vec![
            "OPENAI_API_KEY=sk-test".into(),
            "ATOMICMEMORY_API_URL=https://api.staging.example.com".into(),
            "CLOUD_JWKS_URL=https://api.staging.example.com/.well-known/atomic-core/jwks.json"
                .into(),
        ];
        let parsed = super::env_from_docker_inspect(Some(&env));
        let (api_url, jwks_url, core_key) = (parsed.api_url, parsed.jwks_url, parsed.core_api_key);
        assert_eq!(api_url.as_deref(), Some("https://api.staging.example.com"));
        assert_eq!(
            jwks_url.as_deref(),
            Some("https://api.staging.example.com/.well-known/atomic-core/jwks.json")
        );
        assert!(core_key.is_none());
    }

    #[test]
    fn env_from_docker_inspect_parses_core_api_key() {
        let env = vec!["CORE_API_KEY=generated-local-key".into()];
        let core_key = super::env_from_docker_inspect(Some(&env)).core_api_key;
        assert_eq!(core_key.as_deref(), Some("generated-local-key"));
    }

    #[test]
    fn cloud_tier_from_api_url_maps_known_hosts() {
        assert_eq!(
            cloud_tier_from_api_url("https://api.dev.example.com"),
            "custom"
        );
        assert_eq!(
            cloud_tier_from_api_url("https://api.staging.example.com/"),
            "custom"
        );
        assert_eq!(
            cloud_tier_from_api_url("https://api.atomicstrata.ai"),
            "production"
        );
        assert_eq!(cloud_tier_from_api_url("http://127.0.0.1:8080"), "custom");
    }

    #[test]
    fn inspect_stderr_means_missing_covers_docker_phrasings() {
        assert!(inspect_stderr_means_missing(
            "Error: No such container: atomic-memory"
        ));
        assert!(inspect_stderr_means_missing(
            "Error: No such object: container"
        ));
        assert!(inspect_stderr_means_missing("not found"));
        assert!(!inspect_stderr_means_missing("permission denied"));
    }

    #[test]
    fn instance_env_forwards_jwt_issuer_matching_api_url() {
        let env = InstanceEnv {
            openai_api_key: "sk-test".into(),
            atomicmemory_api_key: "amc_test".into(),
            atomicmemory_api_url: "https://api.staging.example.com/".into(),
            cloud_jwks_url: "https://api.staging.example.com/.well-known/atomic-core/jwks.json"
                .into(),
            core_api_key: None,
        };
        let child = env.as_child_env();
        assert_eq!(child.get("CLOUD_ENV").map(String::as_str), Some("custom"));
        assert_eq!(
            child.get("CLOUD_JWT_ISSUER").map(String::as_str),
            Some("https://api.staging.example.com")
        );
        assert_eq!(
            child.get("CLOUD_JWT_AUDIENCE").map(String::as_str),
            Some("atomicmemory-core")
        );
        let names = env.docker_env_names();
        assert!(names.contains(&"CLOUD_ENV"));
        assert!(names.contains(&"CLOUD_JWT_ISSUER"));
        assert!(names.contains(&"CLOUD_JWT_AUDIENCE"));
    }

    #[test]
    fn inspect_json_parses_docker_pascal_case() {
        let raw = r#"[{
            "State": {"Status": "running"},
            "Config": {
                "Image": "atomicmemory-core:local-runtime-test",
                "Labels": {
                    "ai.atomicstrata.managed-by": "am-cli",
                    "ai.atomicstrata.profile": "default"
                },
                "Env": [
                    "ATOMICMEMORY_API_URL=https://api.staging.example.com",
                    "CLOUD_JWKS_URL=https://api.staging.example.com/.well-known/atomic-core/jwks.json"
                ]
            }
        }]"#;
        let entries: Vec<InspectEntry> = serde_json::from_str(raw).expect("parse");
        assert_eq!(entries[0].state.status, "running");
        assert_eq!(
            entries[0].config.image,
            "atomicmemory-core:local-runtime-test"
        );
        let labels = entries[0].config.labels.as_ref().expect("labels");
        assert_eq!(
            labels.get("ai.atomicstrata.managed-by").map(String::as_str),
            Some("am-cli")
        );
        let parsed = env_from_docker_inspect(entries[0].config.env.as_deref());
        let (api, jwks) = (parsed.api_url, parsed.jwks_url);
        assert_eq!(api.as_deref(), Some("https://api.staging.example.com"));
        assert!(jwks.unwrap().contains("jwks.json"));
    }

    #[test]
    fn build_run_argv_has_expected_shape() {
        let config = default_instance_config("mac-mini", DEV_IMAGE);
        let env = InstanceEnv {
            openai_api_key: String::new(),
            atomicmemory_api_key: String::new(),
            atomicmemory_api_url: String::new(),
            cloud_jwks_url: String::new(),
            core_api_key: None,
        };
        let argv = build_run_argv(&config, &env);
        assert!(argv.contains(&"run".to_string()));
        assert!(argv.contains(&"-d".to_string()));
        assert!(argv.contains(&"--name".to_string()));
        assert!(argv.contains(&"atomic-memory".to_string()));
        assert!(argv.contains(&"--restart".to_string()));
        assert!(argv.contains(&"unless-stopped".to_string()));
        assert!(argv.contains(&"-p".to_string()));
        assert!(argv.contains(&"127.0.0.1:17350:17350".to_string()));
        assert!(argv.contains(&"-v".to_string()));
        assert!(
            argv.iter()
                .any(|a| a.contains("atomic-memory-data:/var/lib/atomicmemory/postgres"))
        );
        assert!(
            argv.iter()
                .any(|a| a.contains("atomic-memory-state:/var/lib/atomicmemory/state"))
        );
        assert!(argv.contains(&"--label".to_string()));
        assert!(argv.contains(&"ai.atomicstrata.managed-by=am-cli".to_string()));
        assert!(argv.contains(&"ai.atomicstrata.profile=mac-mini".to_string()));
        assert!(argv.contains(&"ai.atomicstrata.local-url=http://127.0.0.1:17350".to_string()));
        assert!(argv.contains(&"--env".to_string()));
        assert!(argv.contains(&"OPENAI_API_KEY".to_string()));
        assert!(argv.contains(&"ATOMICMEMORY_API_KEY".to_string()));
        assert!(argv.contains(&"ATOMICMEMORY_API_URL".to_string()));
        assert!(argv.contains(&"CLOUD_TRACE_SYNC_ENABLED".to_string()));
        assert!(argv.contains(&"CLOUD_JWKS_URL".to_string()));
        assert!(argv.contains(&"CLOUD_ENV".to_string()));
        assert!(argv.contains(&"CLOUD_JWT_ISSUER".to_string()));
        assert!(argv.contains(&"CLOUD_JWT_AUDIENCE".to_string()));
        assert_eq!(argv.last().map(String::as_str), Some(DEV_IMAGE));
    }

    #[test]
    fn build_run_argv_includes_pull_for_registry_images() {
        let config = default_instance_config("mac-mini", PROD_IMAGE);
        let env = InstanceEnv {
            openai_api_key: String::new(),
            atomicmemory_api_key: String::new(),
            atomicmemory_api_url: String::new(),
            cloud_jwks_url: String::new(),
            core_api_key: None,
        };
        let argv = build_run_argv(&config, &env);
        assert!(argv.contains(&"--pull".to_string()));
        assert!(argv.contains(&"always".to_string()));
    }

    #[test]
    fn build_run_argv_never_contains_secrets() {
        let config = default_instance_config("dev", "custom:tag");
        let env = InstanceEnv {
            openai_api_key: "sk-secret".into(),
            atomicmemory_api_key: "amc_secret".into(),
            atomicmemory_api_url: "https://api.dev.example.com".into(),
            cloud_jwks_url: "https://api.dev.example.com/jwks.json".into(),
            core_api_key: Some("core-secret".into()),
        };
        let argv = build_run_argv(&config, &env);
        let joined = argv.join(" ");
        assert!(!joined.contains("amc_"));
        assert!(!joined.contains("sk-"));
        assert!(!joined.contains("secret"));
    }

    #[test]
    fn build_run_argv_respects_image_override() {
        let config = default_instance_config("p", "my/core:v2");
        let env = InstanceEnv {
            openai_api_key: String::new(),
            atomicmemory_api_key: String::new(),
            atomicmemory_api_url: String::new(),
            cloud_jwks_url: String::new(),
            core_api_key: None,
        };
        let argv = build_run_argv(&config, &env);
        assert_eq!(argv.last().map(String::as_str), Some("my/core:v2"));
    }

    #[test]
    fn instance_env_child_env_has_values_not_in_argv() {
        let env = InstanceEnv {
            openai_api_key: "sk-test".into(),
            atomicmemory_api_key: "amc_test_key".into(),
            atomicmemory_api_url: "https://api.dev.example.com".into(),
            cloud_jwks_url: "https://api.dev.example.com/.well-known/atomic-core/jwks.json".into(),
            core_api_key: None,
        };
        let child = env.as_child_env();
        assert_eq!(
            child.get("OPENAI_API_KEY").map(String::as_str),
            Some("sk-test")
        );
        assert_eq!(
            child.get("ATOMICMEMORY_API_KEY").map(String::as_str),
            Some("amc_test_key")
        );
        assert_eq!(
            child.get("CLOUD_TRACE_SYNC_ENABLED").map(String::as_str),
            Some("true")
        );
        assert_eq!(child.get("CLOUD_ENV").map(String::as_str), Some("custom"));
        assert_eq!(
            child.get("CLOUD_JWT_ISSUER").map(String::as_str),
            Some("https://api.dev.example.com")
        );
        let argv = build_run_argv(&default_instance_config("p", DEV_IMAGE), &env);
        let joined = argv.join(" ");
        assert!(!joined.contains("sk-test"));
        assert!(!joined.contains("amc_test_key"));
    }

    #[test]
    fn docker_install_links_include_docs_urls() {
        let links = docker_install_links();
        assert!(links.contains("docs.docker.com/desktop"));
        assert!(links.contains("docs.docker.com/engine/install"));
    }

    struct MissingDocker;

    #[async_trait::async_trait]
    impl DockerRunner for MissingDocker {
        async fn version(&self) -> Result<()> {
            bail!(
                "docker is not available or the daemon is not running\ncommand not found\n\
                 {install_links}",
                install_links = docker_install_links()
            )
        }
        async fn inspect(&self, _name: &str) -> Result<Option<ContainerInspect>> {
            Ok(None)
        }
        async fn run(&self, _config: &InstanceConfig, _env: &InstanceEnv) -> Result<String> {
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
            Ok(None)
        }
    }

    #[tokio::test]
    async fn ensure_docker_available_surfaces_install_links() {
        let err = ensure_docker_available(&MissingDocker)
            .await
            .expect_err("missing docker should fail");
        let msg = format!("{err:#}");
        assert!(msg.contains("docs.docker.com/desktop"));
    }

    #[test]
    fn container_state_parses_running() {
        assert!(ContainerState::from_docker("running").is_running());
        assert!(!ContainerState::from_docker("exited").is_running());
    }

    #[test]
    fn tail_lines_truncates() {
        let input = "line1\nline2\nline3\nline4\nline5";
        assert_eq!(tail_lines(input, 2), "line4\nline5");
    }

    /// Smoke test against a real Docker daemon when explicitly enabled.
    #[tokio::test]
    #[ignore = "requires Docker; run: AM_CLI_DOCKER_IT=1 cargo test -p atomicmemory docker_version_smoke -- --ignored"]
    async fn docker_version_smoke() {
        if std::env::var("AM_CLI_DOCKER_IT").ok().as_deref() != Some("1") {
            return;
        }
        let runner = RealDockerRunner::new();
        runner.version().await.expect("docker version");
    }
}
