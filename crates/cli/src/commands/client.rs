//! Shared client builders for command handlers.

use am_cloud_client::{DashboardClient, MemoryClient};
use anyhow::{Context, Result};
use url::Url;

use crate::auth::token::valid_bearer_token;
use crate::cli::GlobalOptions;
use crate::config::{
    ProfileKind, ResolvedProfile, is_cloud_api_key, require_api_key, resolve_core_api_key,
    resolve_profile,
};

pub async fn resolve_ctx(global: &GlobalOptions) -> Result<ResolvedProfile> {
    resolve_profile(
        global.profile.as_deref(),
        global.base_url.as_deref(),
        global.environment,
    )
}

pub async fn dashboard_client(
    global: &GlobalOptions,
) -> Result<(ResolvedProfile, DashboardClient)> {
    let profile = resolve_ctx(global).await?;
    let token = valid_bearer_token(&profile.name, &profile.base_url).await?;
    let base = Url::parse(&profile.base_url).context("parse base_url")?;
    let client = DashboardClient::new(base, token)?;
    Ok((profile, client))
}

/// Cloud memory surface authenticated with the project `amc_` API key.
pub async fn cloud_api_key_client(
    global: &GlobalOptions,
) -> Result<(ResolvedProfile, MemoryClient)> {
    let profile = resolve_ctx(global).await?;
    let api_key = require_api_key(&profile)?;
    if !is_cloud_api_key(&api_key) {
        anyhow::bail!(
            "stored key does not look like a Cloud API key (amc_…) — run `am key create --save` for trace sync and JWT mint"
        );
    }
    let base = Url::parse(&profile.base_url).context("parse cloud base_url")?;
    let client = MemoryClient::new(base, api_key)?;
    Ok((profile, client))
}

pub async fn memory_client(global: &GlobalOptions) -> Result<(ResolvedProfile, MemoryClient)> {
    let profile = resolve_ctx(global).await?;
    let client = memory_client_for_profile(&profile, global).await?;
    Ok((profile, client))
}

async fn memory_client_for_profile(
    profile: &ResolvedProfile,
    global: &GlobalOptions,
) -> Result<MemoryClient> {
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
            let (_profile, cloud_client) = cloud_api_key_client(global).await?;
            let token = cloud_client.mint_local_token().await?;
            MemoryClient::new(base, token.access_token).context("create core memory client")
        }
    }
}
