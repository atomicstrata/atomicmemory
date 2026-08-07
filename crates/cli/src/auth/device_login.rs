//! OAuth device flow login for headless CLI environments.

use std::time::{Duration, Instant};

use am_cloud_types::{DeviceAuthorizeResponse, DeviceTokenRequest, DeviceTokenResponse};
use anyhow::{Context, Result, bail};
use reqwest::Url;
use tokio::time::sleep;

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
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()?;

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
    use super::*;

    #[test]
    fn device_login_feedback_is_concise_on_tty() {
        let fb = LoginFeedback::for_test(false, false, true);
        assert!(fb.concise_tty());
    }
}
