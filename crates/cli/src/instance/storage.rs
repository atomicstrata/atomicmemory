//! Persistent per-project provider datasets and managed lifecycle serialization.

use super::docker::ContainerInspect;
use crate::config::{ResolvedProfile, require_api_key, require_project_id};
use anyhow::{Context, Result, bail};
use clap::ValueEnum;
use fs4::fs_std::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};

/// Supported local provider families. Each owns a separate data/state pair.
#[derive(
    Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, ValueEnum, Serialize, Deserialize,
)]
#[serde(rename_all = "snake_case")]
pub enum Provider {
    #[default]
    Openai,
    Slm,
}
impl Provider {
    /// Stable CLI and storage identifier.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Openai => "openai",
            Self::Slm => "slm",
        }
    }
    /// Resolve compatibility shorthand without introducing a second precedence rule.
    pub fn requested(provider: Option<Self>, slm: bool) -> Result<Option<Self>> {
        if provider.is_some() && slm {
            bail!("--provider and --slm cannot be combined");
        }
        Ok(provider.or(slm.then_some(Self::Slm)))
    }
}

/// Explicit Docker volume pair; neither name is inferred during deletion.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StorageVolumes {
    pub data: String,
    pub state: String,
}
impl StorageVolumes {
    /// Names used by older CLI versions, adopted only with ownership evidence.
    pub fn legacy() -> Self {
        Self {
            data: super::VOLUME_DATA.into(),
            state: super::VOLUME_STATE.into(),
        }
    }
    fn validate(&self) -> Result<()> {
        for name in [&self.data, &self.state] {
            if name.is_empty()
                || !name
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
            {
                bail!("invalid managed volume name");
            }
        }
        if self.data == self.state {
            bail!("data and state volumes must be distinct");
        }
        Ok(())
    }
}

/// Docker creation identities recorded when adopting an unlabeled legacy pair.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StorageIdentity {
    pub data: Option<String>,
    pub state: Option<String>,
}

/// Provider and mounted named volumes observed from Docker, not a global marker.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ObservedStorage {
    pub provider: Provider,
    pub volumes: StorageVolumes,
    pub project_id: Option<String>,
}

/// Per-project remembered provider and retained dataset mappings.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct ProjectStorage {
    selected: Provider,
    datasets: BTreeMap<Provider, StorageVolumes>,
    #[serde(default)]
    identities: BTreeMap<Provider, StorageIdentity>,
}

/// Exclusive flock guard. Unlock explicitly on drop so the next opener does not
/// observe a stale EAGAIN under high thread churn (close-only release can lag).
struct LifecycleLock(File);

impl Drop for LifecycleLock {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.0);
    }
}

/// A locked registry. Hold it across a lifecycle operation to prevent interleaved switches.
pub struct RuntimeStore {
    path: PathBuf,
    _lock: LifecycleLock,
    projects: BTreeMap<String, ProjectStorage>,
}
impl RuntimeStore {
    /// Open the user registry and refuse overlapping lifecycle commands.
    pub fn open() -> Result<Self> {
        Self::at(&crate::config::config_dir()?.join("runtimes.json"))
    }
    /// Open an explicit registry path (also used by isolated tests).
    pub fn at(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(path.with_extension("lock"))?;
        lock.try_lock_exclusive().context(
            "another managed Core lifecycle command is running; retry after it finishes",
        )?;
        let lock = LifecycleLock(lock);
        let projects: BTreeMap<String, ProjectStorage> = match fs::read(path) {
            Ok(bytes) => serde_json::from_slice(&bytes).context(
                "invalid runtime storage registry; existing volumes have been preserved",
            )?,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => BTreeMap::new(),
            Err(err) => return Err(err.into()),
        };
        let mut assigned = std::collections::BTreeSet::new();
        for project in projects.values() {
            for volumes in project.datasets.values() {
                volumes.validate()?;
                for name in [&volumes.data, &volumes.state] {
                    if !assigned.insert(name.clone()) {
                        bail!(
                            "runtime registry maps a volume to multiple datasets; data preserved"
                        );
                    }
                }
            }
        }
        Ok(Self {
            path: path.to_path_buf(),
            _lock: lock,
            projects,
        })
    }

    /// Resolve the saved provider without opening or mutating any Docker data.
    pub fn provider(
        &self,
        profile: &ResolvedProfile,
        requested: Option<Provider>,
        observed: Option<&ContainerInspect>,
    ) -> Result<Provider> {
        let key = storage_key(profile)?;
        Ok(requested
            .or(self.projects.get(&key).map(|p| p.selected))
            .or_else(|| owned_storage(profile, observed).map(|s| s.provider))
            .unwrap_or_default())
    }

    /// Persistable adoption evidence without changing an existing provider selection.
    pub fn adopt_observed(
        &mut self,
        profile: &ResolvedProfile,
        observed: Option<&ContainerInspect>,
    ) -> Result<()> {
        let Some(storage) = owned_storage(profile, observed) else {
            return Ok(());
        };
        let key = storage_key(profile)?;
        storage.volumes.validate()?;
        for (owner, project) in &self.projects {
            for (existing_provider, volumes) in &project.datasets {
                let overlaps = [&volumes.data, &volumes.state]
                    .iter()
                    .any(|name| **name == storage.volumes.data || **name == storage.volumes.state);
                if overlaps && (owner != &key || *existing_provider != storage.provider) {
                    bail!(
                        "observed volumes already belong to another dataset; preserved without reassignment"
                    );
                }
            }
        }
        let project = self.projects.entry(key).or_insert_with(|| ProjectStorage {
            selected: storage.provider,
            ..ProjectStorage::default()
        });
        if let Some(volumes) = project.datasets.get(&storage.provider) {
            if volumes != &storage.volumes {
                bail!(
                    "observed volumes do not match the recorded dataset; preserved without reassignment"
                );
            }
        } else {
            project
                .datasets
                .insert(storage.provider, storage.volumes.clone());
        }
        Ok(())
    }

    /// Remember proven ownership and select an isolated target dataset.
    pub fn select(
        &mut self,
        profile: &ResolvedProfile,
        provider: Provider,
        observed: Option<&ContainerInspect>,
    ) -> Result<StorageVolumes> {
        self.adopt_observed(profile, observed)?;
        let key = storage_key(profile)?;
        let project = self.projects.entry(key.clone()).or_default();
        let volumes = project
            .datasets
            .entry(provider)
            .or_insert_with(|| StorageVolumes {
                data: format!("atomic-memory-{key}-{}-data", provider.as_str()),
                state: format!("atomic-memory-{key}-{}-state", provider.as_str()),
            })
            .clone();
        volumes.validate()?;
        project.selected = provider;
        Ok(volumes)
    }

    /// Read an existing selected dataset without inventing a claim to volume names.
    pub fn selected_dataset(
        &self,
        profile: &ResolvedProfile,
    ) -> Result<Option<(Provider, StorageVolumes)>> {
        let key = storage_key(profile)?;
        Ok(self.projects.get(&key).and_then(|project| {
            project
                .datasets
                .get(&project.selected)
                .map(|volumes| (project.selected, volumes.clone()))
        }))
    }

    /// Read durable creation identities for a previously validated dataset.
    pub fn identity(
        &self,
        profile: &ResolvedProfile,
        provider: Provider,
    ) -> Result<Option<&StorageIdentity>> {
        let key = storage_key(profile)?;
        Ok(self
            .projects
            .get(&key)
            .and_then(|project| project.identities.get(&provider)))
    }

    /// Record current Docker creation identities after ownership validation.
    pub fn record_identity(
        &mut self,
        profile: &ResolvedProfile,
        provider: Provider,
        volumes: &StorageVolumes,
        identity: StorageIdentity,
    ) -> Result<()> {
        let key = storage_key(profile)?;
        let project = self
            .projects
            .get_mut(&key)
            .ok_or_else(|| anyhow::anyhow!("dataset was not selected"))?;
        if project.datasets.get(&provider) != Some(volumes) {
            bail!(
                "observed volumes do not match the recorded dataset; preserved without reassignment"
            );
        }
        project.identities.insert(provider, identity);
        Ok(())
    }

    /// Commit a prepared selection before changing the active container, so retries resume it.
    pub fn save(&self) -> Result<()> {
        let temp = self.path.with_extension("json.tmp");
        let mut options = OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp)?;
        use std::io::Write;
        file.write_all(&serde_json::to_vec_pretty(&self.projects)?)?;
        file.sync_all()?;
        fs::rename(temp, &self.path).context("save runtime storage selection")
    }
}

fn storage_key(profile: &ResolvedProfile) -> Result<String> {
    let project = require_project_id(profile, None)?;
    let origin = url::Url::parse(&profile.base_url)?
        .origin()
        .ascii_serialization();
    let bytes = serde_json::to_vec(&(origin, project))?;
    Ok(hex::encode(Sha256::digest(bytes))[..24].to_string())
}

/// Check the managed installation, profile, Cloud origin, and any explicit project label.
pub(crate) fn matches_profile_context(
    profile: &ResolvedProfile,
    observed: &ContainerInspect,
) -> bool {
    if !observed.managed_by_cli
        || observed.profile_label.as_deref() != Some(&profile.name)
        || !observed
            .atomicmemory_api_url
            .as_deref()
            .is_some_and(|url| crate::auth::origin::same_origin(url, &profile.base_url))
    {
        return false;
    }
    observed
        .storage
        .as_ref()
        .and_then(|storage| storage.project_id.as_deref())
        .is_none_or(|id| profile.project_id.as_deref() == Some(id))
}

/// Return mounted storage whose profile and project ownership are directly proven.
pub(crate) fn owned_storage<'a>(
    profile: &ResolvedProfile,
    observed: Option<&'a ContainerInspect>,
) -> Option<&'a ObservedStorage> {
    let observed = observed?;
    if !matches_profile_context(profile, observed) {
        return None;
    }
    let storage = observed.storage.as_ref()?;
    let project_matches = storage.project_id.is_some()
        || require_api_key(profile)
            .ok()
            .is_some_and(|key| observed.atomicmemory_api_key.as_deref() == Some(key.as_str()));
    project_matches.then_some(storage)
}

/// Validate storage before credentials change, preserving proven outgoing legacy identity.
/// Target selection remains in memory until the caller completes runtime preparation.
pub async fn preflight_storage(
    profile: &ResolvedProfile,
    provider: Provider,
    replace: bool,
) -> Result<()> {
    let docker = super::docker::RealDockerRunner::new();
    let mut registry = RuntimeStore::open()?;
    preflight_storage_with(profile, provider, replace, &docker, &mut registry).await
}

pub(crate) async fn preflight_storage_with(
    profile: &ResolvedProfile,
    provider: Provider,
    replace: bool,
    docker: &dyn super::docker::DockerRunner,
    registry: &mut RuntimeStore,
) -> Result<()> {
    use super::docker::default_instance_config;
    let observed = docker.inspect(super::DEFAULT_CONTAINER_NAME).await?;
    if observed
        .as_ref()
        .is_some_and(|container| !container.managed_by_cli)
        && !replace
    {
        bail!(
            "container 'atomic-memory' is not CLI-managed; use --replace to authorize replacement (volumes are preserved)"
        );
    }
    if let Some(outgoing) = owned_storage(profile, observed.as_ref()) {
        let mut config = default_instance_config(&profile.name, "");
        config.provider = outgoing.provider;
        config.storage = outgoing.volumes.clone();
        let identity = docker
            .validate_storage(
                &config,
                registry.identity(profile, outgoing.provider)?,
                true,
            )
            .await?;
        registry.adopt_observed(profile, observed.as_ref())?;
        registry.record_identity(profile, outgoing.provider, &outgoing.volumes, identity)?;
        // The old Cloud key may be rotated next. Preserve its ownership proof now,
        // while leaving the previous selected provider intact until preparation succeeds.
        registry.save()?;
    }
    let mut config = default_instance_config(&profile.name, "");
    config.provider = provider;
    config.storage = registry.select(profile, provider, observed.as_ref())?;
    let live_legacy = owned_storage(profile, observed.as_ref())
        .is_some_and(|storage| storage.provider == provider && storage.volumes == config.storage);
    docker
        .validate_storage(&config, registry.identity(profile, provider)?, live_legacy)
        .await?;
    Ok(())
}

/// Runnable provider switch command, including a shell-safe profile argument.
pub fn provider_command(profile: &str, provider: Provider) -> String {
    format!(
        "am --profile '{}' instance start --provider {}",
        profile.replace('\'', "'\\''"),
        provider.as_str()
    )
}
