//! OAuth token refresh and bearer resolution.

use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use chrono::Utc;
use reqwest::Client;
use reqwest::Url;
use serde::Deserialize;

use crate::auth::claims::decode_id_token;
use crate::auth::clerk_oauth::resolve_oauth_pair;
use crate::auth::origin::check_token_origin;
use crate::config::{
    ConfigFile, CredentialsFile, OAuthTokens, load_config, load_credentials, update_credentials,
};

const OAUTH_HTTP_TIMEOUT: Duration = Duration::from_secs(30);

fn oauth_http_client() -> Result<Client> {
    Client::builder()
        .timeout(OAUTH_HTTP_TIMEOUT)
        .build()
        .context("build oauth http client")
}

#[derive(Debug, Deserialize)]
pub struct OAuthMetadata {
    pub authorization_endpoint: String,
    pub token_endpoint: String,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    id_token: Option<String>,
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_in: Option<i64>,
}

pub async fn discover_metadata(issuer: &str) -> Result<OAuthMetadata> {
    let base = issuer.trim_end_matches('/');
    let url = format!("{base}/.well-known/oauth-authorization-server");
    let client = oauth_http_client()?;
    let meta: OAuthMetadata = client
        .get(&url)
        .send()
        .await
        .context("fetch oauth metadata")?
        .error_for_status()
        .context("oauth metadata status")?
        .json()
        .await
        .context("parse oauth metadata")?;
    Ok(meta)
}

pub async fn exchange_code(
    token_endpoint: &str,
    client_id: &str,
    code: &str,
    redirect_uri: &str,
    verifier: &str,
) -> Result<OAuthTokens> {
    let client = oauth_http_client()?;
    let resp: TokenResponse = client
        .post(token_endpoint)
        .form(&[
            ("grant_type", "authorization_code"),
            ("client_id", client_id),
            ("code", code),
            ("redirect_uri", redirect_uri),
            ("code_verifier", verifier),
        ])
        .send()
        .await
        .context("token exchange")?
        .error_for_status()
        .context("token exchange status")?
        .json()
        .await
        .context("parse token response")?;
    tokens_from_response(resp, None)
}

pub async fn refresh_tokens(
    token_endpoint: &str,
    client_id: &str,
    refresh_token: &str,
) -> Result<OAuthTokens> {
    let client = oauth_http_client()?;
    let resp: TokenResponse = client
        .post(token_endpoint)
        .form(&[
            ("grant_type", "refresh_token"),
            ("client_id", client_id),
            ("refresh_token", refresh_token),
        ])
        .send()
        .await
        .context("token refresh")?
        .error_for_status()
        .context("token refresh status")?
        .json()
        .await
        .context("parse refresh response")?;
    tokens_from_response(resp, Some(refresh_token))
}

fn tokens_from_response(resp: TokenResponse, prior_refresh: Option<&str>) -> Result<OAuthTokens> {
    let id_token = resp
        .id_token
        .or(resp.access_token)
        .ok_or_else(|| anyhow!("token response missing id_token/access_token"))?;
    let expires_at = resp.expires_in.map(|secs| Utc::now().timestamp() + secs);
    Ok(OAuthTokens {
        id_token,
        refresh_token: resp
            .refresh_token
            .or_else(|| prior_refresh.map(str::to_string)),
        expires_at,
        issuer: None,
        api_origin: None,
    })
}

fn clear_stored_refresh_token(storage_key: &str) -> Result<()> {
    update_credentials(|creds| {
        if let Some(tokens) = creds.oauth.get_mut(storage_key) {
            tokens.refresh_token = None;
        }
        Ok(())
    })
}

/// A stored session that has been authorized for a specific destination.
#[derive(Debug)]
struct AuthorizedSession {
    storage_key: String,
    tokens: OAuthTokens,
    issuer: String,
    client_id: String,
}

/// Select the stored session for `profile_name` and authorize it for
/// `target_base_url`.
///
/// Pure over the loaded config/credentials so the origin check is testable
/// without touching the real config directory: the guard being *wired in* here
/// is the part that regressed, not the check itself.
fn authorize_stored_session(
    config: &ConfigFile,
    creds: &CredentialsFile,
    profile_name: &str,
    target_base_url: &str,
) -> Result<AuthorizedSession> {
    let oauth_ref = config
        .profiles
        .get(profile_name)
        .and_then(|p| p.oauth_ref.clone())
        .unwrap_or_else(|| profile_name.to_string());
    let allow_local_fallback = config
        .profiles
        .get(profile_name)
        .is_some_and(|p| p.kind == crate::config::ProfileKind::Local);
    // Same selection policy planning uses; here it runs against the freshly
    // loaded credentials, preserving the historical by-name behavior.
    let storage_key =
        crate::config::select_oauth_session_key(creds, &oauth_ref, allow_local_fallback)
            .ok_or_else(|| anyhow!("not logged in — run `am auth login`"))?;
    authorize_stored_session_pinned(config, creds, &PinnedOAuth { storage_key }, target_base_url)
}

fn authorize_stored_session_pinned(
    config: &ConfigFile,
    creds: &CredentialsFile,
    pinned: &PinnedOAuth,
    target_base_url: &str,
) -> Result<AuthorizedSession> {
    // No selection here, by design: exactly the planned key or failure.
    let (storage_key, tokens) = match creds.oauth.get(&pinned.storage_key).cloned() {
        Some(t) => (pinned.storage_key.clone(), t),
        None => bail!(
            "the OAuth session selected for this operation no longer exists — run `am auth login` and retry"
        ),
    };

    // Enforce the origin binding BEFORE the token can be handed out. The
    // fresh-token shortcut in the caller used to return first, which is how a
    // production session reached an arbitrary `--base-url`.
    let (issuer, client_id) = resolve_oauth_pair(config, target_base_url, None, None)?;
    check_token_origin(
        tokens.api_origin.as_deref(),
        tokens.issuer.as_deref(),
        &issuer,
        target_base_url,
    )?;

    Ok(AuthorizedSession {
        storage_key,
        tokens,
        issuer,
        client_id,
    })
}

/// Return a usable bearer token for `profile_name`, valid for `target_base_url`.
///
/// The destination is a required parameter rather than something derived from
/// the profile: `--base-url` / `ATOMICMEMORY_API_URL` can redirect a request to
/// any origin, so the credential must be checked against where it is actually
/// going. Taking it by argument makes that check impossible to forget at a call
/// site — see [`crate::auth::origin`] for the invariant.
pub async fn valid_bearer_token(profile_name: &str, target_base_url: &str) -> Result<String> {
    let config = load_config()?;
    let creds = load_credentials()?;
    let session = authorize_stored_session(&config, &creds, profile_name, target_base_url)?;
    complete_bearer_token(session, target_base_url).await
}

/// The concrete OAuth session selected at planning time, for callers that
/// must not let any concurrent mutation redirect which stored session
/// authenticates them. `valid_bearer_token` re-derives the selection from
/// fresh config and credentials reads by profile NAME — a replacement can
/// swap `oauth_ref`, and the Local fallback picks the credential map's first
/// session, so a concurrent login could redirect it too. Pinning the storage
/// key means execution makes NO selection decision at all; it looks up
/// exactly this key or fails. The origin binding still re-validates whatever
/// is found under it.
#[derive(Debug, Clone)]
pub struct PinnedOAuth {
    /// Storage key in `credentials.toml`'s oauth map, selected at planning
    /// time by [`crate::config::select_oauth_session_key`].
    pub storage_key: String,
}

pub async fn valid_bearer_token_pinned(
    pinned: &PinnedOAuth,
    target_base_url: &str,
) -> Result<String> {
    let config = load_config()?;
    let creds = load_credentials()?;
    let session = authorize_stored_session_pinned(&config, &creds, pinned, target_base_url)?;
    complete_bearer_token(session, target_base_url).await
}

async fn complete_bearer_token(
    session: AuthorizedSession,
    target_base_url: &str,
) -> Result<String> {
    let AuthorizedSession {
        storage_key,
        tokens,
        issuer,
        client_id,
    } = session;

    if token_fresh(&tokens) {
        return Ok(tokens.id_token);
    }

    let refresh = tokens
        .refresh_token
        .clone()
        .ok_or_else(|| anyhow!("session expired — run `am auth login`"))?;
    let meta = discover_metadata(&issuer).await?;
    let refreshed = match refresh_tokens(&meta.token_endpoint, &client_id, &refresh).await {
        Ok(tokens) => tokens,
        Err(err) if is_refresh_rejection(&err) => {
            let _ = clear_stored_refresh_token(&storage_key);
            return Err(err.context(
                "OAuth refresh was rejected — stored refresh token was cleared; run `am auth login`",
            ));
        }
        Err(err) => {
            // Transport failure (timeout, DNS, 5xx): the stored refresh token
            // is probably still valid, so keep it rather than forcing a
            // re-login over a transient network blip.
            return Err(err.context(
                "OAuth refresh failed — stored refresh token was kept; retry when connectivity is restored",
            ));
        }
    };
    let mut updated = refreshed;
    updated.issuer = Some(issuer);
    // A refresh does not change which Cloud origin the session belongs to.
    updated.api_origin = Some(target_base_url.to_string());
    // Re-read under the lock: another `am` process may have stored credentials
    // for a different profile while this refresh was in flight.
    update_credentials(|creds| {
        creds.oauth.insert(storage_key, updated.clone());
        Ok(())
    })?;
    Ok(updated.id_token)
}

/// True for the HTTP statuses that mean the refresh token itself was refused.
///
/// RFC 6749 returns `invalid_grant` as 400; providers also use 401/403. Any
/// other status (or no status at all) is a transport or server-side problem,
/// where discarding the user's credential would force a needless re-login.
fn status_is_refresh_rejection(status: reqwest::StatusCode) -> bool {
    matches!(
        status,
        reqwest::StatusCode::BAD_REQUEST
            | reqwest::StatusCode::UNAUTHORIZED
            | reqwest::StatusCode::FORBIDDEN
    )
}

fn is_refresh_rejection(err: &anyhow::Error) -> bool {
    err.chain().any(|cause| {
        cause
            .downcast_ref::<reqwest::Error>()
            .and_then(reqwest::Error::status)
            .is_some_and(status_is_refresh_rejection)
    })
}

fn token_fresh(tokens: &OAuthTokens) -> bool {
    match tokens.expires_at {
        Some(exp) => Utc::now().timestamp() + 60 < exp,
        None => decode_id_token(&tokens.id_token)
            .ok()
            .and_then(|c| c.exp)
            .map(|exp| Utc::now().timestamp() + 60 < exp)
            .unwrap_or(true),
    }
}

pub fn oauth_scopes(include_org: bool) -> &'static str {
    if include_org {
        "openid profile email offline_access user:org:read"
    } else {
        "openid profile email offline_access"
    }
}

pub fn build_authorize_url(
    authorization_endpoint: &str,
    client_id: &str,
    redirect_uri: &str,
    state: &str,
    challenge: &str,
    include_org_scope: bool,
) -> Result<Url> {
    let mut url = Url::parse(authorization_endpoint).context("authorization endpoint url")?;
    {
        let mut q = url.query_pairs_mut();
        q.append_pair("response_type", "code");
        q.append_pair("client_id", client_id);
        q.append_pair("redirect_uri", redirect_uri);
        q.append_pair("scope", oauth_scopes(include_org_scope));
        q.append_pair("state", state);
        q.append_pair("code_challenge", challenge);
        q.append_pair("code_challenge_method", "S256");
        q.append_pair("prompt", "consent");
    }
    Ok(url)
}

#[allow(dead_code)]
pub fn merge_credentials_oauth(creds: &mut CredentialsFile, name: &str, tokens: OAuthTokens) {
    creds.oauth.insert(name.to_string(), tokens);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::environment::Environment;

    #[test]
    fn pinned_oauth_is_lookup_only_and_immune_to_concurrent_logins() {
        // The scenario from review: export plans against a Local profile whose
        // oauth_ref is absent, so planning's fallback selects the only session
        // ("zzz-session"). A concurrent login then adds a lexicographically
        // earlier session. Re-running selection at execution would now pick
        // the newcomer; the pinned path must not select at all.
        use crate::config::{ConfigFile, CredentialsFile, OAuthTokens, ProfileConfig, ProfileKind};
        let target = crate::environment::Environment::PROD_BASE_URL;
        let issuer = crate::environment::Environment::PROD_OAUTH_ISSUER;
        let session = |marker: &str| OAuthTokens {
            id_token: marker.to_string(),
            refresh_token: None,
            expires_at: None,
            issuer: Some(issuer.to_string()),
            api_origin: Some(target.to_string()),
        };

        // Planning time: one session only.
        let mut planning_creds = CredentialsFile::default();
        planning_creds
            .oauth
            .insert("zzz-session".into(), session("token-planned"));
        let planned = crate::config::select_oauth_session_key(&planning_creds, "absent-ref", true)
            .expect("fallback selects the only session");
        assert_eq!(planned, "zzz-session");

        // Execution time: a concurrent login added an earlier-sorting session.
        let mut config = ConfigFile::default();
        config.profiles.insert(
            "local".into(),
            ProfileConfig {
                kind: ProfileKind::Local,
                ..Default::default()
            },
        );
        let mut exec_creds = planning_creds.clone();
        exec_creds
            .oauth
            .insert("aaa-session".into(), session("token-interloper"));

        // The by-name path re-selects and follows the interloper…
        let by_name = authorize_stored_session(&config, &exec_creds, "local", target).unwrap();
        assert_eq!(by_name.storage_key, "aaa-session");
        // …the pinned path keeps the planned session.
        let pinned = PinnedOAuth {
            storage_key: planned,
        };
        let kept = authorize_stored_session_pinned(&config, &exec_creds, &pinned, target).unwrap();
        assert_eq!(kept.storage_key, "zzz-session");
        assert_eq!(kept.tokens.id_token, "token-planned");
    }

    #[test]
    fn pinned_oauth_fails_rather_than_reselecting_when_the_session_is_gone() {
        use crate::config::{ConfigFile, CredentialsFile, OAuthTokens, ProfileConfig, ProfileKind};
        let target = crate::environment::Environment::PROD_BASE_URL;
        let mut creds = CredentialsFile::default();
        creds.oauth.insert(
            "other-session".into(),
            OAuthTokens {
                id_token: "token-other".into(),
                refresh_token: None,
                expires_at: None,
                issuer: Some(crate::environment::Environment::PROD_OAUTH_ISSUER.into()),
                api_origin: Some(target.into()),
            },
        );
        let mut config = ConfigFile::default();
        config.profiles.insert(
            "local".into(),
            ProfileConfig {
                kind: ProfileKind::Local,
                ..Default::default()
            },
        );
        // The planned session was deleted; another exists. Falling back here
        // is exactly the redirection being prevented, so it must error.
        let pinned = PinnedOAuth {
            storage_key: "deleted-session".into(),
        };
        let err = authorize_stored_session_pinned(&config, &creds, &pinned, target).unwrap_err();
        assert!(err.to_string().contains("no longer exists"));
    }

    #[test]
    fn authorize_url_always_requests_consent_not_login() {
        let url = build_authorize_url(
            "https://clerk.atomicstrata.ai/oauth/authorize",
            Environment::PROD_OAUTH_CLIENT_ID,
            "http://127.0.0.1:9876/callback",
            "state123",
            "challenge123",
            false,
        )
        .unwrap();
        let pairs: Vec<(String, String)> = url
            .query_pairs()
            .map(|(k, v)| (k.into(), v.into()))
            .collect();
        assert!(
            pairs
                .iter()
                .any(|(k, v)| k == "scope" && !v.contains("user:org:read")),
            "expected default scopes without org when include_org_scope=false, got {pairs:?}"
        );
        assert!(
            pairs.iter().any(|(k, v)| k == "prompt" && v == "consent"),
            "expected prompt=consent, got {pairs:?}"
        );
        assert!(
            !pairs
                .iter()
                .any(|(k, v)| k == "prompt" && v.contains("login")),
            "prompt=login breaks Clerk loopback into Account Portal home"
        );
        assert!(
            pairs
                .iter()
                .any(|(k, v)| k == "redirect_uri" && v.contains("127.0.0.1"))
        );
    }

    #[test]
    fn authorize_url_with_org_scope_includes_user_org_read() {
        let url = build_authorize_url(
            "https://issuer.example/oauth/authorize",
            "cid",
            "http://127.0.0.1:9876/callback",
            "s",
            "c",
            true,
        )
        .unwrap();
        assert!(
            url.as_str().contains("user%3Aorg%3Aread") || url.as_str().contains("user:org:read")
        );
        let prompt = url
            .query_pairs()
            .find(|(k, _)| k == "prompt")
            .map(|(_, v)| v.to_string())
            .unwrap();
        assert_eq!(prompt, "consent");
    }

    #[test]
    fn default_oauth_scopes_include_org_read() {
        assert!(oauth_scopes(true).contains("user:org:read"));
    }

    fn session_config(profile: &str) -> (ConfigFile, CredentialsFile) {
        let mut config = ConfigFile::default();
        // Configure OAuth for the custom origin so `resolve_oauth_pair`
        // SUCCEEDS there. Without this the refusal tests would pass on
        // resolve_oauth_pair's own bail and would not exercise the origin
        // check at all — a green test over a state the guard never sees.
        config.oauth = crate::config::OAuthDefaults {
            issuer: Some("https://clerk.custom.example".into()),
            client_id: Some("custom-client".into()),
        };
        config
            .profiles
            .insert(profile.to_string(), crate::config::ProfileConfig::default());
        let mut creds = CredentialsFile::default();
        creds.oauth.insert(
            profile.to_string(),
            OAuthTokens {
                id_token: "header.payload.sig".into(),
                refresh_token: None,
                // Issued by production Clerk.
                expires_at: Some(Utc::now().timestamp() + 3600),
                issuer: Some(Environment::PROD_OAUTH_ISSUER.into()),
                api_origin: Some(Environment::PROD_BASE_URL.into()),
            },
        );
        (config, creds)
    }

    #[test]
    fn stored_session_is_authorized_for_its_own_origin() {
        let (config, creds) = session_config("cloud");
        let session =
            authorize_stored_session(&config, &creds, "cloud", Environment::PROD_BASE_URL).unwrap();
        assert_eq!(session.issuer, Environment::PROD_OAUTH_ISSUER);
        assert_eq!(session.tokens.id_token, "header.payload.sig");
    }

    #[test]
    fn stored_session_is_refused_for_a_shared_issuer_on_another_origin() {
        // Both origins use the SAME configured issuer, so only the recorded
        // API origin can distinguish them — issuer comparison alone passed
        // this case.
        let (mut config, mut creds) = session_config("cloud");
        config.oauth.issuer = Some("https://clerk.custom.example".into());
        creds.oauth.get_mut("cloud").unwrap().issuer = Some("https://clerk.custom.example".into());
        creds.oauth.get_mut("cloud").unwrap().api_origin = Some("https://api.a.example".into());

        let err = authorize_stored_session(&config, &creds, "cloud", "https://api.b.example")
            .expect_err("shared issuer must not authorize another API origin")
            .to_string();
        assert!(err.contains("acquired for"), "unexpected error: {err}");
    }

    #[test]
    fn stored_session_is_refused_for_a_redirected_base_url() {
        // The reported leak: `am --base-url http://127.0.0.1:… project list`
        // handing a production session to a local cleartext listener. This
        // asserts the guard is WIRED IN, not merely that it exists.
        let (config, creds) = session_config("cloud");
        let err = authorize_stored_session(&config, &creds, "cloud", "http://127.0.0.1:38767")
            .expect_err("must not authorize a production session for a custom origin")
            .to_string();
        assert!(
            err.contains("custom Cloud API URL") || err.contains("Refusing to send"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn fresh_token_shortcut_cannot_bypass_the_origin_check() {
        // The token below is deliberately unexpired, so the caller's
        // `token_fresh` fast path would return it immediately if selection did
        // not authorize first.
        let (config, creds) = session_config("cloud");
        assert!(token_fresh(creds.oauth.get("cloud").unwrap()));
        assert!(
            authorize_stored_session(&config, &creds, "cloud", "https://api.staging.example.com")
                .is_err()
        );
    }

    #[test]
    fn only_auth_rejections_discard_the_refresh_token() {
        for status in [
            reqwest::StatusCode::BAD_REQUEST,
            reqwest::StatusCode::UNAUTHORIZED,
            reqwest::StatusCode::FORBIDDEN,
        ] {
            assert!(
                status_is_refresh_rejection(status),
                "{status} should clear the stored refresh token"
            );
        }
        for status in [
            reqwest::StatusCode::INTERNAL_SERVER_ERROR,
            reqwest::StatusCode::BAD_GATEWAY,
            reqwest::StatusCode::SERVICE_UNAVAILABLE,
            reqwest::StatusCode::GATEWAY_TIMEOUT,
            reqwest::StatusCode::TOO_MANY_REQUESTS,
        ] {
            assert!(
                !status_is_refresh_rejection(status),
                "{status} is transient and must keep the stored refresh token"
            );
        }
    }

    #[test]
    fn transport_failures_keep_the_refresh_token() {
        // A timeout carries no HTTP status, so it must not be treated as a
        // rejection — that would force a re-login after a network blip.
        let err = anyhow!("token refresh").context("operation timed out");
        assert!(!is_refresh_rejection(&err));
    }
}
