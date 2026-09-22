//! OAuth device flow login for headless CLI environments.

use std::time::{Duration, Instant};

use am_cloud_types::{DeviceAuthorizeResponse, DeviceTokenRequest, DeviceTokenResponse};
use anyhow::{Context, Result, bail};
use reqwest::Url;
use tokio::time::sleep;

use crate::auth::http;
use crate::auth::login_feedback::LoginFeedback;
use crate::auth::setup::setup_default_project;
use crate::config::{OAuthTokens, load_config, store_oauth, store_profile_base_url};
use crate::output::message;
use crate::progress::ProgressReporter;

const POLL_TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Debug, Clone)]
pub struct DeviceLoginOptions {
    pub profile: String,
    pub base_url: String,
    pub client_id: Option<String>,
    pub quiet: bool,
    pub verbose: bool,
}

pub async fn run_device_login(
    opts: DeviceLoginOptions,
    mut progress: Option<&mut dyn ProgressReporter>,
    progress_step: Option<&str>,
) -> Result<()> {
    let feedback = LoginFeedback::detect(opts.verbose, opts.quiet);
    let step_id = progress_step.unwrap_or("identity");
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
            store_oauth(
                &opts.profile,
                OAuthTokens {
                    id_token: token.id_token,
                    refresh_token: token.refresh_token,
                    expires_at: Some(chrono::Utc::now().timestamp() + token.expires_in as i64),
                    issuer: load_config().ok().and_then(|c| c.oauth.issuer),
                    api_origin: None,
                },
                &opts.base_url,
            )?;
            store_profile_base_url(&opts.profile, &opts.base_url)?;
            setup_default_project(&opts.profile, false, Some(&opts.base_url)).await?;
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

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use axum::extract::State;
    use axum::http::{HeaderMap, StatusCode, header};
    use axum::response::{IntoResponse, Response};
    use axum::routing::post;
    use axum::{Json, Router};

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
                client_id: None,
                quiet: true,
                verbose: false,
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
}
