//! OAuth device flow login for headless CLI environments.

use std::time::{Duration, Instant};

use am_cloud_types::{DeviceAuthorizeResponse, DeviceTokenRequest, DeviceTokenResponse};
use anyhow::{Context, Result, bail};
use reqwest::Url;
use tokio::time::sleep;

use crate::auth::claims::decode_id_token;
use crate::auth::clerk_oauth::{reject_blank_oauth_overrides, resolve_oauth_pair};
use crate::auth::http;
use crate::auth::login_feedback::LoginFeedback;
use crate::auth::origin::same_origin;
use crate::auth::setup::setup_default_project;
use crate::config::{
    ConfigFile, OAuthTokens, load_config, store_oauth, store_profile_base_url, update_config,
};
use crate::output::message;
use crate::progress::ProgressReporter;

const POLL_TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Debug, Clone)]
pub struct DeviceLoginOptions {
    pub profile: String,
    pub base_url: String,
    pub client_id: Option<String>,
    /// `--issuer` override. Persisted on success, like browser login, so the
    /// stored session stays usable and refreshable on a custom origin.
    pub issuer: Option<String>,
    pub quiet: bool,
    pub verbose: bool,
    /// Skip interactive default-project selection after a successful login.
    pub skip_project_select: bool,
}

pub async fn run_device_login(
    opts: DeviceLoginOptions,
    mut progress: Option<&mut dyn ProgressReporter>,
    progress_step: Option<&str>,
) -> Result<()> {
    let feedback = LoginFeedback::detect(opts.verbose, opts.quiet);
    let step_id = progress_step.unwrap_or("identity");
    // Every later command authorizes and refreshes this session through the
    // OAuth pair resolved for its origin. Resolve it before the flow starts:
    // otherwise login could store a session no subsequent command can use.
    let (expected_issuer, _) = device_oauth_pair(
        load_config()?,
        &opts.base_url,
        opts.issuer.as_deref(),
        opts.client_id.as_deref(),
    )?;
    let base = Url::parse(&opts.base_url).context("parse cloud base_url")?;
    let http = http::client()?;

    let authorize_url = base
        .join("api/oauth/device/authorize")
        .context("device authorize url")?;
    let auth: DeviceAuthorizeResponse = http
        .post(authorize_url)
        .json(&serde_json::json!({
            "client_id": opts.client_id,
        }))
        .send()
        .await
        .context("device authorize request")?
        .error_for_status()
        .context("device authorize failed")?
        .json()
        .await
        .context("decode device authorize response")?;

    if !feedback.concise_tty() {
        message(
            !opts.quiet,
            &format!(
                "Visit {} and enter code: {}",
                auth.verification_uri, auth.user_code
            ),
        );
        message(
            !opts.quiet,
            &format!("Or open: {}", auth.verification_uri_complete),
        );
    } else if !opts.quiet {
        eprintln!(
            "Device login: open {} and enter code {}",
            auth.verification_uri, auth.user_code
        );
    }

    let token_url = base
        .join("api/oauth/device/token")
        .context("device token url")?;
    let interval = Duration::from_secs(auth.interval.max(1));
    let deadline = tokio::time::Instant::now() + POLL_TIMEOUT;
    let started = Instant::now();

    while tokio::time::Instant::now() < deadline {
        sleep(interval).await;
        if let Some(reporter) = progress.as_deref_mut() {
            let elapsed = started.elapsed().as_secs();
            reporter.tick(
                step_id,
                &format!(
                    "waiting for device authorization ({elapsed}s/{})",
                    POLL_TIMEOUT.as_secs()
                ),
            );
        }

        let resp = http
            .post(token_url.clone())
            .json(&DeviceTokenRequest {
                device_code: auth.device_code.clone(),
                client_id: opts.client_id.clone(),
            })
            .send()
            .await
            .context("device token poll")?;

        if resp.status().is_success() {
            let token: DeviceTokenResponse = resp.json().await.context("decode device token")?;
            let tokens = oauth_tokens_from_device_response(token, &expected_issuer)?;
            persist_oauth_overrides(opts.issuer.clone(), opts.client_id.clone())?;
            store_oauth(&opts.profile, tokens, &opts.base_url)?;
            store_profile_base_url(&opts.profile, &opts.base_url)?;
            if !opts.skip_project_select {
                setup_default_project(&opts.profile, false, Some(&opts.base_url)).await?;
            }
            if feedback.show_success() {
                message(!opts.quiet, "Device login complete.");
            }
            return Ok(());
        }

        let body: serde_json::Value = resp.json().await.unwrap_or(serde_json::Value::Null);
        let error = body
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown_error");
        match error {
            "authorization_pending" => continue,
            "slow_down" => {
                sleep(interval).await;
                continue;
            }
            "expired_token" => bail!("device code expired — run login again"),
            other => bail!("device login failed: {other}"),
        }
    }

    bail!("device login timed out waiting for activation")
}

/// Resolve the OAuth pair a device session will be used and refreshed with.
///
/// Later commands resolve the pair from configuration alone, and login
/// persists `--issuer` / `--client-id` into configuration, so apply the
/// overrides to a copy and resolve exactly as a later command would. An
/// override that resolution then ignores must be refused before the flow
/// starts: first-party origins always use the shipped pair,
/// `ATOMICMEMORY_OAUTH_ISSUER` outranks configuration, and the shipped pair is
/// refused on a custom origin. Any of those would yield a session that every
/// later command rejects.
fn device_oauth_pair(
    mut config: ConfigFile,
    base_url: &str,
    issuer: Option<&str>,
    client_id: Option<&str>,
) -> Result<(String, String)> {
    reject_blank_oauth_overrides(issuer, client_id)?;
    if let Some(issuer) = issuer {
        config.oauth.issuer = Some(issuer.to_string());
    }
    if let Some(client_id) = client_id {
        config.oauth.client_id = Some(client_id.to_string());
    }
    let (resolved_issuer, resolved_client_id) = resolve_oauth_pair(&config, base_url, None, None)?;
    if let Some(issuer) = issuer
        && !same_origin(issuer, &resolved_issuer)
    {
        bail!(
            "--issuer {issuer} would not be used after login: commands against {base_url} \
             resolve the issuer {resolved_issuer} (first-party origins use the shipped \
             OAuth pair, and ATOMICMEMORY_OAUTH_ISSUER takes precedence over configuration).\n\
             Drop --issuer, or unset ATOMICMEMORY_OAUTH_ISSUER, so the session stays usable."
        );
    }
    if let Some(client_id) = client_id
        && client_id != resolved_client_id
    {
        bail!(
            "--client-id {client_id} would not be used after login: commands against \
             {base_url} resolve the client id {resolved_client_id}, so the session could not \
             be refreshed.\nDrop --client-id for this origin."
        );
    }
    Ok((resolved_issuer, resolved_client_id))
}

/// Persist explicit `--issuer` / `--client-id` overrides, as browser login does.
///
/// Refresh and authorization resolve the OAuth pair from configuration, so a
/// pair supplied only on the login command line must outlive this process.
fn persist_oauth_overrides(issuer: Option<String>, client_id: Option<String>) -> Result<()> {
    if issuer.is_none() && client_id.is_none() {
        return Ok(());
    }
    update_config(|cfg| {
        if let Some(issuer) = issuer {
            cfg.oauth.issuer = Some(issuer);
        }
        if let Some(client_id) = client_id {
            cfg.oauth.client_id = Some(client_id);
        }
        Ok(())
    })
}

/// Map a successful device-token response into stored OAuth credentials.
///
/// Device login is the durable VPS path: a missing `refresh_token` must fail
/// closed rather than store an id-token-only session that cannot survive
/// process restarts (ATO-2321). A token from a different issuer than the one
/// this origin resolves to is refused for the same reason: origin checks would
/// reject every later use of it.
fn oauth_tokens_from_device_response(
    token: DeviceTokenResponse,
    expected_issuer: &str,
) -> Result<OAuthTokens> {
    let refresh_token = match token.refresh_token {
        Some(value) if !value.is_empty() => value,
        _ => bail!(
            "device token response omitted refresh_token — Cloud must return a refreshable \
             session for `am auth login --device` (see ATO-2321 / am-cloud-api device token).\n\
             Browser login on a local host still stores a refreshable session; paste login \
             (`--token`) remains short-lived."
        ),
    };
    let issuer = match decode_id_token(&token.id_token)
        .ok()
        .and_then(|claims| claims.iss)
    {
        Some(iss) if same_origin(&iss, expected_issuer) => iss,
        Some(iss) => bail!(
            "device login returned a session issued by {iss}, but this Cloud origin expects \
             {expected_issuer}; refusing to store a session no later command could use.\n\
             Pass `--issuer <issuer>` if this origin uses a different identity provider."
        ),
        None => expected_issuer.to_string(),
    };
    Ok(OAuthTokens {
        id_token: token.id_token,
        refresh_token: Some(refresh_token),
        expires_at: Some(chrono::Utc::now().timestamp() + token.expires_in as i64),
        issuer: Some(issuer),
        api_origin: None,
    })
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use am_cloud_types::DeviceTokenResponse;
    use axum::extract::State;
    use axum::http::{HeaderMap, StatusCode, header};
    use axum::response::{IntoResponse, Response};
    use axum::routing::post;
    use axum::{Json, Router};
    use base64::Engine;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;

    use super::*;

    type RecordedUserAgent = (String, Option<String>);

    #[derive(Clone, Default)]
    struct SeenUserAgents(Arc<Mutex<Vec<RecordedUserAgent>>>);

    impl SeenUserAgents {
        fn record(&self, path: &str, headers: &HeaderMap) {
            let user_agent = headers
                .get(header::USER_AGENT)
                .and_then(|value| value.to_str().ok())
                .map(str::to_string);
            self.0.lock().unwrap().push((path.into(), user_agent));
        }
    }

    fn has_cli_user_agent(headers: &HeaderMap) -> bool {
        headers
            .get(header::USER_AGENT)
            .is_some_and(|value| value == crate::auth::http::USER_AGENT)
    }

    async fn authorize(State(seen): State<SeenUserAgents>, headers: HeaderMap) -> Response {
        seen.record("authorize", &headers);
        if !has_cli_user_agent(&headers) {
            return StatusCode::FORBIDDEN.into_response();
        }
        Json(serde_json::json!({
            "device_code": "device-code",
            "user_code": "user-code",
            "verification_uri": "https://example.com/activate",
            "verification_uri_complete": "https://example.com/activate?code=user-code",
            "expires_in": 600,
            "interval": 1
        }))
        .into_response()
    }

    async fn token(State(seen): State<SeenUserAgents>, headers: HeaderMap) -> Response {
        seen.record("token", &headers);
        if !has_cli_user_agent(&headers) {
            return StatusCode::FORBIDDEN.into_response();
        }
        (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "expired_token"})),
        )
            .into_response()
    }

    #[tokio::test]
    async fn device_requests_send_versioned_cli_user_agent() {
        let seen = SeenUserAgents::default();
        let app = Router::new()
            .route("/api/oauth/device/authorize", post(authorize))
            .route("/api/oauth/device/token", post(token))
            .with_state(seen.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let error = run_device_login(
            DeviceLoginOptions {
                profile: "test".into(),
                base_url: format!("http://{address}"),
                client_id: Some("test-client".into()),
                issuer: Some("https://issuer.test".into()),
                quiet: true,
                verbose: false,
                skip_project_select: true,
            },
            None,
            None,
        )
        .await
        .expect_err("expired fixture must stop the polling loop");
        server.abort();

        assert!(error.to_string().contains("device code expired"));
        assert_eq!(
            *seen.0.lock().unwrap(),
            vec![
                (
                    "authorize".into(),
                    Some(crate::auth::http::USER_AGENT.into())
                ),
                ("token".into(), Some(crate::auth::http::USER_AGENT.into())),
            ]
        );
    }

    #[test]
    fn device_login_feedback_is_concise_on_tty() {
        let fb = LoginFeedback::for_test(false, false, true);
        assert!(fb.concise_tty());
    }

    fn synthetic_id_token(iss: &str) -> String {
        let payload = format!(r#"{{"sub":"user_1","iss":"{iss}","exp":9999999999}}"#);
        let encoded = URL_SAFE_NO_PAD.encode(payload.as_bytes());
        format!("hdr.{encoded}.sig")
    }

    #[test]
    fn device_response_persists_refresh_token_and_jwt_issuer() {
        let issuer = "https://clerk.atomicstrata.ai";
        let tokens = oauth_tokens_from_device_response(
            DeviceTokenResponse {
                id_token: synthetic_id_token(issuer),
                refresh_token: Some("refresh-from-cloud".into()),
                token_type: "Bearer".into(),
                expires_in: 3600,
            },
            issuer,
        )
        .unwrap();
        assert_eq!(tokens.refresh_token.as_deref(), Some("refresh-from-cloud"));
        assert_eq!(tokens.issuer.as_deref(), Some(issuer));
        assert!(tokens.expires_at.is_some());
    }

    #[test]
    fn first_party_origin_without_overrides_uses_the_shipped_pair() {
        let (issuer, client_id) = device_oauth_pair(
            ConfigFile::default(),
            "https://api.dev.atomicstrata.ai",
            None,
            None,
        )
        .unwrap();
        assert_eq!(issuer, crate::environment::Environment::PROD_OAUTH_ISSUER);
        assert_eq!(
            client_id,
            crate::environment::Environment::PROD_OAUTH_CLIENT_ID
        );
    }

    #[test]
    fn first_party_origin_refuses_overrides_later_commands_ignore() {
        let err = device_oauth_pair(
            ConfigFile::default(),
            "https://api.atomicstrata.ai",
            Some("https://clerk.custom.example"),
            None,
        )
        .expect_err("first-party origins ignore a configured issuer")
        .to_string();
        assert!(err.contains("would not be used after login"), "{err}");

        let err = device_oauth_pair(
            ConfigFile::default(),
            "https://api.atomicstrata.ai",
            None,
            Some("custom-client"),
        )
        .expect_err("first-party origins ignore a configured client id")
        .to_string();
        assert!(err.contains("would not be used after login"), "{err}");
    }

    #[test]
    fn custom_origin_uses_overrides_it_will_keep_resolving() {
        let (issuer, client_id) = device_oauth_pair(
            ConfigFile::default(),
            "https://api.custom.example",
            Some("https://clerk.custom.example"),
            Some("custom-client"),
        )
        .unwrap();
        assert_eq!(issuer, "https://clerk.custom.example");
        assert_eq!(client_id, "custom-client");
    }

    #[test]
    fn custom_origin_refuses_the_shipped_pair_as_overrides() {
        use crate::environment::Environment;
        assert!(
            device_oauth_pair(
                ConfigFile::default(),
                "https://api.custom.example",
                Some(Environment::PROD_OAUTH_ISSUER),
                Some(Environment::PROD_OAUTH_CLIENT_ID),
            )
            .is_err(),
            "the shipped pair is filtered on custom origins, so it cannot be persisted for one"
        );
    }

    #[test]
    fn device_response_from_another_issuer_is_refused() {
        let err = oauth_tokens_from_device_response(
            DeviceTokenResponse {
                id_token: synthetic_id_token("https://clerk.other.example"),
                refresh_token: Some("refresh".into()),
                token_type: "Bearer".into(),
                expires_in: 3600,
            },
            "https://clerk.atomicstrata.ai",
        )
        .expect_err("a session no later command could authorize must not be stored")
        .to_string();
        assert!(err.contains("refusing to store"), "{err}");
        assert!(err.contains("--issuer"), "{err}");
    }

    #[test]
    fn device_response_without_iss_records_the_resolved_issuer() {
        let tokens = oauth_tokens_from_device_response(
            DeviceTokenResponse {
                id_token: "hdr.e30.sig".into(),
                refresh_token: Some("refresh".into()),
                token_type: "Bearer".into(),
                expires_in: 3600,
            },
            "https://clerk.atomicstrata.ai",
        )
        .unwrap();
        assert_eq!(
            tokens.issuer.as_deref(),
            Some("https://clerk.atomicstrata.ai")
        );
    }

    #[test]
    fn device_response_without_refresh_token_fails_closed() {
        let err = oauth_tokens_from_device_response(
            DeviceTokenResponse {
                id_token: synthetic_id_token("https://clerk.example"),
                refresh_token: None,
                token_type: "Bearer".into(),
                expires_in: 3600,
            },
            "https://clerk.example",
        )
        .expect_err("id-token-only device response must not be stored")
        .to_string();
        assert!(
            err.contains("omitted refresh_token"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn empty_refresh_token_is_treated_as_missing() {
        let err = oauth_tokens_from_device_response(
            DeviceTokenResponse {
                id_token: synthetic_id_token("https://clerk.example"),
                refresh_token: Some(String::new()),
                token_type: "Bearer".into(),
                expires_in: 3600,
            },
            "https://clerk.example",
        )
        .unwrap_err()
        .to_string();
        assert!(err.contains("omitted refresh_token"));
    }

    #[tokio::test]
    async fn successful_device_poll_refuses_id_token_only_cloud_response() {
        #[derive(Clone, Default)]
        struct Fixture;

        async fn authorize_ok() -> Response {
            Json(serde_json::json!({
                "device_code": "device-code",
                "user_code": "user-code",
                "verification_uri": "https://example.com/activate",
                "verification_uri_complete": "https://example.com/activate?code=user-code",
                "expires_in": 600,
                "interval": 1
            }))
            .into_response()
        }

        async fn token_id_only() -> Response {
            Json(serde_json::json!({
                "id_token": "hdr.e30.sig",
                "token_type": "Bearer",
                "expires_in": 3600
            }))
            .into_response()
        }

        let app = Router::new()
            .route("/api/oauth/device/authorize", post(authorize_ok))
            .route("/api/oauth/device/token", post(token_id_only))
            .with_state(Fixture);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let err = run_device_login(
            DeviceLoginOptions {
                profile: "test-no-refresh".into(),
                base_url: format!("http://{address}"),
                client_id: Some("test-client".into()),
                issuer: Some("https://issuer.test".into()),
                quiet: true,
                verbose: false,
                skip_project_select: true,
            },
            None,
            None,
        )
        .await
        .expect_err("must fail closed when Cloud omits refresh_token");
        server.abort();
        assert!(
            err.to_string().contains("omitted refresh_token"),
            "unexpected error: {err}"
        );
    }
}
