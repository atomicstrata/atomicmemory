//! Shared client builders for command handlers.

use am_cloud_client::{DashboardClient, MemoryClient};
use am_cloud_types::LocalTokenRequest;
use anyhow::{Context, Result, bail};
use url::Url;

use crate::auth::claims::decode_id_token;
use crate::auth::clerk_oauth::resolve_oauth_pair;
use crate::auth::origin::check_token_origin;
use crate::auth::token::valid_bearer_token;
use crate::cli::GlobalOptions;
use crate::config::{
    DEFAULT_PROFILE, ENV_API_KEY, ENV_PROFILE, OAuthTokens, ProfileKind, ResolvedProfile,
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
    let config = load_config().ok();
    let stored_profile_base_url = config
        .as_ref()
        .and_then(|file| file.profiles.get(&profile.name))
        .and_then(|entry| entry.base_url.as_deref());
    if let Some(warning) = local_profile_cloud_export_warning(
        stored_kind,
        global.base_url.as_deref(),
        &profile.base_url,
        std::env::var(ENV_API_KEY).ok().as_deref(),
        &profile.memory_base_url,
        stored_profile_base_url,
    ) {
        message(!global.quiet, &warning);
    }

    if let (Some(config), Ok(creds)) = (config, load_credentials()) {
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

/// Build the Connected Local mint body from the authenticated Cloud session.
///
/// Cloud `POST /v1/local/token` requires a JSON object with `memory_user_id`
/// set to a project member (Clerk user id). Missing/`null` bodies 422; an
/// empty object falls through to `default` and 403s for real projects.
pub(crate) async fn local_token_request_for_profile(
    profile: &ResolvedProfile,
) -> Result<LocalTokenRequest> {
    let memory_user_id = memory_user_id_for_local_token(profile).await?;
    Ok(LocalTokenRequest { memory_user_id })
}

/// Authorize a cached OAuth session for `target_base_url` before reading `sub`.
///
/// `resolve_profile_from` copies oauth unbound; reading `sub` without this check
/// discloses the account id across origins and can mint for a non-member.
fn authorize_cached_oauth_for_target(
    oauth: &OAuthTokens,
    expected_issuer: &str,
    target_base_url: &str,
) -> Result<()> {
    check_token_origin(
        oauth.api_origin.as_deref(),
        oauth.issuer.as_deref(),
        expected_issuer,
        target_base_url,
    )
}

fn sub_from_authorized_oauth(
    oauth: &OAuthTokens,
    expected_issuer: &str,
    target_base_url: &str,
) -> Result<Option<String>> {
    // Origin/issuer binding first — never return `sub` for a mismatched session.
    authorize_cached_oauth_for_target(oauth, expected_issuer, target_base_url)?;
    let Ok(claims) = decode_id_token(&oauth.id_token) else {
        return Ok(None);
    };
    let sub = claims.sub.trim();
    if sub.is_empty() {
        return Ok(None);
    }
    Ok(Some(sub.to_string()))
}

async fn memory_user_id_for_local_token(profile: &ResolvedProfile) -> Result<String> {
    // Prefer the already-resolved session when present (no network; `sub` is
    // a stable identity, not a credential). Authorize it for this profile's
    // Cloud origin first — skipping that check leaked production `sub` values
    // to redirected `--base-url` targets.
    if let Some(oauth) = &profile.oauth {
        let config = load_config()?;
        let (issuer, _) = resolve_oauth_pair(&config, &profile.base_url, None, None)?;
        if let Some(sub) = sub_from_authorized_oauth(oauth, &issuer, &profile.base_url)? {
            return Ok(sub);
        }
    }

    let token = valid_bearer_token(&profile.name, &profile.base_url)
        .await
        .context(
            "Connected Local JWT mint requires a logged-in Cloud session — run `am auth login`",
        )?;
    let claims = decode_id_token(&token).context("decode logged-in id_token for memory_user_id")?;
    let sub = claims.sub.trim();
    if sub.is_empty() {
        bail!(
            "logged-in id_token is missing sub (required as memory_user_id for POST /v1/local/token)"
        );
    }
    Ok(sub.to_string())
}

/// Health-only client: discards the minted JWT identity on purpose.
///
/// `GET v1/memories/health` carries no `user_id`, so Core's user binding never
/// applies. Any caller that issues a user-scoped request (ingest, search,
/// list, get, delete) must go through `memory::memory_client_with_scope` or
/// bind the identity returned by `memory_client_for_profile` itself.
pub async fn memory_client(global: &GlobalOptions) -> Result<(ResolvedProfile, MemoryClient)> {
    let profile = resolve_ctx(global).await?;
    // Health carries no `user_id`, so resolving the session identity on the
    // key path would only add a refresh round trip and a spurious warning.
    let (client, _) = build_memory_client(&profile, IdentityResolution::Skip).await?;
    Ok((profile, client))
}

/// Whether the key path should resolve the Connected Local identity.
#[derive(Clone, Copy, PartialEq, Eq)]
enum IdentityResolution {
    Resolve,
    Skip,
}

/// Connected Local identity to bind into Core request scope.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScopeIdentity {
    /// Clerk `sub`: the default `user_id` for Core requests.
    pub user: String,
    /// True when Core enforces this identity. A Cloud-minted JWT carries
    /// `memory_user_id`, and Core's `enforceMemoryUserBinding` returns 403 for
    /// any other `user_id`, so a conflicting override must fail before the
    /// request. False under a static `CORE_API_KEY`: Core applies no user
    /// binding there, so `user` is only the default and an explicit override
    /// is allowed (it is the only way to reach data written to another
    /// namespace, e.g. `default`, before identity binding existed).
    pub enforced: bool,
}

/// Build a memory client for an already-resolved profile.
///
/// Returns the Connected Local identity when one is available for scope
/// binding: enforced on the minted-JWT path, advisory when a managed or env
/// `CORE_API_KEY` authenticates HTTP. Callers that talk to Core must bind it
/// into request scope. Takes no `GlobalOptions` on purpose: without it there
/// is nothing to resolve from, so this cannot silently pick up a profile that
/// changed since the caller resolved.
pub(crate) async fn memory_client_for_profile(
    profile: &ResolvedProfile,
) -> Result<(MemoryClient, Option<ScopeIdentity>)> {
    build_memory_client(profile, IdentityResolution::Resolve).await
}

async fn build_memory_client(
    profile: &ResolvedProfile,
    identity: IdentityResolution,
) -> Result<(MemoryClient, Option<ScopeIdentity>)> {
    let key_path_identity = || async move {
        match identity {
            IdentityResolution::Resolve => key_path_scope_identity(profile).await,
            IdentityResolution::Skip => None,
        }
    };
    match profile.kind {
        ProfileKind::Cloud => {
            let api_key = require_api_key(profile)?;
            let base = Url::parse(&profile.base_url).context("parse base_url")?;
            Ok((
                MemoryClient::new(base, api_key).context("create cloud memory client")?,
                None,
            ))
        }
        ProfileKind::Local => {
            let base = Url::parse(&profile.memory_base_url).context("parse local_url")?;
            if let Some(core_key) = resolve_core_api_key() {
                return Ok((
                    MemoryClient::new(base, core_key).context("create core memory client")?,
                    key_path_identity().await,
                ));
            }
            // Prefer the managed container's persisted CORE_API_KEY over a Cloud-minted
            // JWT. Core rejects JWT for smoke / some local namespaces; reading the key
            // from state keeps ingest/search working without a shell override.
            if let Some(core_key) = crate::instance::read_managed_core_api_key(profile).await? {
                let managed_base =
                    crate::instance::address::ManagedAddress::parse(&profile.memory_base_url)?
                        .url()
                        .parse()?;
                return Ok((
                    MemoryClient::new(managed_base, core_key)
                        .context("create core memory client")?,
                    key_path_identity().await,
                ));
            }
            // Pinned: cloud_api_key_client would resolve the active profile
            // again, so a "pinned" caller silently minted a token for whatever
            // profile was active by then.
            let cloud_client = cloud_api_key_client_for_profile(profile)?;
            let req = local_token_request_for_profile(profile).await?;
            let identity = ScopeIdentity {
                user: req.memory_user_id.clone(),
                enforced: true,
            };
            let token = cloud_client.mint_local_token(&req).await?;
            Ok((
                MemoryClient::new(base, token.access_token).context("create core memory client")?,
                Some(identity),
            ))
        }
    }
}

/// Default scope identity when a static Core key authenticates HTTP.
///
/// UTM-2's default `instance start --slm` authenticates with the persisted
/// `CORE_API_KEY`, so without this the key path wrote to `user_id=default`
/// while the JWT path wrote to the Clerk `sub`. With a session present, `sub`
/// becomes the default namespace (advisory: Core does not enforce it here).
///
/// No session → `None`. A session that cannot be authorized for this profile
/// (origin/issuer mismatch, pre-binding login, failed refresh) must not break
/// a Core that the key already authenticates: fall back unbound and tell the
/// operator to re-link, instead of failing every memory command.
async fn key_path_scope_identity(profile: &ResolvedProfile) -> Option<ScopeIdentity> {
    profile.oauth.as_ref()?;
    match memory_user_id_for_local_token(profile).await {
        Ok(user) => Some(ScopeIdentity {
            user,
            enforced: false,
        }),
        Err(err) => {
            eprintln!("{}", unauthorized_session_warning(&err));
            None
        }
    }
}

fn unauthorized_session_warning(err: &anyhow::Error) -> String {
    format!(
        "warning: the Connected Local session on this profile could not be authorized ({err:#}); \
         continuing with the Core API key, unbound from your Cloud identity (requests use \
         `default` unless --scope-user or --user-id is given). Run `am auth login` to re-link."
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::environment::Environment;
    use base64::Engine;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;

    fn id_token_with_sub(sub: &str) -> String {
        let payload = URL_SAFE_NO_PAD.encode(format!(r#"{{"sub":"{sub}"}}"#).as_bytes());
        format!("hdr.{payload}.sig")
    }

    fn oauth(sub: &str, api_origin: Option<&str>, issuer: Option<&str>) -> OAuthTokens {
        OAuthTokens {
            id_token: id_token_with_sub(sub),
            refresh_token: None,
            expires_at: None,
            issuer: issuer.map(str::to_string),
            api_origin: api_origin.map(str::to_string),
        }
    }

    /// Every production caller of `memory_client_for_profile` must bind the
    /// minted identity it returns. Discarding it (`(client, _)` / `.0`) is how
    /// smoke and export reintroduced the user_id/memory_user_id 403 after the
    /// memory commands were fixed: Core's binding guard applies to all of them.
    #[test]
    fn minted_identity_is_never_discarded_by_callers() {
        let roots = [
            ("commands/migrate.rs", include_str!("migrate.rs")),
            (
                "verification/smoke.rs",
                include_str!("../verification/smoke.rs"),
            ),
            ("commands/memory/mod.rs", include_str!("memory/mod.rs")),
        ];
        for (name, src) in roots {
            let production = src.split("#[cfg(test)]").next().unwrap();
            let mut calls = 0;
            for (idx, line) in production.lines().enumerate() {
                let t = line.trim_start();
                if t.starts_with("//") || !t.contains("memory_client_for_profile(") {
                    continue;
                }
                calls += 1;
                // The call plus the statement it belongs to (multi-line `?` chains).
                let window: String = production
                    .lines()
                    .skip(idx.saturating_sub(1))
                    .take(16)
                    .collect::<Vec<_>>()
                    .join("\n");
                assert!(
                    !window.contains(", _) = memory_client_for_profile"),
                    "{name}:{}: minted identity discarded with `(client, _)`",
                    idx + 1
                );
                assert!(
                    !window.contains("\n        .0;") && !window.contains(")?.0"),
                    "{name}:{}: minted identity discarded with `.0`",
                    idx + 1
                );
            }
            assert!(
                calls > 0,
                "{name}: expected a memory_client_for_profile call site"
            );
        }
    }

    #[test]
    fn unauthorized_session_warning_names_the_fix() {
        let warning = unauthorized_session_warning(&anyhow::anyhow!("session acquired for X"));
        assert!(warning.starts_with("warning: "), "{warning}");
        assert!(warning.contains("session acquired for X"), "{warning}");
        assert!(warning.contains("`am auth login`"), "{warning}");
    }

    #[test]
    fn cached_oauth_matching_origin_yields_sub() {
        let tokens = oauth(
            "user_member",
            Some(Environment::PROD_BASE_URL),
            Some(Environment::PROD_OAUTH_ISSUER),
        );
        let sub = sub_from_authorized_oauth(
            &tokens,
            Environment::PROD_OAUTH_ISSUER,
            Environment::PROD_BASE_URL,
        )
        .unwrap()
        .expect("sub");
        assert_eq!(sub, "user_member");
    }

    #[test]
    fn cached_oauth_mismatched_origin_refuses_sub() {
        let tokens = oauth(
            "user_member",
            Some(Environment::PROD_BASE_URL),
            Some(Environment::PROD_OAUTH_ISSUER),
        );
        let err = sub_from_authorized_oauth(
            &tokens,
            "https://clerk.custom.example",
            "https://api.custom.example",
        )
        .expect_err("must not disclose sub across origins");
        assert!(
            err.to_string().contains("acquired for") || err.to_string().contains("Refusing"),
            "{err}"
        );
    }

    #[test]
    fn cached_oauth_missing_origin_refuses_sub() {
        let tokens = oauth("user_member", None, Some(Environment::PROD_OAUTH_ISSUER));
        let err = sub_from_authorized_oauth(
            &tokens,
            Environment::PROD_OAUTH_ISSUER,
            Environment::PROD_BASE_URL,
        )
        .expect_err("unbound sessions must fail closed");
        assert!(
            err.to_string().contains("predates Cloud-origin binding"),
            "{err}"
        );
    }
}
