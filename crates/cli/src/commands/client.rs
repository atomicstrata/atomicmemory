//! Shared client builders for command handlers.

use am_cloud_client::{DashboardClient, MemoryClient};
use anyhow::{Context, Result};
use url::Url;

use crate::auth::token::valid_bearer_token;
use crate::cli::GlobalOptions;
use crate::config::{
    DEFAULT_PROFILE, ENV_API_KEY, ENV_PROFILE, ProfileKind, ResolvedProfile,
    hosted_cloud_env_key_override_warning, hosted_cloud_managed_for_key_policy, is_cloud_api_key,
    load_config, load_credentials, local_profile_cloud_export_warning, require_api_key,
    resolve_core_api_key, resolve_profile,
};
use crate::output::message;

pub async fn resolve_ctx(global: &GlobalOptions) -> Result<ResolvedProfile> {
    resolve_profile_and_warn(global)
}

/// Resolve the active profile and print a warning when Cloud URL exports cannot
/// override a stored Local default (same logic as `resolve_ctx`, for commands
/// that call `resolve_profile` directly).
pub fn resolve_profile_and_warn(global: &GlobalOptions) -> Result<ResolvedProfile> {
    let config = load_config()?;
    let profile_name = global
        .profile
        .as_deref()
        .map(str::to_string)
        .or_else(|| std::env::var(ENV_PROFILE).ok())
        .or_else(|| config.default_profile.clone())
        .unwrap_or_else(|| DEFAULT_PROFILE.to_string());
    let stored_kind = config
        .profiles
        .get(&profile_name)
        .map(|p| p.kind)
        .unwrap_or_default();

    let profile = resolve_profile(
        global.profile.as_deref(),
        global.base_url.as_deref(),
        global.environment,
    )?;

    emit_cloud_export_warning_if_needed(global, stored_kind, &profile);
    Ok(profile)
}

/// Warn when Cloud URL exports cannot override a stored Local profile, or when a
/// Hosted Cloud profile ignores a stale `ATOMICMEMORY_API_KEY`.
pub fn emit_cloud_export_warning_if_needed(
    global: &GlobalOptions,
    stored_kind: crate::config::ProfileKind,
    profile: &ResolvedProfile,
) {
    if let Some(warning) = local_profile_cloud_export_warning(
        stored_kind,
        global.base_url.as_deref(),
        &profile.base_url,
        std::env::var(ENV_API_KEY).ok().as_deref(),
        &profile.memory_base_url,
    ) {
        message(!global.quiet, &warning);
    }

    if let (Ok(config), Ok(creds)) = (load_config(), load_credentials()) {
        let api_key_ref = config
            .profiles
            .get(&profile.name)
            .and_then(|entry| entry.api_key_ref.clone())
            .unwrap_or_else(|| profile.name.clone());
        if let Some(warning) = hosted_cloud_env_key_override_warning(
            config
                .profiles
                .get(&profile.name)
                .map(hosted_cloud_managed_for_key_policy)
                .unwrap_or(false),
            std::env::var(ENV_API_KEY).ok().as_deref(),
            creds.api_keys.get(&api_key_ref),
            &profile.base_url,
            profile.project_id.as_deref(),
        ) {
            message(!global.quiet, &warning);
        }
    }
}

pub async fn dashboard_client(
    global: &GlobalOptions,
) -> Result<(ResolvedProfile, DashboardClient)> {
    let profile = resolve_ctx(global).await?;
    let client = dashboard_client_for_profile(&profile).await?;
    Ok((profile, client))
}

/// Build a dashboard client for an already-resolved profile.
///
/// Callers that also touch memory must pin both to one resolution; resolving
/// again reopens `config.toml`, and the active profile can change in between.
pub(crate) async fn dashboard_client_for_profile(
    profile: &ResolvedProfile,
) -> Result<DashboardClient> {
    let token = valid_bearer_token(&profile.name, &profile.base_url).await?;
    let base = Url::parse(&profile.base_url).context("parse base_url")?;
    DashboardClient::new(base, token).map_err(Into::into)
}

/// Dashboard client for export: the OAuth session is selected from the
/// planning-time config generation, not re-derived by profile name. See
/// [`crate::auth::token::PinnedOAuth`] — a same-name replacement that swaps
/// `oauth_ref` must not decide which session authenticates an export that
/// began from the original profile.
pub(crate) async fn dashboard_client_for_export(
    profile: &ResolvedProfile,
    expected: &crate::config::ExpectedExportProfile,
) -> Result<DashboardClient> {
    let storage_key = expected
        .oauth_storage_key
        .clone()
        .ok_or_else(|| anyhow::anyhow!("not logged in — run `am auth login`"))?;
    let pinned = crate::auth::token::PinnedOAuth { storage_key };
    let token = crate::auth::token::valid_bearer_token_pinned(&pinned, &profile.base_url).await?;
    let base = Url::parse(&profile.base_url).context("parse base_url")?;
    DashboardClient::new(base, token).map_err(Into::into)
}

/// Cloud memory surface authenticated with the project `amc_` API key.
pub async fn cloud_api_key_client(
    global: &GlobalOptions,
) -> Result<(ResolvedProfile, MemoryClient)> {
    let profile = resolve_ctx(global).await?;
    let client = cloud_api_key_client_for_profile(&profile)?;
    Ok((profile, client))
}

/// Cloud-key client for an already-resolved profile. See
/// [`dashboard_client_for_profile`] for why this does not resolve again.
pub(crate) fn cloud_api_key_client_for_profile(profile: &ResolvedProfile) -> Result<MemoryClient> {
    let api_key = require_api_key(profile)?;
    if !is_cloud_api_key(&api_key) {
        anyhow::bail!(
            "stored key does not look like a Cloud API key (amc_…) — run `am key create --save` for trace sync and JWT mint"
        );
    }
    let base = Url::parse(&profile.base_url).context("parse cloud base_url")?;
    MemoryClient::new(base, api_key).map_err(Into::into)
}

pub async fn memory_client(global: &GlobalOptions) -> Result<(ResolvedProfile, MemoryClient)> {
    let profile = resolve_ctx(global).await?;
    let client = memory_client_for_profile(&profile).await?;
    Ok((profile, client))
}

/// Build a memory client for an already-resolved profile.
///
/// Takes no `GlobalOptions` on purpose: without it there is nothing to resolve
/// from, so this cannot silently pick up a profile that changed since the
/// caller resolved.
pub(crate) async fn memory_client_for_profile(profile: &ResolvedProfile) -> Result<MemoryClient> {
    match profile.kind {
        ProfileKind::Cloud => {
            let api_key = require_api_key(profile)?;
            let base = Url::parse(&profile.base_url).context("parse base_url")?;
            MemoryClient::new(base, api_key).context("create cloud memory client")
        }
        ProfileKind::Local => {
            let base = Url::parse(&profile.memory_base_url).context("parse local_url")?;
            if let Some(core_key) = resolve_core_api_key() {
                return MemoryClient::new(base, core_key).context("create core memory client");
            }
            // Prefer the managed container's persisted CORE_API_KEY over a Cloud-minted
            // JWT. Core rejects JWT for smoke / some local namespaces; reading the key
            // from state keeps ingest/search working without a shell override.
            if let Some(core_key) =
                crate::instance::read_managed_core_api_key(&profile.name, &profile.memory_base_url)
                    .await
            {
                return MemoryClient::new(base, core_key).context("create core memory client");
            }
            // Pinned: cloud_api_key_client would resolve the active profile
            // again, so a "pinned" caller silently minted a token for whatever
            // profile was active by then.
            let cloud_client = cloud_api_key_client_for_profile(profile)?;
            let token = cloud_client.mint_local_token().await?;
            MemoryClient::new(base, token.access_token).context("create core memory client")
        }
    }
}
