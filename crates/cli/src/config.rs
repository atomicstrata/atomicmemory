//! Profile and credential storage (platform config dir — see `environment` docs).

use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::Write as _;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow};
use fs4::fs_std::FileExt;
use serde::{Deserialize, Deserializer, Serialize};

use crate::auth::origin::check_api_key_origin;
use crate::environment::{BaseUrlInput, Environment, resolve_base_url};

pub use crate::environment::ENV_CORE_IMAGE;

pub const ENV_PROFILE: &str = "ATOMICMEMORY_PROFILE";
pub const ENV_CORE_API_KEY: &str = "ATOMICMEMORY_CORE_API_KEY";
pub const ENV_LEGACY_CORE_API_KEY: &str = "CORE_API_KEY";
pub const DEFAULT_PROFILE: &str = "cloud";
/// Default Cloud API base URL for new profiles and commands without overrides.
pub const DEFAULT_CLOUD_URL: &str = Environment::PROD_BASE_URL;
/// Fixed loopback port — must match the redirect URI registered in Clerk OAuth app.
pub const DEFAULT_OAUTH_CALLBACK_PORT: u16 = 9876;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ProfileKind {
    #[default]
    Cloud,
    Local,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ConfigFile {
    #[serde(default)]
    pub default_profile: Option<String>,
    /// Named environment preset (production only in the public CLI).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_legacy_environment"
    )]
    pub environment: Option<Environment>,
    /// Global override for the Core Docker image.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub core_image: Option<String>,
    #[serde(default)]
    pub oauth: OAuthDefaults,
    #[serde(default)]
    pub profiles: BTreeMap<String, ProfileConfig>,
    /// Anonymous PostHog distinct_id for CLI activation telemetry.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub telemetry_distinct_id: Option<String>,
    /// Whether `first_real_memory_created` has been emitted for this install.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub telemetry_first_real_memory_sent: Option<bool>,
    /// Host MCP installs performed by `am integrate` (key = canonical config path).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub integrations: BTreeMap<String, IntegrationRecord>,
}

/// Tracks a host MCP config write for safe uninstall and doctor checks.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct IntegrationRecord {
    pub host: String,
    pub scope: String,
    pub config_path: String,
    pub profile: String,
    pub installed_at: String,
    pub entry_fingerprint: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prior_entry: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct OAuthDefaults {
    #[serde(default)]
    pub issuer: Option<String>,
    #[serde(default)]
    pub client_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProfileConfig {
    pub base_url: Option<String>,
    #[serde(default)]
    pub kind: ProfileKind,
    pub project_id: Option<String>,
    /// Reference key into credentials `[api_keys.<name>]`
    pub api_key_ref: Option<String>,
    pub local_url: Option<String>,
    pub oauth_ref: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CredentialsFile {
    #[serde(default)]
    pub oauth: BTreeMap<String, OAuthTokens>,
    #[serde(default)]
    pub api_keys: BTreeMap<String, ApiKeySecret>,
    /// Per-profile secrets (e.g. OpenAI API key for local Core). Stored mode 0600.
    #[serde(default)]
    pub profile_secrets: BTreeMap<String, ProfileSecrets>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProfileSecrets {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub openai_api_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OAuthTokens {
    pub id_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    #[serde(default)]
    pub expires_at: Option<i64>,
    /// Identity provider that minted the session.
    #[serde(default)]
    pub issuer: Option<String>,
    /// Cloud API origin this session was acquired FOR, recorded at storage
    /// time.
    ///
    /// Not derivable after the fact: the profile's `base_url` is mutable via
    /// `am config set base-url`, and two API origins can legitimately share one
    /// identity issuer, so neither is a substitute for recording the
    /// destination the credential was obtained against. `None` means the
    /// session predates this field and is refused everywhere — re-run
    /// `am auth login` rather than assuming where it came from.
    #[serde(default)]
    pub api_origin: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiKeySecret {
    pub secret: String,
    /// Cloud API origin this key was minted against, recorded at storage time.
    /// See [`OAuthTokens::api_origin`]. `None` means the key predates this
    /// field and is refused everywhere — re-save with `am key create --save`.
    #[serde(default)]
    pub api_origin: Option<String>,
    /// Cloud project this key was issued for, recorded at storage time.
    ///
    /// The origin alone is not enough: one Cloud origin hosts many projects, so
    /// a key minted for project A satisfies an origin check while a profile
    /// relinked to project B reuses it. Core is then recreated with A's key
    /// while the profile and receipt claim B, routing trace sync to the wrong
    /// project. `None` means the key predates this field and is refused, the
    /// same fail-closed rule the origin uses.
    #[serde(default)]
    pub project_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ResolvedProfile {
    pub name: String,
    pub base_url: String,
    pub kind: ProfileKind,
    pub project_id: Option<String>,
    pub memory_base_url: String,
    pub api_key: Option<String>,
    #[allow(dead_code)]
    pub oauth: Option<OAuthTokens>,
}

fn deserialize_legacy_environment<'de, D>(deserializer: D) -> Result<Option<Environment>, D::Error>
where
    D: Deserializer<'de>,
{
    let raw: Option<String> = Option::deserialize(deserializer)?;
    Ok(match raw.as_deref().map(str::to_ascii_lowercase) {
        None => None,
        Some(value) if value == "prod" || value == "production" => Some(Environment::Prod),
        Some(_) => None,
    })
}

pub fn config_dir() -> Result<PathBuf> {
    let dirs = directories::ProjectDirs::from("ai", "atomicstrata", "atomicmemory")
        .ok_or_else(|| anyhow!("cannot resolve config directory"))?;
    Ok(dirs.config_dir().to_path_buf())
}

pub fn config_path() -> Result<PathBuf> {
    Ok(config_dir()?.join("config.toml"))
}

pub fn credentials_path() -> Result<PathBuf> {
    Ok(config_dir()?.join("credentials.toml"))
}

fn read_config_at(path: &Path) -> Result<ConfigFile> {
    if !path.exists() {
        return Ok(default_config());
    }
    let raw = fs::read_to_string(path).context("read config.toml")?;
    toml::from_str(&raw).context("parse config.toml")
}

fn write_config_at(path: &Path, file: &ConfigFile) -> Result<()> {
    let raw = toml::to_string_pretty(file).context("serialize config")?;
    write_atomic_file(path, &raw, 0o600)
}

pub fn load_config() -> Result<ConfigFile> {
    read_config_at(&config_path()?)
}

/// Read, mutate, and write `config.toml` while holding the file lock for the
/// whole cycle.
///
/// Locking only the write leaves the lost-update race open: two `am`
/// invocations can each load the same snapshot, mutate different fields, and
/// have the second write discard the first — losing a profile, project link,
/// or key reference. Callers that mutate stored config must use this rather
/// than `load_config` + a separate write.
///
/// The closure must not call `load_config`/`update_config`
/// itself: the advisory lock is held per open file description, so re-entering
/// through a second handle would deadlock against this one.
pub fn update_config<T>(mutate: impl FnOnce(&mut ConfigFile) -> Result<T>) -> Result<T> {
    ConfigStore::production()?.update(mutate)
}

/// Config file access point for callers that need an explicit store (tests, integrate state).
pub(crate) struct ConfigStore {
    path: PathBuf,
}

impl ConfigStore {
    pub(crate) fn production() -> Result<Self> {
        Ok(Self {
            path: config_path()?,
        })
    }

    #[cfg(test)]
    pub(crate) fn at(path: PathBuf) -> Self {
        Self { path }
    }

    #[cfg(test)]
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    pub(crate) fn load(&self) -> Result<ConfigFile> {
        read_config_at(&self.path)
    }

    pub(crate) fn update<T>(&self, mutate: impl FnOnce(&mut ConfigFile) -> Result<T>) -> Result<T> {
        with_path_lock(&self.path, || {
            let mut file = read_config_at(&self.path)?;
            let out = mutate(&mut file)?;
            write_config_at(&self.path, &file)?;
            Ok(out)
        })
    }
}

fn read_credentials_at(path: &Path) -> Result<CredentialsFile> {
    if !path.exists() {
        return Ok(CredentialsFile::default());
    }
    let raw = fs::read_to_string(path).context("read credentials.toml")?;
    toml::from_str(&raw).context("parse credentials.toml")
}

fn write_credentials_at(path: &Path, file: &CredentialsFile) -> Result<()> {
    let raw = toml::to_string_pretty(file).context("serialize credentials")?;
    write_atomic_file(path, &raw, 0o600)
}

pub fn load_credentials() -> Result<CredentialsFile> {
    read_credentials_at(&credentials_path()?)
}

/// Read, mutate, and write `credentials.toml` under the file lock.
///
/// Same contract as [`update_config`]: this is what keeps a concurrent token
/// refresh from clobbering a freshly stored API key (and vice versa). The
/// closure must not re-enter the credential load/save helpers.
pub fn update_credentials<T>(mutate: impl FnOnce(&mut CredentialsFile) -> Result<T>) -> Result<T> {
    let path = credentials_path()?;
    with_path_lock(&path, || {
        let mut file = read_credentials_at(&path)?;
        let out = mutate(&mut file)?;
        write_credentials_at(&path, &file)?;
        Ok(out)
    })
}

/// Stamp the acquisition origin onto a session record.
///
/// Always overwrites: the origin passed by the caller is the destination the
/// session was actually obtained against, and is authoritative over whatever a
/// constructor left in the struct.
fn bind_session_origin(tokens: OAuthTokens, api_origin: &str) -> OAuthTokens {
    OAuthTokens {
        api_origin: Some(api_origin.to_string()),
        ..tokens
    }
}

/// Stamp the minting origin onto an API-key record.
fn bind_key_origin(secret: &str, api_origin: &str, project_id: &str) -> ApiKeySecret {
    ApiKeySecret {
        secret: secret.to_string(),
        api_origin: Some(api_origin.to_string()),
        project_id: Some(project_id.to_string()),
    }
}

/// Choose the API key to send to `resolved_base_url`.
///
/// A stored `amc_` key belongs to the origin it was minted against — the
/// profile's own base URL, or the default when it has none. The destination can
/// be redirected per invocation by `--base-url` / `ATOMICMEMORY_API_URL`, so the
/// stored key is withheld unless the two origins agree; this is the same
/// invariant that governs session tokens (see [`crate::auth::origin`]).
///
/// An explicit `ATOMICMEMORY_API_KEY` is per-invocation user intent, like a
/// flag, and is passed through unchanged.
fn select_api_key(
    env_override: Option<String>,
    stored: Option<&ApiKeySecret>,
    resolved_base_url: &str,
    resolved_project_id: Option<&str>,
) -> Option<String> {
    if let Some(key) = env_override {
        return Some(key);
    }
    let stored = stored?;
    match stored.api_origin.as_deref() {
        Some(origin) if check_api_key_origin(origin, resolved_base_url) => {}
        // No recorded origin means the key cannot be proven to belong to this
        // destination — including production. Re-save it with
        // `am key create --save` rather than assuming where it came from.
        _ => return None,
    }

    // The origin is necessary but not sufficient: one origin hosts many
    // projects. A key issued for project A must not be sent on behalf of a
    // profile now linked to project B.
    match (stored.project_id.as_deref(), resolved_project_id) {
        (Some(issued_for), Some(target)) if issued_for == target => Some(stored.secret.clone()),
        // Unknown binding fails closed, like an originless key.
        _ => None,
    }
}

pub fn resolve_profile(
    profile_name: Option<&str>,
    base_url_override: Option<&str>,
    environment_override: Option<Environment>,
) -> Result<ResolvedProfile> {
    let config = load_config()?;
    let creds = load_credentials()?;
    let name = profile_name
        .map(str::to_string)
        .or_else(|| std::env::var(ENV_PROFILE).ok())
        .or_else(|| config.default_profile.clone())
        .unwrap_or_else(|| DEFAULT_PROFILE.to_string());

    let profile = config
        .profiles
        .get(&name)
        .cloned()
        .unwrap_or_else(|| ProfileConfig {
            base_url: Some(DEFAULT_CLOUD_URL.to_string()),
            kind: ProfileKind::Cloud,
            ..Default::default()
        });

    let profile_base = profile.base_url.as_deref();
    let base_url = resolve_base_url(&BaseUrlInput {
        base_url_override,
        environment_override,
        profile_base_url: profile_base,
        config_environment: config.environment,
    })
    .value;

    let memory_base_url = match profile.kind {
        ProfileKind::Local => profile
            .local_url
            .clone()
            .unwrap_or_else(|| base_url.clone()),
        ProfileKind::Cloud => base_url.clone(),
    };

    // A stored `amc_` key belongs to the origin it was minted against, which is
    // the profile's own base URL (or the default when it has none). The
    // destination can be redirected per invocation by `--base-url` /
    // ATOMICMEMORY_API_URL, so the key is withheld unless the two agree — the
    // same invariant that governs session tokens, see `crate::auth::origin`.
    // An explicit ATOMICMEMORY_API_KEY is per-invocation user intent, like a
    // flag, and is passed through.
    let api_key_ref = profile.api_key_ref.clone().unwrap_or_else(|| name.clone());
    let api_key = select_api_key(
        std::env::var("ATOMICMEMORY_API_KEY").ok(),
        creds.api_keys.get(&api_key_ref),
        &base_url,
        profile.project_id.as_deref(),
    );

    let oauth_ref = profile.oauth_ref.clone().unwrap_or_else(|| name.clone());
    let oauth = creds.oauth.get(&oauth_ref).cloned();

    Ok(ResolvedProfile {
        name,
        base_url,
        kind: profile.kind,
        project_id: profile.project_id,
        memory_base_url,
        api_key,
        oauth,
    })
}

/// Dashboard session + API base URL aligned with `am project list`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DashboardContext {
    /// Profile name whose OAuth tokens authenticate dashboard calls.
    pub oauth_profile: String,
    /// Cloud API base URL for org/project dashboard calls.
    pub base_url: String,
}

/// Resolve dashboard auth + API URL from the active CLI profile (same stack as
/// `am project list`), not a hardcoded dev default.
pub fn resolve_dashboard_context(
    profile_name: Option<&str>,
    base_url_override: Option<&str>,
    environment_override: Option<Environment>,
) -> Result<DashboardContext> {
    let active = resolve_profile(profile_name, base_url_override, environment_override)?;
    let config = load_config()?;
    let creds = load_credentials()?;
    let oauth_profile = oauth_profile_for_base_url(&active, &config, &creds, &active.base_url)?;
    Ok(DashboardContext {
        oauth_profile,
        base_url: active.base_url,
    })
}

/// Profile name whose OAuth tokens should drive cloud dashboard calls.
///
/// When `default_profile` is a local link (`local`), init/auth must still use the
/// cloud login profile that holds the Clerk session.
pub fn resolve_cloud_auth_profile() -> Result<String> {
    let (_, profile) = resolve_cloud_auth_target(None, None, None)?;
    Ok(profile)
}

/// Resolve the Cloud API URL and OAuth profile for init/auth, honoring global flags.
pub fn resolve_cloud_auth_target(
    profile_name: Option<&str>,
    base_url_override: Option<&str>,
    environment_override: Option<Environment>,
) -> Result<(String, String)> {
    let resolved = resolve_profile(profile_name, base_url_override, environment_override)?;
    let config = load_config()?;
    let creds = load_credentials()?;
    let oauth_profile = oauth_profile_for_base_url(&resolved, &config, &creds, &resolved.base_url)?;
    Ok((resolved.base_url, oauth_profile))
}

/// Persist an environment preset and sync profile base URL + OAuth defaults.
pub fn apply_environment_preset(config: &mut ConfigFile, environment: Environment) {
    config.environment = Some(environment);
    config.oauth.issuer = None;
    config.oauth.client_id = None;
    let profile_name = config
        .default_profile
        .clone()
        .unwrap_or_else(|| DEFAULT_PROFILE.to_string());
    let entry = config.profiles.entry(profile_name).or_default();
    entry.base_url = Some(environment.base_url().to_string());
}

fn oauth_profile_for_base_url(
    active: &ResolvedProfile,
    config: &ConfigFile,
    creds: &CredentialsFile,
    target_base_url: &str,
) -> Result<String> {
    if let Some(entry) = config.profiles.get(&active.name) {
        if entry.kind == ProfileKind::Local {
            if let Some(oauth_ref) = entry.oauth_ref.as_deref()
                && creds.oauth.contains_key(oauth_ref)
            {
                return Ok(oauth_ref.to_string());
            }
        } else {
            let oauth_ref = entry.oauth_ref.as_deref().unwrap_or(active.name.as_str());
            if creds.oauth.contains_key(oauth_ref) {
                return Ok(oauth_ref.to_string());
            }
        }
    }
    pick_cloud_oauth_profile(config, creds, target_base_url)
}

fn pick_cloud_oauth_profile(
    config: &ConfigFile,
    creds: &CredentialsFile,
    target_base_url: &str,
) -> Result<String> {
    let mut candidates = Vec::new();
    for (name, profile) in &config.profiles {
        if profile.kind != ProfileKind::Cloud {
            continue;
        }
        let oauth_ref = profile.oauth_ref.as_deref().unwrap_or(name.as_str());
        if creds.oauth.contains_key(oauth_ref) {
            candidates.push(name.clone());
        }
    }

    if let Some(name) = candidates
        .iter()
        .find(|name| profile_base_url(config, name.as_str()) == target_base_url)
    {
        return Ok(name.clone());
    }

    // Legacy fallback: prefer dev sandbox when no profile matches the target URL.
    if target_base_url == DEFAULT_CLOUD_URL
        && let Some(name) = candidates
            .iter()
            .find(|name| profile_base_url(config, name.as_str()) == DEFAULT_CLOUD_URL)
    {
        return Ok(name.clone());
    }

    if let Some(name) = candidates.into_iter().next() {
        return Ok(name);
    }

    if let Some((key, _)) = creds.oauth.iter().next() {
        return Ok(key.clone());
    }

    Ok(config
        .default_profile
        .clone()
        .unwrap_or_else(|| DEFAULT_PROFILE.to_string()))
}

fn profile_base_url(config: &ConfigFile, profile_name: &str) -> String {
    config
        .profiles
        .get(profile_name)
        .and_then(|p| p.base_url.clone())
        .unwrap_or_else(|| DEFAULT_CLOUD_URL.to_string())
}

/// Store a Cloud API key together with the origin it was minted against.
///
/// `api_origin` and `project_id` are required rather than read from the profile
/// so the binding records what the key actually came from; both the profile's
/// `base_url` and its linked project can be repointed later.
pub fn store_api_key(
    profile_name: &str,
    secret: &str,
    api_origin: &str,
    project_id: &str,
) -> Result<()> {
    let record = bind_key_origin(secret, api_origin, project_id);
    update_credentials(|creds| {
        creds.api_keys.insert(profile_name.to_string(), record);
        Ok(())
    })?;

    update_config(|config| {
        let entry = config.profiles.entry(profile_name.to_string()).or_default();
        entry.api_key_ref = Some(profile_name.to_string());
        Ok(())
    })
}

pub fn resolve_openai_api_key(profile_name: &str) -> Option<String> {
    std::env::var("OPENAI_API_KEY")
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| {
            load_credentials()
                .ok()
                .and_then(|c| {
                    c.profile_secrets
                        .get(profile_name)
                        .and_then(|s| s.openai_api_key.clone())
                })
                .filter(|s| !s.is_empty())
        })
}

pub fn store_openai_api_key(profile_name: &str, key: &str) -> Result<()> {
    update_credentials(|creds| {
        creds
            .profile_secrets
            .entry(profile_name.to_string())
            .or_default()
            .openai_api_key = Some(key.to_string());
        Ok(())
    })
}

pub fn clear_oauth(profile_name: &str) -> Result<()> {
    update_credentials(|creds| {
        creds.oauth.remove(profile_name);
        Ok(())
    })
}

pub fn store_project_id(profile_name: &str, project_id: &str) -> Result<()> {
    update_config(|config| {
        let entry = config.profiles.entry(profile_name.to_string()).or_default();
        entry.project_id = Some(project_id.to_string());
        Ok(())
    })
}

pub fn store_profile_base_url(profile_name: &str, base_url: &str) -> Result<()> {
    update_config(|config| {
        let entry = config.profiles.entry(profile_name.to_string()).or_default();
        entry.base_url = Some(base_url.to_string());
        Ok(())
    })
}

/// Store an OAuth session together with the Cloud API origin it was acquired
/// for. See [`store_api_key`] for why the origin is a parameter.
pub fn store_oauth(profile_name: &str, tokens: OAuthTokens, api_origin: &str) -> Result<()> {
    let tokens = bind_session_origin(tokens, api_origin);
    update_credentials(|creds| {
        creds.oauth.insert(profile_name.to_string(), tokens);
        Ok(())
    })?;

    update_config(|config| {
        let entry = config.profiles.entry(profile_name.to_string()).or_default();
        entry.oauth_ref = Some(profile_name.to_string());
        if entry.base_url.is_none() {
            entry.base_url = Some(DEFAULT_CLOUD_URL.to_string());
        }
        if config.default_profile.is_none() {
            config.default_profile = Some(profile_name.to_string());
        }
        Ok(())
    })
}

fn default_config() -> ConfigFile {
    let mut profiles = BTreeMap::new();
    profiles.insert(
        DEFAULT_PROFILE.to_string(),
        ProfileConfig {
            base_url: Some(DEFAULT_CLOUD_URL.to_string()),
            kind: ProfileKind::Cloud,
            ..Default::default()
        },
    );
    ConfigFile {
        default_profile: Some(DEFAULT_PROFILE.to_string()),
        environment: Some(Environment::Prod),
        core_image: None,
        // Deliberately empty. The production issuer/client_id are shipped
        // constants applied by `clerk_oauth` when the base URL IS production;
        // seeding them into config.toml made them look like user-configured
        // values, which the custom-URL path then read back — handing the
        // production OAuth identity to an arbitrary `--base-url` and defeating
        // the documented fail-closed behavior.
        oauth: OAuthDefaults::default(),
        profiles,
        telemetry_distinct_id: None,
        telemetry_first_real_memory_sent: None,
        integrations: BTreeMap::new(),
    }
}

fn lock_path_for(target: &Path) -> PathBuf {
    target.with_extension("lock")
}

fn with_path_lock<T>(target: &Path, op: impl FnOnce() -> Result<T>) -> Result<T> {
    let lock_path = lock_path_for(target);
    write_secure_dir(&lock_path)?;
    let lock = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&lock_path)
        .with_context(|| format!("open lock {}", lock_path.display()))?;
    lock.lock_exclusive()
        .with_context(|| format!("lock {}", lock_path.display()))?;
    let result = op();
    drop(lock);
    result
}

fn write_atomic_file(path: &Path, contents: &str, mode: u32) -> Result<()> {
    write_secure_dir(path)?;
    let file_name = path.file_name().and_then(|s| s.to_str()).unwrap_or("file");
    let tmp = path.with_file_name(format!(".{file_name}.tmp"));
    write_file_mode(&tmp, contents, mode)?;
    fs::rename(&tmp, path).with_context(|| format!("rename {}", path.display()))?;
    Ok(())
}

fn write_secure_dir(path: &Path) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).context("create config dir")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(parent, fs::Permissions::from_mode(0o700))
                .context("chmod config dir 0700")?;
        }
    }
    Ok(())
}

fn write_file_mode(path: &Path, contents: &str, mode: u32) -> Result<()> {
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(path)
        .with_context(|| format!("open {}", path.display()))?;
    file.write_all(contents.as_bytes())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(mode))
            .with_context(|| format!("chmod {}", path.display()))?;
    }
    Ok(())
}

pub fn require_project_id(profile: &ResolvedProfile, flag: Option<&str>) -> Result<String> {
    flag.map(str::to_string)
        .or_else(|| profile.project_id.clone())
        .ok_or_else(|| {
            anyhow!("missing project — pass --project, run `atomicmemory project select` (or `am project select`), or set project_id on the active profile")
        })
}

pub fn require_api_key(profile: &ResolvedProfile) -> Result<String> {
    profile
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|secret| !secret.is_empty())
        .map(str::to_string)
        .ok_or_else(|| {
            anyhow!(
                "missing API key — run `atomicmemory key create --save` or set ATOMICMEMORY_API_KEY"
            )
        })
}

/// Cloud project API keys used for trace sync and `/v1/local/token` mint.
pub fn is_cloud_api_key(secret: &str) -> bool {
    secret.starts_with("amc_")
}

/// Optional static Core API key for local memory ops (bypasses Cloud JWT mint).
pub fn resolve_core_api_key() -> Option<String> {
    std::env::var(ENV_CORE_API_KEY)
        .ok()
        .or_else(|| std::env::var(ENV_LEGACY_CORE_API_KEY).ok())
        .filter(|s| !s.is_empty())
}

/// Public JWKS URL for Core to verify Cloud-minted JWTs.
pub fn jwks_url(cloud_base_url: &str) -> Result<String> {
    let base = url::Url::parse(cloud_base_url)?;
    let jwks = base.join(".well-known/atomic-core/jwks.json")?;
    Ok(jwks.to_string())
}

/// Write the default config file if none exists yet (first-run bootstrap).
///
/// The existence check runs INSIDE the lock: checking first and writing after
/// let a concurrent first run create and populate the config in the gap, only
/// for this call to overwrite it with defaults and discard that work.
pub fn ensure_config_initialized() -> Result<()> {
    let path = config_path()?;
    with_path_lock(&path, || {
        if path.exists() {
            return Ok(());
        }
        write_config_at(&path, &default_config())
    })
}

#[cfg(test)]
pub fn default_config_for_test() -> ConfigFile {
    default_config()
}

#[cfg(test)]
mod tests {

    fn key_for(origin: &str, project: &str) -> ApiKeySecret {
        ApiKeySecret {
            secret: "amc_live_example".into(),
            api_origin: Some(origin.into()),
            project_id: Some(project.into()),
        }
    }

    /// A Cloud origin hosts many projects, so matching origins is not enough.
    ///
    /// The defect: keys recorded only their origin. A profile relinked from
    /// project A to project B reused A's key, so Core came up with A's
    /// credential while the profile and receipt claimed B, routing trace sync to
    /// the wrong project.
    #[test]
    fn a_key_issued_for_another_project_is_refused() {
        let stored = key_for("https://api.atomicstrata.ai", "proj_a");
        let selected = select_api_key(
            None,
            Some(&stored),
            "https://api.atomicstrata.ai",
            Some("proj_b"),
        );
        assert_eq!(
            selected, None,
            "same origin, different project: the key must not be reused",
        );
    }

    #[test]
    fn a_key_issued_for_this_project_is_used() {
        let stored = key_for("https://api.atomicstrata.ai", "proj_a");
        let selected = select_api_key(
            None,
            Some(&stored),
            "https://api.atomicstrata.ai",
            Some("proj_a"),
        );
        assert_eq!(selected.as_deref(), Some("amc_live_example"));
    }

    /// Both bindings are load-bearing; neither substitutes for the other.
    #[test]
    fn a_matching_project_does_not_excuse_a_foreign_origin() {
        let stored = key_for("https://api.atomicstrata.ai", "proj_a");
        let selected = select_api_key(
            None,
            Some(&stored),
            "http://127.0.0.1:38767",
            Some("proj_a"),
        );
        assert_eq!(selected, None, "the origin check must still apply");
    }

    /// Fail closed on an unknown binding, exactly as an originless key does.
    #[test]
    fn a_key_without_a_recorded_project_is_refused() {
        let stored = ApiKeySecret {
            secret: "amc_live_example".into(),
            api_origin: Some("https://api.atomicstrata.ai".into()),
            project_id: None,
        };
        let selected = select_api_key(
            None,
            Some(&stored),
            "https://api.atomicstrata.ai",
            Some("proj_a"),
        );
        assert_eq!(selected, None, "an unproven binding must not be trusted");
    }

    /// An explicit env override is per-invocation user intent, like a flag.
    #[test]
    fn an_explicit_env_key_still_passes_through() {
        let stored = key_for("https://api.atomicstrata.ai", "proj_a");
        let selected = select_api_key(
            Some("amc_from_env".into()),
            Some(&stored),
            "https://api.atomicstrata.ai",
            Some("proj_b"),
        );
        assert_eq!(selected.as_deref(), Some("amc_from_env"));
    }
    use super::*;
    use crate::auth::clerk_oauth::resolve_oauth_pair;

    #[test]
    fn default_config_has_cloud_profile_and_no_seeded_oauth() {
        let cfg = default_config();
        assert!(cfg.profiles.contains_key(DEFAULT_PROFILE));
        // Seeding the shipped production pair here made it indistinguishable
        // from user configuration, which the custom-URL path then trusted.
        assert!(cfg.oauth.issuer.is_none());
        assert!(cfg.oauth.client_id.is_none());
    }

    #[test]
    fn apply_environment_preset_syncs_profile_and_clears_oauth() {
        let mut cfg = default_config();
        apply_environment_preset(&mut cfg, Environment::Prod);
        assert_eq!(cfg.environment, Some(Environment::Prod));
        assert!(cfg.oauth.issuer.is_none());
        assert!(cfg.oauth.client_id.is_none());
        assert_eq!(
            cfg.profiles
                .get(DEFAULT_PROFILE)
                .and_then(|p| p.base_url.as_deref()),
            Some(Environment::PROD_BASE_URL)
        );
    }

    #[test]
    fn oauth_settings_uses_prod_defaults() {
        let (issuer, client_id) =
            resolve_oauth_pair(&default_config(), DEFAULT_CLOUD_URL, None, None).unwrap();
        assert_eq!(issuer, Environment::PROD_OAUTH_ISSUER);
        assert_eq!(client_id, Environment::PROD_OAUTH_CLIENT_ID);
    }

    #[test]
    fn resolve_profile_uses_environment_override() {
        let resolved = resolve_base_url(&BaseUrlInput {
            base_url_override: None,
            environment_override: Some(Environment::Prod),
            profile_base_url: Some("https://custom.example.com"),
            config_environment: None,
        });
        assert_eq!(resolved.value, Environment::PROD_BASE_URL);
    }

    #[test]
    fn is_cloud_api_key_detects_amc_prefix() {
        assert!(is_cloud_api_key("amc_test_secret"));
        assert!(!is_cloud_api_key("core_key_abc"));
    }

    #[test]
    fn jwks_url_joins_well_known_path() {
        let url = jwks_url("https://api.atomicstrata.ai").unwrap();
        assert!(url.ends_with("/.well-known/atomic-core/jwks.json"));
    }

    #[test]
    fn pick_cloud_oauth_profile_prefers_matching_base_url() {
        let mut config = default_config();
        config.profiles.insert(
            "staging".into(),
            ProfileConfig {
                base_url: Some("https://api.staging.example.com".into()),
                kind: ProfileKind::Cloud,
                ..Default::default()
            },
        );
        config.profiles.insert(
            "cloud".into(),
            ProfileConfig {
                base_url: Some(DEFAULT_CLOUD_URL.into()),
                kind: ProfileKind::Cloud,
                ..Default::default()
            },
        );
        let mut creds = CredentialsFile::default();
        creds.oauth.insert(
            "cloud".into(),
            OAuthTokens {
                id_token: "token".into(),
                refresh_token: None,
                expires_at: None,
                issuer: None,
                api_origin: None,
            },
        );
        creds.oauth.insert(
            "staging".into(),
            OAuthTokens {
                id_token: "token".into(),
                refresh_token: None,
                expires_at: None,
                issuer: None,
                api_origin: None,
            },
        );

        let picked =
            pick_cloud_oauth_profile(&config, &creds, "https://api.staging.example.com").unwrap();
        assert_eq!(picked, "staging");
    }

    #[test]
    fn oauth_profile_for_local_profile_uses_oauth_ref() {
        let mut config = default_config();
        config.profiles.insert(
            "atomic-strata-project".into(),
            ProfileConfig {
                base_url: Some("https://api.staging.example.com".into()),
                kind: ProfileKind::Local,
                oauth_ref: Some("staging".into()),
                ..Default::default()
            },
        );
        config.profiles.insert(
            "staging".into(),
            ProfileConfig {
                base_url: Some("https://api.staging.example.com".into()),
                kind: ProfileKind::Cloud,
                ..Default::default()
            },
        );
        let mut creds = CredentialsFile::default();
        creds.oauth.insert(
            "staging".into(),
            OAuthTokens {
                id_token: "token".into(),
                refresh_token: None,
                expires_at: None,
                issuer: None,
                api_origin: None,
            },
        );

        let active = ResolvedProfile {
            name: "atomic-strata-project".into(),
            base_url: "https://api.staging.example.com".into(),
            kind: ProfileKind::Local,
            project_id: None,
            memory_base_url: "http://127.0.0.1:17350".into(),
            api_key: None,
            oauth: None,
        };

        let oauth = oauth_profile_for_base_url(&active, &config, &creds, &active.base_url).unwrap();
        assert_eq!(oauth, "staging");
    }

    #[test]
    fn require_api_key_rejects_blank_secret() {
        let profile = ResolvedProfile {
            name: "cloud".into(),
            base_url: DEFAULT_CLOUD_URL.into(),
            kind: ProfileKind::Cloud,
            project_id: Some(TEST_PROJECT.into()),
            memory_base_url: DEFAULT_CLOUD_URL.into(),
            api_key: Some("  ".into()),
            oauth: None,
        };

        let err = require_api_key(&profile).unwrap_err();
        assert!(err.to_string().contains("missing API key"));
    }

    fn stored_key(secret: &str, origin: Option<&str>) -> ApiKeySecret {
        ApiKeySecret {
            secret: secret.into(),
            api_origin: origin.map(str::to_string),
            project_id: Some(TEST_PROJECT.into()),
        }
    }

    /// The project these origin-focused cases are linked to. They exercise the
    /// origin binding, so the project always matches and never masks the result.
    const TEST_PROJECT: &str = "proj_test";

    #[test]
    fn storage_records_the_acquisition_origin() {
        let bound = bind_session_origin(
            OAuthTokens {
                id_token: "t".into(),
                refresh_token: None,
                expires_at: None,
                issuer: None,
                api_origin: Some("https://api.stale.example".into()),
            },
            "https://api.a.example",
        );
        assert_eq!(bound.api_origin.as_deref(), Some("https://api.a.example"));

        let key = bind_key_origin("amc_x", "https://api.a.example", TEST_PROJECT);
        assert_eq!(key.api_origin.as_deref(), Some("https://api.a.example"));
        assert_eq!(key.secret, "amc_x");
    }

    #[test]
    fn stored_api_key_is_withheld_from_any_other_origin() {
        const PROD: &str = Environment::PROD_BASE_URL;
        let key = stored_key("amc_stored", Some(PROD));

        assert_eq!(
            select_api_key(None, Some(&key), PROD, Some(TEST_PROJECT)).as_deref(),
            Some("amc_stored")
        );
        for target in [
            "http://127.0.0.1:38767",
            "http://api.atomicstrata.ai",
            "https://api.atomicstrata.ai:8443",
            "https://api.staging.example.com",
        ] {
            assert_eq!(
                select_api_key(None, Some(&key), target, Some(TEST_PROJECT)),
                None,
                "stored key must not be sent to {target}"
            );
        }
    }

    #[test]
    fn repointing_the_profile_does_not_rebind_a_stored_key() {
        // The key records the origin it was minted against, so
        // `am config set base-url <other>` cannot make it travel: deriving the
        // origin from the profile's mutable base_url is exactly the bypass.
        let key = stored_key("amc_source_secret", Some("https://api.a.example"));
        assert_eq!(
            select_api_key(
                None,
                Some(&key),
                "https://api.b.example",
                Some(TEST_PROJECT)
            ),
            None
        );
        assert_eq!(
            select_api_key(
                None,
                Some(&key),
                "https://api.a.example",
                Some(TEST_PROJECT)
            )
            .as_deref(),
            Some("amc_source_secret")
        );
    }

    #[test]
    fn keys_without_a_recorded_origin_are_refused_everywhere() {
        let legacy = stored_key("amc_legacy", None);
        for target in [
            Environment::PROD_BASE_URL,
            "https://api.staging.example.com",
            "http://127.0.0.1:38767",
        ] {
            assert_eq!(
                select_api_key(None, Some(&legacy), target, Some(TEST_PROJECT)),
                None,
                "legacy key must not be trusted for {target}"
            );
        }
    }

    #[test]
    fn explicit_env_key_is_per_invocation_intent() {
        let key = stored_key("amc_stored", Some(Environment::PROD_BASE_URL));
        assert_eq!(
            select_api_key(
                Some("amc_env".into()),
                Some(&key),
                "https://api.staging.example.com",
                Some(TEST_PROJECT)
            )
            .as_deref(),
            Some("amc_env")
        );
    }

    #[test]
    fn config_round_trips_through_the_path_helpers() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");

        // Missing file reads as the built-in default rather than failing.
        assert!(
            read_config_at(&path)
                .unwrap()
                .profiles
                .contains_key(DEFAULT_PROFILE)
        );

        let mut file = default_config();
        file.core_image = Some("ghcr.io/example/core:test".into());
        write_config_at(&path, &file).unwrap();

        let reloaded = read_config_at(&path).unwrap();
        assert_eq!(
            reloaded.core_image.as_deref(),
            Some("ghcr.io/example/core:test")
        );
    }

    #[test]
    fn with_path_lock_serializes_read_modify_write_across_threads() {
        // The lost-update race this guards: without holding the lock across the
        // whole cycle, concurrent writers each read the same value and the last
        // write wins, so the total comes out lower than the writer count.
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("counter.txt");
        std::fs::write(&target, "0").unwrap();

        let writers = 8;
        let handles: Vec<_> = (0..writers)
            .map(|_| {
                let target = target.clone();
                std::thread::spawn(move || {
                    with_path_lock(&target, || {
                        let current: u32 = std::fs::read_to_string(&target)
                            .unwrap()
                            .trim()
                            .parse()
                            .unwrap();
                        // Widen the window a losing implementation would race in.
                        std::thread::sleep(std::time::Duration::from_millis(5));
                        std::fs::write(&target, (current + 1).to_string()).unwrap();
                        Ok(())
                    })
                    .unwrap();
                })
            })
            .collect();
        for handle in handles {
            handle.join().unwrap();
        }

        let total: u32 = std::fs::read_to_string(&target)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        assert_eq!(
            total, writers,
            "lock did not serialize the read-modify-write"
        );
    }
}
