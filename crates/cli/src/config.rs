//! Profile and credential storage (platform config dir — see `environment` docs).

use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::Write as _;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow, bail};
use fs4::fs_std::FileExt;
use serde::{Deserialize, Deserializer, Serialize};

use crate::auth::origin::check_api_key_origin;
use crate::environment::{BaseUrlInput, Environment, is_remote_cloud_api_url, resolve_base_url};

pub use crate::environment::ENV_CORE_IMAGE;

pub const ENV_PROFILE: &str = "ATOMICMEMORY_PROFILE";
pub const ENV_API_KEY: &str = "ATOMICMEMORY_API_KEY";
/// When truthy, `ATOMICMEMORY_API_KEY` overrides a bound Hosted Cloud profile key.
pub const ENV_API_KEY_FORCE: &str = "ATOMICMEMORY_API_KEY_FORCE";
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
    /// Stable per-install id used to name the Cloud API keys this machine owns.
    ///
    /// Lives in `config.toml`, not `credentials.toml`, so clearing credentials
    /// does not change which key this machine claims. Deliberately separate
    /// from `telemetry_distinct_id`: key names are visible in the dashboard and
    /// must not correlate an install with its telemetry identity.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cli_key_id: Option<String>,
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
    /// Init-managed Hosted Cloud marker. `Some(true)` is set by Hosted Cloud
    /// init; `Some(false)` marks a hand-created Cloud profile; absent (`None`)
    /// applies legacy inference for pre-marker init profiles only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hosted_cloud_managed: Option<bool>,
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
    ConfigStore::production()?.load()
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

fn api_key_force_enabled() -> bool {
    std::env::var(ENV_API_KEY_FORCE).ok().is_some_and(|value| {
        matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        )
    })
}

/// Credential ref written by Hosted Cloud init for a project (`hosted-cloud-<id>`).
pub(crate) fn hosted_cloud_init_credential_ref(project_id: &str) -> String {
    format!("hosted-cloud-{project_id}")
}

/// Pre-`hosted_cloud_managed` profiles activated by Hosted Cloud init.
///
/// Inference requires the init contract: Cloud kind, a project id, an
/// `api_key_ref` that exactly matches the init credential ref for that project,
/// and no explicit `hosted_cloud_managed = false`. Hand-created Cloud profiles
/// must set `hosted_cloud_managed = false` (via `am config profile add` or
/// `am key create --save`) even when the profile name matches the init ref.
fn legacy_init_managed_hosted_cloud_profile(profile: &ProfileConfig) -> bool {
    if profile.kind != ProfileKind::Cloud {
        return false;
    }
    matches!(
        (
            profile.project_id.as_deref(),
            profile.api_key_ref.as_deref(),
        ),
        (Some(project_id), Some(api_key_ref))
            if api_key_ref == hosted_cloud_init_credential_ref(project_id)
    )
}

/// Whether Hosted Cloud init key precedence applies to this profile.
pub(crate) fn hosted_cloud_managed_for_key_policy(profile: &ProfileConfig) -> bool {
    if profile.kind != ProfileKind::Cloud {
        return false;
    }
    match profile.hosted_cloud_managed {
        Some(true) => true,
        Some(false) => false,
        None => legacy_init_managed_hosted_cloud_profile(profile),
    }
}

/// Atomically require a Connected Local profile and link an export project id.
/// Identity of the profile an export was planned against, captured from the
/// raw config entry at resolve time. Compared inside the store's locked
/// mutation so a same-name replacement is rejected BEFORE its project binding
/// is overwritten — checking after the write already corrupted the
/// replacement's binding on the way to the abort.
///
/// Raw stored fields, not resolved ones: a resolved `base_url` can carry a
/// per-invocation `--base-url` override and `memory_base_url` is derived, so
/// comparing resolved values against the stored entry would reject legitimate
/// runs. `project_id` is deliberately absent — it is the field this store
/// exists to change.
/// Identity of the profile an export was planned against: the COMPLETE raw
/// config entry, captured from the same loaded ConfigFile the resolution used.
///
/// Compared inside the store's locked mutation so a same-name replacement is
/// rejected BEFORE its project binding is overwritten. Holding the full entry
/// rather than a field allowlist is what terminates the class: every previous
/// hole here was a field somebody forgot to compare (local_url, then
/// oauth_ref/api_key_ref/hosted_cloud_managed), and `mismatch` destructures
/// both entries exhaustively, so adding a field to ProfileConfig refuses to
/// compile until it is classified as identity or export-mutable.
///
/// `project_id` is the one export-mutable field — changing it is what the
/// store exists to do.
#[derive(Debug, Clone)]
pub struct ExpectedExportProfile {
    pub entry: ProfileConfig,
    /// The concrete OAuth session selected at planning time, from the same
    /// credentials read the resolution used. Execution authenticates with
    /// exactly this key and never re-selects: the Local fallback picks the
    /// credential map's first session, so re-running it at execution let a
    /// concurrent login redirect the export to a different same-origin
    /// account. `None` means no session existed at planning time; the
    /// dashboard step fails with the usual not-logged-in guidance.
    pub oauth_storage_key: Option<String>,
}

impl ExpectedExportProfile {
    /// Test-only convenience; production captures inside
    /// `resolve_profile_with_export_identity` from the same loaded config that
    /// resolution used, which this by-name lookup cannot guarantee.
    #[cfg(test)]
    pub fn capture(config: &ConfigFile, profile_name: &str) -> Result<Self> {
        let entry = config
            .profiles
            .get(profile_name)
            .ok_or_else(|| anyhow!("profile '{profile_name}' not found"))?;
        Ok(Self {
            entry: entry.clone(),
            oauth_storage_key: None,
        })
    }

    fn mismatch(&self, current: &ProfileConfig) -> Option<&'static str> {
        // Exhaustive on purpose — see the type docs. `..` is forbidden here.
        let ProfileConfig {
            base_url,
            kind,
            project_id: _, // export-mutable: this store's own write target
            api_key_ref,
            local_url,
            oauth_ref,
            hosted_cloud_managed,
        } = current;
        let ProfileConfig {
            base_url: expected_base_url,
            kind: expected_kind,
            project_id: _,
            api_key_ref: expected_api_key_ref,
            local_url: expected_local_url,
            oauth_ref: expected_oauth_ref,
            hosted_cloud_managed: expected_hosted_cloud_managed,
        } = &self.entry;
        if kind != expected_kind {
            return Some("kind");
        }
        if base_url != expected_base_url {
            return Some("base_url");
        }
        if local_url != expected_local_url {
            return Some("local_url");
        }
        if api_key_ref != expected_api_key_ref {
            return Some("api_key_ref");
        }
        if oauth_ref != expected_oauth_ref {
            return Some("oauth_ref");
        }
        if hosted_cloud_managed != expected_hosted_cloud_managed {
            return Some("hosted_cloud_managed");
        }
        None
    }
}

pub fn store_local_export_project_id(
    profile_name: &str,
    expected: &ExpectedExportProfile,
    project_id: &str,
) -> Result<()> {
    update_config(|config| {
        store_local_export_project_id_mut(config, profile_name, expected, project_id)
    })
}

fn store_local_export_project_id_mut(
    config: &mut ConfigFile,
    profile_name: &str,
    expected: &ExpectedExportProfile,
    project_id: &str,
) -> Result<()> {
    let entry = config
        .profiles
        .get_mut(profile_name)
        .ok_or_else(|| anyhow!("profile '{profile_name}' not found"))?;
    if entry.kind != ProfileKind::Local {
        bail!(
            "export requires an active Connected Local profile — active profile '{profile_name}' is Cloud"
        );
    }
    // Same lock as the write: reject a same-name replacement before touching
    // its binding, not after.
    if let Some(field) = expected.mismatch(entry) {
        bail!(
            "profile '{profile_name}' was replaced during export ({field} changed) — rerun `am migrate export`"
        );
    }
    entry.project_id = Some(project_id.to_string());
    Ok(())
}

#[cfg(test)]
pub(crate) fn store_local_export_project_id_in(
    store: &ConfigStore,
    profile_name: &str,
    expected: &ExpectedExportProfile,
    project_id: &str,
) -> Result<()> {
    store.update(|config| {
        store_local_export_project_id_mut(config, profile_name, expected, project_id)
    })
}

/// Stored key that matches the resolved origin and project binding, if any.
fn bound_stored_api_key(
    stored: Option<&ApiKeySecret>,
    resolved_base_url: &str,
    resolved_project_id: Option<&str>,
) -> Option<String> {
    let stored = stored?;
    match stored.api_origin.as_deref() {
        Some(origin) if check_api_key_origin(origin, resolved_base_url) => {}
        _ => return None,
    }
    match (stored.project_id.as_deref(), resolved_project_id) {
        (Some(issued_for), Some(target)) if issued_for == target => Some(stored.secret.clone()),
        _ => None,
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
/// Local profiles and hand-created Cloud profiles: an explicit
/// `ATOMICMEMORY_API_KEY` is per-invocation user intent, like a flag.
///
/// Init-managed Hosted Cloud profiles (`hosted-cloud-<project-id>` credential
/// refs from `am init`): the bound stored key wins over a stale shell export
/// unless `ATOMICMEMORY_API_KEY_FORCE=1`.
fn select_api_key(
    env_override: Option<String>,
    stored: Option<&ApiKeySecret>,
    resolved_base_url: &str,
    resolved_project_id: Option<&str>,
    init_managed_hosted: bool,
) -> Option<String> {
    select_api_key_with_force(
        env_override,
        stored,
        resolved_base_url,
        resolved_project_id,
        init_managed_hosted,
        api_key_force_enabled(),
    )
}

fn select_api_key_with_force(
    env_override: Option<String>,
    stored: Option<&ApiKeySecret>,
    resolved_base_url: &str,
    resolved_project_id: Option<&str>,
    init_managed_hosted: bool,
    force_env_override: bool,
) -> Option<String> {
    let env_override = env_override.filter(|value| !value.is_empty());
    if init_managed_hosted {
        let bound = bound_stored_api_key(stored, resolved_base_url, resolved_project_id);
        if force_env_override {
            return env_override.or(bound);
        }
        if let Some(secret) = bound {
            return Some(secret);
        }
        return env_override;
    }

    if let Some(key) = env_override {
        return Some(key);
    }
    bound_stored_api_key(stored, resolved_base_url, resolved_project_id)
}

/// Select which stored OAuth session a profile authenticates with.
///
/// One implementation shared by the by-name path and export planning, so the
/// two cannot drift: the named ref when present, any session for Local
/// profiles (BTreeMap order — first key), none otherwise.
pub(crate) fn select_oauth_session_key(
    creds: &CredentialsFile,
    oauth_ref: &str,
    allow_local_fallback: bool,
) -> Option<String> {
    if creds.oauth.contains_key(oauth_ref) {
        return Some(oauth_ref.to_string());
    }
    if allow_local_fallback {
        return creds.oauth.keys().next().cloned();
    }
    None
}

pub fn resolve_profile(
    profile_name: Option<&str>,
    base_url_override: Option<&str>,
    environment_override: Option<Environment>,
) -> Result<ResolvedProfile> {
    let config = load_config()?;
    let creds = load_credentials()?;
    resolve_profile_from(
        &config,
        &creds,
        profile_name,
        base_url_override,
        environment_override,
    )
}

/// Resolve the profile and capture its raw export identity from ONE config
/// read.
///
/// Resolving and then re-loading config.toml to capture the identity leaves a
/// filesystem-level gap: another PROCESS can replace the profile between the
/// two reads, so the resolved profile describes A while the captured identity
/// describes its replacement B — and the store's in-lock check then compares
/// B against B and happily writes A's project into it. "No await between them"
/// only rules out same-process interleaving. Deriving both from a single
/// loaded ConfigFile closes the class: the pair cannot disagree about which
/// generation it saw.
pub fn resolve_profile_with_export_identity(
    profile_name: Option<&str>,
    base_url_override: Option<&str>,
    environment_override: Option<Environment>,
) -> Result<(ResolvedProfile, ExpectedExportProfile)> {
    let config = load_config()?;
    let creds = load_credentials()?;
    let resolved = resolve_profile_from(
        &config,
        &creds,
        profile_name,
        base_url_override,
        environment_override,
    )?;
    // Mirror resolve_profile_from's missing-entry semantics (a synthesized
    // Cloud default) so a nonexistent profile still fails export on the kind
    // check with the same message as before, not on a lookup error here.
    let entry = config
        .profiles
        .get(&resolved.name)
        .cloned()
        .unwrap_or_else(|| ProfileConfig {
            base_url: Some(DEFAULT_CLOUD_URL.to_string()),
            kind: ProfileKind::Cloud,
            ..Default::default()
        });
    let oauth_ref = entry
        .oauth_ref
        .clone()
        .unwrap_or_else(|| resolved.name.clone());
    let oauth_storage_key =
        select_oauth_session_key(&creds, &oauth_ref, entry.kind == ProfileKind::Local);
    Ok((
        resolved,
        ExpectedExportProfile {
            entry,
            oauth_storage_key,
        },
    ))
}

pub(crate) fn resolve_profile_from(
    config: &ConfigFile,
    creds: &CredentialsFile,
    profile_name: Option<&str>,
    base_url_override: Option<&str>,
    environment_override: Option<Environment>,
) -> Result<ResolvedProfile> {
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

    let stored_kind = profile.kind;
    let local_memory_url = profile
        .local_url
        .clone()
        .unwrap_or_else(|| base_url.clone());

    // A stored `amc_` key belongs to the origin it was minted against, which is
    // the profile's own base URL (or the default when it has none). The
    // destination can be redirected per invocation by `--base-url` /
    // ATOMICMEMORY_API_URL, so the key is withheld unless the two agree — the
    // same invariant that governs session tokens, see `crate::auth::origin`.
    // An explicit ATOMICMEMORY_API_KEY is per-invocation user intent, like a
    // flag, and is passed through.
    let api_key_ref = profile.api_key_ref.clone().unwrap_or_else(|| name.clone());
    let init_managed_hosted = hosted_cloud_managed_for_key_policy(&profile);
    let env_api_key = std::env::var(ENV_API_KEY)
        .ok()
        .filter(|value| !value.is_empty());
    let api_key = select_api_key(
        env_api_key.clone(),
        creds.api_keys.get(&api_key_ref),
        &base_url,
        profile.project_id.as_deref(),
        init_managed_hosted,
    );

    let oauth_ref = profile.oauth_ref.clone().unwrap_or_else(|| name.clone());
    let oauth = creds.oauth.get(&oauth_ref).cloned();

    let ephemeral_cloud_override = ephemeral_cloud_override_applies(
        stored_kind,
        base_url_override,
        environment_override,
        &base_url,
        env_api_key.as_deref(),
    );

    let (kind, memory_base_url, project_id) = if ephemeral_cloud_override {
        (ProfileKind::Cloud, base_url.clone(), None)
    } else {
        let memory_base_url = match stored_kind {
            ProfileKind::Local => local_memory_url,
            ProfileKind::Cloud => base_url.clone(),
        };
        (stored_kind, memory_base_url, profile.project_id)
    };

    Ok(ResolvedProfile {
        name,
        base_url,
        kind,
        project_id,
        memory_base_url,
        api_key,
        oauth,
    })
}

/// Whether a stored Local profile should flip to Cloud for this invocation.
///
/// Requires an explicitly exported `amc_` key — stored Local trace-sync keys
/// must not satisfy this gate.
fn ephemeral_cloud_override_applies(
    stored_kind: ProfileKind,
    base_url_override: Option<&str>,
    environment_override: Option<Environment>,
    resolved_base_url: &str,
    env_api_key: Option<&str>,
) -> bool {
    let has_override_intent = base_url_override
        .filter(|value| !value.is_empty())
        .is_some()
        || environment_override.is_some();
    stored_kind == ProfileKind::Local
        && has_override_intent
        && is_remote_cloud_api_url(resolved_base_url)
        && env_api_key.is_some_and(is_cloud_api_key)
}

/// Warn when an init-managed Hosted Cloud profile ignores a stale `ATOMICMEMORY_API_KEY`.
pub fn hosted_cloud_env_key_override_warning(
    hosted_cloud_managed: bool,
    env_api_key: Option<&str>,
    stored: Option<&ApiKeySecret>,
    resolved_base_url: &str,
    project_id: Option<&str>,
) -> Option<String> {
    hosted_cloud_env_key_override_warning_with_force(
        hosted_cloud_managed,
        env_api_key,
        stored,
        resolved_base_url,
        project_id,
        api_key_force_enabled(),
    )
}

fn hosted_cloud_env_key_override_warning_with_force(
    hosted_cloud_managed: bool,
    env_api_key: Option<&str>,
    stored: Option<&ApiKeySecret>,
    resolved_base_url: &str,
    project_id: Option<&str>,
    force_env_override: bool,
) -> Option<String> {
    if !hosted_cloud_managed || force_env_override {
        return None;
    }
    let env = env_api_key.filter(|value| !value.is_empty())?;
    let stored_secret = bound_stored_api_key(stored, resolved_base_url, project_id)?;
    if env == stored_secret {
        return None;
    }
    Some(format!(
        "warning: {ENV_API_KEY} is set but ignored — Hosted Cloud uses the saved profile key. \
         Unset it or set {ENV_API_KEY_FORCE}=1 to override."
    ))
}

/// Warn when Cloud URL exports cannot override a stored Local profile.
pub fn local_profile_cloud_export_warning(
    stored_kind: ProfileKind,
    base_url_override: Option<&str>,
    resolved_base_url: &str,
    env_api_key: Option<&str>,
    local_memory_url: &str,
) -> Option<String> {
    if stored_kind != ProfileKind::Local {
        return None;
    }
    base_url_override.filter(|value| !value.is_empty())?;
    if !is_remote_cloud_api_url(resolved_base_url) {
        return None;
    }
    if env_api_key.is_some_and(is_cloud_api_key) {
        return None;
    }
    Some(format!(
        "warning: ATOMICMEMORY_API_URL points to Cloud ({resolved_base_url}) but the active profile is Local — \
         commands will use {local_memory_url} unless you set ATOMICMEMORY_API_KEY (amc_…) or switch profiles"
    ))
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
        store_api_key_profile_mut(config, profile_name);
        Ok(())
    })
}

fn store_api_key_profile_mut(config: &mut ConfigFile, profile_name: &str) {
    let entry = config.profiles.entry(profile_name.to_string()).or_default();
    let init_managed = hosted_cloud_managed_for_key_policy(entry);
    entry.api_key_ref = Some(profile_name.to_string());
    entry.hosted_cloud_managed = Some(init_managed);
}

/// Save a project-scoped Hosted Cloud key without changing the active profile.
pub(crate) fn store_hosted_cloud_api_key(
    credential_ref: &str,
    secret: &str,
    api_origin: &str,
    project_id: &str,
) -> Result<()> {
    let record = bind_key_origin(secret, api_origin, project_id);
    update_credentials(|creds| {
        creds.api_keys.insert(credential_ref.to_string(), record);
        Ok(())
    })
}

/// Activate Hosted Cloud only after its project credential is ready.
pub(crate) fn activate_hosted_cloud_profile(
    profile_name: &str,
    api_origin: &str,
    project_id: &str,
    oauth_ref: &str,
    credential_ref: &str,
) -> Result<()> {
    update_config(|config| {
        configure_hosted_cloud_profile(
            config,
            profile_name,
            api_origin,
            project_id,
            oauth_ref,
            credential_ref,
        )
    })
}

/// Refuse Hosted Cloud activation when its OAuth profile name belongs to Local.
pub(crate) fn ensure_hosted_cloud_profile_available(profile_name: &str) -> Result<()> {
    validate_hosted_cloud_profile(&load_config()?, profile_name)
}

fn validate_hosted_cloud_profile(config: &ConfigFile, profile_name: &str) -> Result<()> {
    if config
        .profiles
        .get(profile_name)
        .is_some_and(|profile| profile.kind == ProfileKind::Local)
    {
        bail!(
            "profile '{profile_name}' is Connected Local and cannot be overwritten by Hosted Cloud; rerun with an unused global profile, for example `am --profile hosted-cloud init`"
        );
    }
    Ok(())
}

fn configure_hosted_cloud_profile(
    config: &mut ConfigFile,
    profile_name: &str,
    api_origin: &str,
    project_id: &str,
    oauth_ref: &str,
    credential_ref: &str,
) -> Result<()> {
    validate_hosted_cloud_profile(config, profile_name)?;

    config.profiles.insert(
        profile_name.to_string(),
        ProfileConfig {
            base_url: Some(api_origin.to_string()),
            kind: ProfileKind::Cloud,
            project_id: Some(project_id.to_string()),
            api_key_ref: Some(credential_ref.to_string()),
            local_url: None,
            oauth_ref: Some(oauth_ref.to_string()),
            hosted_cloud_managed: Some(true),
        },
    );
    config.default_profile = Some(profile_name.to_string());
    Ok(())
}

/// Where an OpenAI key came from. Collapsing these to a bare `String` made
/// every override look like a stored credential: an `--openai-api-key` or
/// `OPENAI_API_KEY` value got written to `credentials.toml`, and a rejected
/// override deleted the stored key it never even tried.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenAiKeySource {
    /// Passed as `--openai-api-key` on this invocation.
    Flag,
    /// Read from `OPENAI_API_KEY` in the environment.
    Environment,
    /// Loaded from `credentials.toml` for this profile.
    Stored,
    /// Typed at the hidden prompt, which states that it will be saved.
    Prompted,
}

impl OpenAiKeySource {
    /// Only a prompted key is persisted. The prompt is the one place the user
    /// is told the key will be saved, so it is the only place that consents.
    pub fn should_persist(self) -> bool {
        matches!(self, Self::Prompted)
    }

    /// Only a rejected *stored* key may be cleared. A bad flag or environment
    /// value says nothing about the credential on disk.
    pub fn should_clear_stored(self) -> bool {
        matches!(self, Self::Stored)
    }
}

pub fn resolve_openai_api_key(profile_name: &str) -> Option<String> {
    resolve_openai_api_key_with_source(profile_name).map(|(key, _)| key)
}

/// Resolve the key and report which source supplied it. Environment still wins
/// over the stored credential; the difference is that the caller can now tell
/// them apart.
pub fn resolve_openai_api_key_with_source(profile_name: &str) -> Option<(String, OpenAiKeySource)> {
    std::env::var("OPENAI_API_KEY")
        .ok()
        .filter(|s| !s.is_empty())
        .map(|key| (key, OpenAiKeySource::Environment))
        .or_else(|| {
            load_credentials()
                .ok()
                .and_then(|c| {
                    c.profile_secrets
                        .get(profile_name)
                        .and_then(|s| s.openai_api_key.clone())
                })
                .filter(|s| !s.is_empty())
                .map(|key| (key, OpenAiKeySource::Stored))
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

pub fn clear_openai_api_key(profile_name: &str) -> Result<()> {
    update_credentials(|creds| {
        if let Some(secrets) = creds.profile_secrets.get_mut(profile_name) {
            secrets.openai_api_key = None;
        }
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
        cli_key_id: None,
        integrations: BTreeMap::new(),
    }
}

/// Stable id for the Cloud API keys this machine owns.
///
/// Read-or-create under a single `update_config` lock so two concurrent
/// invocations agree on one id instead of each writing its own.
pub fn machine_key_id() -> Result<String> {
    machine_key_id_with(&ConfigStore::production()?)
}

fn machine_key_id_with(store: &ConfigStore) -> Result<String> {
    store.update(|cfg| {
        if let Some(id) = cfg.cli_key_id.clone() {
            if !is_valid_machine_key_id(&id) {
                bail!(
                    "invalid cli_key_id in config.toml: expected exactly 12 lowercase hexadecimal characters"
                );
            }
            return Ok(id);
        }
        let id = random_key_id();
        cfg.cli_key_id = Some(id.clone());
        Ok(id)
    })
}

fn random_key_id() -> String {
    use rand::Rng as _;
    let mut bytes = [0u8; 6];
    rand::rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn is_valid_machine_key_id(id: &str) -> bool {
    id.len() == 12
        && id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// Name the key this machine owns, e.g. `am-cli-9f2c1a4b7e05`.
///
/// Key provisioning rotates an existing key rather than creating a new one, to
/// stay inside the project's key quota. Rotation invalidates the old secret, so
/// selecting by a shared name meant a second machine's first `am init` rotated
/// the key the first machine was actively using and broke it. Scoping the name
/// to this install means a machine can only ever rotate a key it owns.
pub fn machine_scoped_key_name(base: &str) -> Result<String> {
    Ok(machine_scoped_key_name_with(base, &machine_key_id()?))
}

fn machine_scoped_key_name_with(base: &str, id: &str) -> String {
    format!("{base}-{id}")
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

    /// Why migrate export must refresh the profile after binding the project.
    ///
    /// `am key create --project <id> --save` binds the credential to a project
    /// without setting the profile's project_id, so until something writes that
    /// binding the key is unusable. Export performs that write itself, which is
    /// why it cannot keep using the snapshot it took beforehand.
    #[test]
    fn stored_key_needs_the_profile_project_to_be_set() {
        let stored = key_for("https://api.atomicstrata.ai/", "proj_a");
        assert_eq!(
            super::bound_stored_api_key(Some(&stored), "https://api.atomicstrata.ai/", None),
            None,
            "no resolved project means the bound key is withheld"
        );
        assert_eq!(
            super::bound_stored_api_key(
                Some(&stored),
                "https://api.atomicstrata.ai/",
                Some("proj_a")
            )
            .as_deref(),
            Some("amc_live_example"),
            "once the profile names the same project the key resolves"
        );
        // A different project must still be refused.
        assert_eq!(
            super::bound_stored_api_key(
                Some(&stored),
                "https://api.atomicstrata.ai/",
                Some("proj_b")
            ),
            None
        );
    }

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
            false,
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
            false,
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
            false,
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
            false,
        );
        assert_eq!(selected, None, "an unproven binding must not be trusted");
    }

    /// Local profiles still treat an explicit env override as per-invocation intent.
    #[test]
    fn an_explicit_env_key_still_passes_through_for_local() {
        let stored = key_for("https://api.atomicstrata.ai", "proj_a");
        let selected = select_api_key(
            Some("amc_from_env".into()),
            Some(&stored),
            "https://api.atomicstrata.ai",
            Some("proj_b"),
            false,
        );
        assert_eq!(selected.as_deref(), Some("amc_from_env"));
    }

    /// Hand-created Cloud profiles (`am config profile add --kind cloud`) keep
    /// explicit env override even when a bound stored key exists.
    #[test]
    fn custom_cloud_profile_honors_explicit_env_over_bound_stored() {
        let stored = key_for("https://api.atomicstrata.ai", "proj_a");
        let selected = select_api_key(
            Some("amc_from_env".into()),
            Some(&stored),
            "https://api.atomicstrata.ai",
            Some("proj_a"),
            false,
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
            select_api_key(None, Some(&key), PROD, Some(TEST_PROJECT), false).as_deref(),
            Some("amc_stored")
        );
        for target in [
            "http://127.0.0.1:38767",
            "http://api.atomicstrata.ai",
            "https://api.atomicstrata.ai:8443",
            "https://api.staging.example.com",
        ] {
            assert_eq!(
                select_api_key(None, Some(&key), target, Some(TEST_PROJECT), false),
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
                Some(TEST_PROJECT),
                false,
            ),
            None
        );
        assert_eq!(
            select_api_key(
                None,
                Some(&key),
                "https://api.a.example",
                Some(TEST_PROJECT),
                false,
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
                select_api_key(None, Some(&legacy), target, Some(TEST_PROJECT), false),
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
                Some(TEST_PROJECT),
                false,
            )
            .as_deref(),
            Some("amc_env")
        );
    }

    #[test]
    fn legacy_pre_marker_toml_prefers_stored_key_over_stale_env() {
        let raw = r#"
kind = "cloud"
base_url = "https://api.atomicstrata.ai"
project_id = "proj_a"
api_key_ref = "hosted-cloud-proj_a"
"#;
        let profile: ProfileConfig = toml::from_str(raw).expect("parse legacy profile");
        assert_eq!(profile.hosted_cloud_managed, None);
        assert!(hosted_cloud_managed_for_key_policy(&profile));
        let stored = key_for("https://api.atomicstrata.ai", "proj_a");
        let selected = select_api_key_with_force(
            Some("amc_stale_env".into()),
            Some(&stored),
            "https://api.atomicstrata.ai",
            Some("proj_a"),
            hosted_cloud_managed_for_key_policy(&profile),
            false,
        );
        assert_eq!(selected.as_deref(), Some("amc_live_example"));
    }

    #[test]
    fn legacy_inference_does_not_match_hand_created_cloud_profile() {
        let profile = ProfileConfig {
            base_url: Some("https://api.atomicstrata.ai".into()),
            kind: ProfileKind::Cloud,
            project_id: Some("proj_a".into()),
            api_key_ref: Some("my-cloud-profile".into()),
            ..Default::default()
        };
        assert!(!hosted_cloud_managed_for_key_policy(&profile));
        let stored = key_for("https://api.atomicstrata.ai", "proj_a");
        let selected = select_api_key_with_force(
            Some("amc_from_env".into()),
            Some(&stored),
            "https://api.atomicstrata.ai",
            Some("proj_a"),
            hosted_cloud_managed_for_key_policy(&profile),
            false,
        );
        assert_eq!(selected.as_deref(), Some("amc_from_env"));
    }

    #[test]
    fn explicit_false_manual_hosted_cloud_ref_honors_env_key() {
        let raw = r#"
kind = "cloud"
base_url = "https://api.atomicstrata.ai"
project_id = "proj_a"
api_key_ref = "hosted-cloud-proj_a"
hosted_cloud_managed = false
"#;
        let profile: ProfileConfig = toml::from_str(raw).expect("parse manual profile");
        assert_eq!(profile.hosted_cloud_managed, Some(false));
        assert!(!hosted_cloud_managed_for_key_policy(&profile));
        let stored = key_for("https://api.atomicstrata.ai", "proj_a");
        let selected = select_api_key_with_force(
            Some("amc_from_env".into()),
            Some(&stored),
            "https://api.atomicstrata.ai",
            Some("proj_a"),
            hosted_cloud_managed_for_key_policy(&profile),
            false,
        );
        assert_eq!(selected.as_deref(), Some("amc_from_env"));
    }

    #[test]
    fn legacy_init_profile_stays_managed_after_key_save() {
        let mut config = default_config_for_test();
        config.profiles.insert(
            "cloud".into(),
            ProfileConfig {
                base_url: Some(Environment::PROD_BASE_URL.into()),
                kind: ProfileKind::Cloud,
                project_id: Some("proj_a".into()),
                api_key_ref: Some(hosted_cloud_init_credential_ref("proj_a")),
                ..Default::default()
            },
        );
        assert!(hosted_cloud_managed_for_key_policy(
            config.profiles.get("cloud").unwrap()
        ));
        store_api_key_profile_mut(&mut config, "cloud");
        let profile = &config.profiles["cloud"];
        assert_eq!(profile.hosted_cloud_managed, Some(true));
        assert_eq!(profile.api_key_ref.as_deref(), Some("cloud"));
        assert!(hosted_cloud_managed_for_key_policy(profile));
        let stored = key_for(Environment::PROD_BASE_URL, "proj_a");
        let selected = select_api_key_with_force(
            Some("amc_stale_env".into()),
            Some(&stored),
            Environment::PROD_BASE_URL,
            Some("proj_a"),
            hosted_cloud_managed_for_key_policy(profile),
            false,
        );
        assert_eq!(selected.as_deref(), Some("amc_live_example"));
    }

    #[test]
    fn manual_false_profile_stays_manual_after_key_save() {
        let mut config = default_config_for_test();
        config.profiles.insert(
            "hosted-cloud-proj_a".into(),
            ProfileConfig {
                base_url: Some(Environment::PROD_BASE_URL.into()),
                kind: ProfileKind::Cloud,
                project_id: Some("proj_a".into()),
                api_key_ref: Some(hosted_cloud_init_credential_ref("proj_a")),
                hosted_cloud_managed: Some(false),
                ..Default::default()
            },
        );
        store_api_key_profile_mut(&mut config, "hosted-cloud-proj_a");
        let profile = &config.profiles["hosted-cloud-proj_a"];
        assert_eq!(profile.hosted_cloud_managed, Some(false));
        assert!(!hosted_cloud_managed_for_key_policy(profile));
        let stored = key_for(Environment::PROD_BASE_URL, "proj_a");
        let selected = select_api_key_with_force(
            Some("amc_from_env".into()),
            Some(&stored),
            Environment::PROD_BASE_URL,
            Some("proj_a"),
            hosted_cloud_managed_for_key_policy(profile),
            false,
        );
        assert_eq!(selected.as_deref(), Some("amc_from_env"));
    }

    #[test]
    fn local_profile_ignores_stale_hosted_cloud_managed_marker() {
        let profile = ProfileConfig {
            kind: ProfileKind::Local,
            hosted_cloud_managed: Some(true),
            ..Default::default()
        };
        assert!(!hosted_cloud_managed_for_key_policy(&profile));
        let stored = key_for(Environment::PROD_BASE_URL, "proj_a");
        let selected = select_api_key_with_force(
            Some("amc_from_env".into()),
            Some(&stored),
            Environment::PROD_BASE_URL,
            Some("proj_a"),
            hosted_cloud_managed_for_key_policy(&profile),
            false,
        );
        assert_eq!(selected.as_deref(), Some("amc_from_env"));
    }

    #[test]
    fn load_does_not_persist_hosted_cloud_managed_marker() {
        let dir = tempfile::tempdir().unwrap();
        let store = ConfigStore::at(dir.path().join("config.toml"));
        let raw = r#"
default_profile = "cloud"

[profiles.cloud]
kind = "cloud"
base_url = "https://api.atomicstrata.ai"
project_id = "proj_a"
api_key_ref = "hosted-cloud-proj_a"
"#;
        std::fs::write(store.path(), raw).unwrap();
        let loaded = store.load().unwrap();
        assert_eq!(loaded.profiles["cloud"].hosted_cloud_managed, None);
        assert!(hosted_cloud_managed_for_key_policy(
            &loaded.profiles["cloud"]
        ));
        let disk = std::fs::read_to_string(store.path()).unwrap();
        assert!(
            !disk.contains("hosted_cloud_managed"),
            "load must not rewrite config.toml"
        );
    }

    #[test]
    fn export_store_rejects_replacement_on_every_identity_field() {
        // The comparator destructures ProfileConfig exhaustively, so this
        // matrix plus the compiler covers the whole struct: every field except
        // project_id is identity, and a replacement differing in ANY of them
        // is rejected without mutation. project_id alone must be accepted —
        // rewriting it is what the store is for.
        let baseline = || ProfileConfig {
            kind: ProfileKind::Local,
            base_url: Some("https://a.example/".into()),
            local_url: Some("http://127.0.0.1:17350".into()),
            project_id: Some("proj_old".into()),
            api_key_ref: Some("key-a".into()),
            oauth_ref: Some("oauth-a".into()),
            hosted_cloud_managed: None,
        };
        let cases: Vec<(&str, ProfileConfig)> = vec![
            (
                "kind",
                ProfileConfig {
                    kind: ProfileKind::Cloud,
                    ..baseline()
                },
            ),
            (
                "base_url",
                ProfileConfig {
                    base_url: Some("https://b.example/".into()),
                    ..baseline()
                },
            ),
            (
                "local_url",
                ProfileConfig {
                    local_url: Some("http://127.0.0.1:9999".into()),
                    ..baseline()
                },
            ),
            (
                "api_key_ref",
                ProfileConfig {
                    api_key_ref: Some("key-b".into()),
                    ..baseline()
                },
            ),
            (
                "oauth_ref",
                ProfileConfig {
                    oauth_ref: None,
                    ..baseline()
                },
            ),
            (
                "hosted_cloud_managed",
                ProfileConfig {
                    hosted_cloud_managed: Some(false),
                    ..baseline()
                },
            ),
        ];
        for (field, replacement) in cases {
            let dir = tempfile::tempdir().unwrap();
            let store = ConfigStore::at(dir.path().join("config.toml"));
            let mut cfg = default_config_for_test();
            cfg.profiles.insert("local".into(), baseline());
            store
                .update(|config| {
                    *config = cfg.clone();
                    Ok(())
                })
                .unwrap();
            let expected = ExpectedExportProfile::capture(&store.load().unwrap(), "local").unwrap();
            store
                .update(|config| {
                    config.profiles.insert("local".into(), replacement.clone());
                    Ok(())
                })
                .unwrap();
            let result = store_local_export_project_id_in(&store, "local", &expected, "proj_new");
            if replacement.kind != ProfileKind::Local {
                // The kind bail fires first with its own message; still no write.
                assert!(result.is_err(), "{field}: replacement must be rejected");
            } else {
                let err = result.unwrap_err().to_string();
                assert!(
                    err.contains(&format!("{field} changed")),
                    "{field}: expected named rejection, got: {err}"
                );
            }
            // The replacement survives untouched either way.
            let after = store.load().unwrap().profiles["local"].clone();
            assert_eq!(
                after.project_id, replacement.project_id,
                "{field}: replacement binding must not be overwritten"
            );
        }

        // project_id alone differing is NOT a replacement.
        let dir = tempfile::tempdir().unwrap();
        let store = ConfigStore::at(dir.path().join("config.toml"));
        let mut cfg = default_config_for_test();
        cfg.profiles.insert("local".into(), baseline());
        store
            .update(|config| {
                *config = cfg;
                Ok(())
            })
            .unwrap();
        let expected = ExpectedExportProfile::capture(&store.load().unwrap(), "local").unwrap();
        store
            .update(|config| {
                config.profiles.get_mut("local").unwrap().project_id = Some("proj_drift".into());
                Ok(())
            })
            .unwrap();
        store_local_export_project_id_in(&store, "local", &expected, "proj_new").unwrap();
        assert_eq!(
            store.load().unwrap().profiles["local"]
                .project_id
                .as_deref(),
            Some("proj_new")
        );
    }

    #[test]
    fn export_store_rejects_same_name_replacement_without_mutation() {
        // The atomicity property: the identity check runs inside the same
        // locked mutation as the write. Checking after the store already
        // overwrote the replacement's project binding on the way to the abort.
        let dir = tempfile::tempdir().unwrap();
        let store = ConfigStore::at(dir.path().join("config.toml"));
        let mut cfg = default_config_for_test();
        cfg.profiles.insert(
            "local".into(),
            ProfileConfig {
                kind: ProfileKind::Local,
                base_url: Some("https://a.example/".into()),
                local_url: Some("http://127.0.0.1:17350".into()),
                project_id: Some("proj_a_old".into()),
                ..Default::default()
            },
        );
        store
            .update(|config| {
                *config = cfg;
                Ok(())
            })
            .unwrap();
        // Export plans against A…
        let expected = ExpectedExportProfile::capture(&store.load().unwrap(), "local").unwrap();
        // …and A is then replaced by a different Local B under the same name,
        // exactly what `am config profile add` does.
        let profile_b = ProfileConfig {
            kind: ProfileKind::Local,
            base_url: Some("https://b.example/".into()),
            local_url: Some("http://127.0.0.1:9999".into()),
            project_id: Some("proj_b".into()),
            ..Default::default()
        };
        store
            .update(|config| {
                config.profiles.insert("local".into(), profile_b.clone());
                Ok(())
            })
            .unwrap();

        let err = store_local_export_project_id_in(&store, "local", &expected, "proj_a_selected")
            .unwrap_err();
        assert!(err.to_string().contains("replaced during export"));
        assert!(err.to_string().contains("base_url changed"));
        // B survives byte-for-byte — its binding was NOT overwritten first.
        let after = store.load().unwrap().profiles["local"].clone();
        assert_eq!(after.project_id.as_deref(), Some("proj_b"));
        assert_eq!(after.base_url.as_deref(), Some("https://b.example/"));
        assert_eq!(after.local_url.as_deref(), Some("http://127.0.0.1:9999"));
    }

    #[test]
    fn export_store_writes_when_identity_matches() {
        // The identity fields exclude project_id by construction: changing it
        // is what this store is for, so a differing prior binding must not be
        // read as a replacement.
        let dir = tempfile::tempdir().unwrap();
        let store = ConfigStore::at(dir.path().join("config.toml"));
        let mut cfg = default_config_for_test();
        cfg.profiles.insert(
            "local".into(),
            ProfileConfig {
                kind: ProfileKind::Local,
                local_url: Some("http://127.0.0.1:17350".into()),
                project_id: Some("proj_old".into()),
                ..Default::default()
            },
        );
        store
            .update(|config| {
                *config = cfg;
                Ok(())
            })
            .unwrap();
        let expected = ExpectedExportProfile::capture(&store.load().unwrap(), "local").unwrap();
        store_local_export_project_id_in(&store, "local", &expected, "proj_new").unwrap();
        assert_eq!(
            store.load().unwrap().profiles["local"]
                .project_id
                .as_deref(),
            Some("proj_new")
        );
    }

    #[test]
    fn store_local_export_project_id_rejects_cloud_without_mutation() {
        let dir = tempfile::tempdir().unwrap();
        let store = ConfigStore::at(dir.path().join("config.toml"));
        let mut cfg = default_config_for_test();
        cfg.profiles.insert(
            "cloud".into(),
            ProfileConfig {
                kind: ProfileKind::Cloud,
                project_id: Some("proj_before".into()),
                ..Default::default()
            },
        );
        store
            .update(|config| {
                *config = cfg;
                Ok(())
            })
            .unwrap();
        store_local_export_project_id_in(
            &store,
            "cloud",
            &ExpectedExportProfile::capture(&store.load().unwrap(), "cloud").unwrap(),
            "proj_after",
        )
        .unwrap_err();
        assert_eq!(
            store.load().unwrap().profiles["cloud"]
                .project_id
                .as_deref(),
            Some("proj_before")
        );
    }

    #[test]
    fn init_managed_hosted_cloud_prefers_bound_stored_over_stale_env() {
        let stored = key_for("https://api.atomicstrata.ai", "proj_a");
        let selected = select_api_key_with_force(
            Some("amc_stale_env".into()),
            Some(&stored),
            "https://api.atomicstrata.ai",
            Some("proj_a"),
            true,
            false,
        );
        assert_eq!(selected.as_deref(), Some("amc_live_example"));
    }

    #[test]
    fn hosted_cloud_named_profile_without_marker_honors_explicit_env() {
        let stored = key_for("https://api.atomicstrata.ai", "proj_a");
        let selected = select_api_key_with_force(
            Some("amc_from_env".into()),
            Some(&stored),
            "https://api.atomicstrata.ai",
            Some("proj_a"),
            false,
            false,
        );
        assert_eq!(selected.as_deref(), Some("amc_from_env"));
    }

    #[test]
    fn init_managed_hosted_cloud_env_force_restores_override() {
        let stored = key_for("https://api.atomicstrata.ai", "proj_a");
        let selected = select_api_key_with_force(
            Some("amc_from_env".into()),
            Some(&stored),
            "https://api.atomicstrata.ai",
            Some("proj_a"),
            true,
            true,
        );
        assert_eq!(selected.as_deref(), Some("amc_from_env"));
    }

    #[test]
    fn empty_env_is_treated_as_unset_for_init_managed_hosted_cloud() {
        let stored = key_for("https://api.atomicstrata.ai", "proj_a");
        let selected = select_api_key_with_force(
            Some(String::new()),
            Some(&stored),
            "https://api.atomicstrata.ai",
            Some("proj_a"),
            true,
            false,
        );
        assert_eq!(selected.as_deref(), Some("amc_live_example"));
    }

    #[test]
    fn hosted_cloud_env_key_override_warning_when_env_differs() {
        let stored = key_for("https://api.atomicstrata.ai", "proj_a");
        let warning = super::hosted_cloud_env_key_override_warning(
            true,
            Some("amc_stale"),
            Some(&stored),
            "https://api.atomicstrata.ai",
            Some("proj_a"),
        )
        .expect("expected warning");
        assert!(warning.contains(ENV_API_KEY));
        assert!(warning.contains(ENV_API_KEY_FORCE));
    }

    #[test]
    fn hosted_cloud_env_key_override_warning_suppressed_for_custom_cloud_profile() {
        let stored = key_for("https://api.atomicstrata.ai", "proj_a");
        assert!(
            super::hosted_cloud_env_key_override_warning(
                false,
                Some("amc_stale"),
                Some(&stored),
                "https://api.atomicstrata.ai",
                Some("proj_a"),
            )
            .is_none()
        );
    }

    #[test]
    fn hosted_cloud_env_key_override_warning_suppressed_when_env_matches() {
        let stored = key_for("https://api.atomicstrata.ai", "proj_a");
        assert!(
            super::hosted_cloud_env_key_override_warning(
                true,
                Some("amc_live_example"),
                Some(&stored),
                "https://api.atomicstrata.ai",
                Some("proj_a"),
            )
            .is_none()
        );
    }

    #[test]
    fn hosted_cloud_env_key_override_warning_suppressed_with_force() {
        let stored = key_for("https://api.atomicstrata.ai", "proj_a");
        assert!(
            super::hosted_cloud_env_key_override_warning_with_force(
                true,
                Some("amc_stale"),
                Some(&stored),
                "https://api.atomicstrata.ai",
                Some("proj_a"),
                true,
            )
            .is_none()
        );
    }

    #[test]
    fn local_profile_cloud_export_warning_when_cloud_url_without_cloud_key() {
        let warning = super::local_profile_cloud_export_warning(
            ProfileKind::Local,
            Some(Environment::PROD_BASE_URL),
            Environment::PROD_BASE_URL,
            None,
            "http://127.0.0.1:17350",
        )
        .expect("expected warning");
        assert!(warning.contains("active profile is Local"));
        assert!(warning.contains("127.0.0.1:17350"));
    }

    #[test]
    fn local_profile_cloud_export_warning_is_suppressed_with_exported_cloud_key() {
        assert!(
            super::local_profile_cloud_export_warning(
                ProfileKind::Local,
                Some(Environment::PROD_BASE_URL),
                Environment::PROD_BASE_URL,
                Some("amc_dashboard_key"),
                "http://127.0.0.1:17350",
            )
            .is_none()
        );
    }

    #[test]
    fn ephemeral_cloud_override_requires_exported_amc_key() {
        assert!(!ephemeral_cloud_override_applies(
            ProfileKind::Local,
            Some(Environment::PROD_BASE_URL),
            None,
            Environment::PROD_BASE_URL,
            None,
        ));
        assert!(!ephemeral_cloud_override_applies(
            ProfileKind::Local,
            Some(Environment::PROD_BASE_URL),
            None,
            Environment::PROD_BASE_URL,
            Some("core_local_key"),
        ));
        assert!(ephemeral_cloud_override_applies(
            ProfileKind::Local,
            Some(Environment::PROD_BASE_URL),
            None,
            Environment::PROD_BASE_URL,
            Some("amc_dashboard_key"),
        ));
        assert!(!ephemeral_cloud_override_applies(
            ProfileKind::Local,
            Some(""),
            None,
            Environment::PROD_BASE_URL,
            Some("amc_dashboard_key"),
        ));
        assert!(ephemeral_cloud_override_applies(
            ProfileKind::Local,
            None,
            Some(Environment::Prod),
            Environment::PROD_BASE_URL,
            Some("amc_dashboard_key"),
        ));
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
    fn machine_key_id_is_twelve_lowercase_hex_and_persisted() {
        let dir = tempfile::tempdir().unwrap();
        let store = ConfigStore::at(dir.path().join("config.toml"));

        let first = machine_key_id_with(&store).unwrap();
        let second = machine_key_id_with(&store).unwrap();

        assert_eq!(first, second);
        assert_eq!(first.len(), 12);
        assert!(
            first
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        );
        assert_eq!(
            store.load().unwrap().cli_key_id.as_deref(),
            Some(first.as_str())
        );
    }

    #[test]
    fn machine_key_id_rejects_malformed_persisted_values() {
        let dir = tempfile::tempdir().unwrap();
        let store = ConfigStore::at(dir.path().join("config.toml"));
        let mut file = default_config();
        file.cli_key_id = Some("ABC123".into());
        write_config_at(store.path(), &file).unwrap();

        let error = machine_key_id_with(&store).unwrap_err();

        assert!(
            error
                .to_string()
                .contains("exactly 12 lowercase hexadecimal")
        );
        assert_eq!(store.load().unwrap().cli_key_id.as_deref(), Some("ABC123"));
    }

    #[test]
    fn machine_scoped_key_name_uses_the_complete_identifier() {
        assert_eq!(
            machine_scoped_key_name_with("am-cli", "a1b2c3d4e5f6"),
            "am-cli-a1b2c3d4e5f6"
        );
        assert_eq!(
            machine_scoped_key_name_with("connected-local-runtime", "a1b2c3d4e5f6"),
            "connected-local-runtime-a1b2c3d4e5f6"
        );
    }

    #[cfg(unix)]
    #[test]
    fn credentials_are_written_with_owner_only_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("credentials.toml");
        let mut credentials = CredentialsFile::default();
        credentials.api_keys.insert(
            "hosted-cloud-proj_a".into(),
            key_for(DEFAULT_CLOUD_URL, "proj_a"),
        );

        write_credentials_at(&path, &credentials).unwrap();

        assert_eq!(
            std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[test]
    fn hosted_cloud_activation_preserves_local_profiles() {
        let mut config = default_config();
        config.profiles.insert(
            "local-work".into(),
            ProfileConfig {
                base_url: Some(DEFAULT_CLOUD_URL.into()),
                kind: ProfileKind::Local,
                project_id: Some("proj_local".into()),
                api_key_ref: Some("local-work".into()),
                local_url: Some("http://127.0.0.1:17350".into()),
                oauth_ref: Some("cloud".into()),
                ..Default::default()
            },
        );
        let local_before = toml::to_string(&config.profiles["local-work"]).unwrap();

        configure_hosted_cloud_profile(
            &mut config,
            "cloud",
            DEFAULT_CLOUD_URL,
            "proj_cloud",
            "cloud",
            "hosted-cloud-proj_cloud",
        )
        .unwrap();

        assert_eq!(
            toml::to_string(&config.profiles["local-work"]).unwrap(),
            local_before
        );
        let cloud = &config.profiles["cloud"];
        assert_eq!(cloud.kind, ProfileKind::Cloud);
        assert_eq!(cloud.project_id.as_deref(), Some("proj_cloud"));
        assert_eq!(
            cloud.api_key_ref.as_deref(),
            Some("hosted-cloud-proj_cloud")
        );
        assert_eq!(cloud.hosted_cloud_managed, Some(true));
        assert!(cloud.local_url.is_none());
        assert_eq!(config.default_profile.as_deref(), Some("cloud"));
    }

    #[test]
    fn hosted_cloud_activation_never_overwrites_a_local_target_profile() {
        let mut config = default_config();
        config.profiles.insert(
            "cloud".into(),
            ProfileConfig {
                kind: ProfileKind::Local,
                local_url: Some("http://127.0.0.1:17350".into()),
                ..Default::default()
            },
        );
        let before = toml::to_string(&config).unwrap();

        let error = configure_hosted_cloud_profile(
            &mut config,
            "cloud",
            DEFAULT_CLOUD_URL,
            "proj_cloud",
            "cloud",
            "hosted-cloud-proj_cloud",
        )
        .unwrap_err();

        assert!(error.to_string().contains("unused global profile"));
        assert_eq!(toml::to_string(&config).unwrap(), before);
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
