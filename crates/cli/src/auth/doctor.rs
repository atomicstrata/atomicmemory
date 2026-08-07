//! Preflight checks for public browser login (no secrets required).

use std::time::Duration;

use anyhow::{Context, Result, bail};
use reqwest::Client;
use serde::Serialize;

use crate::auth::clerk_oauth::{resolve_oauth_pair, resolve_public_client_id};
use crate::auth::token::discover_metadata;
use crate::config::{
    DEFAULT_OAUTH_CALLBACK_PORT, ensure_config_initialized, load_config, resolve_profile,
};
use crate::environment::is_production_api_url;

const OAUTH_HTTP_TIMEOUT: Duration = Duration::from_secs(30);
const API_HEALTH_TIMEOUT: Duration = Duration::from_secs(10);

fn oauth_http_client() -> Result<Client> {
    Client::builder()
        .timeout(OAUTH_HTTP_TIMEOUT)
        .build()
        .context("build oauth http client")
}

/// Optional overrides for dev / custom Clerk instances (e.g. `auth login --issuer --client-id`).
#[derive(Debug, Clone, Default)]
pub struct DoctorOverrides {
    pub client_id: Option<String>,
    pub issuer: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DoctorReport {
    pub issuer: String,
    pub client_id: String,
    pub redirect_uri: String,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    pub oauth_metadata_ok: bool,
    pub clerk_client_registered: bool,
    pub api_health_ok: Option<bool>,
    pub api_base_url: String,
    pub hints: Vec<String>,
}

/// Run OAuth preflight and return a structured report (exits non-zero if login would fail).
pub async fn run_doctor(
    api_base_url: Option<String>,
    overrides: DoctorOverrides,
) -> Result<DoctorReport> {
    let _ = ensure_config_initialized();
    let config = load_config()?;
    let profile = resolve_profile(None, api_base_url.as_deref(), None)?;
    let client_id = match overrides.client_id.clone() {
        Some(id) => id,
        None => resolve_public_client_id(&config, None, &profile.base_url)?,
    };
    let (issuer, _) = resolve_oauth_pair(
        &config,
        &profile.base_url,
        overrides.client_id.clone(),
        overrides.issuer.clone(),
    )?;
    let port = DEFAULT_OAUTH_CALLBACK_PORT;
    let redirect_uri = format!("http://127.0.0.1:{port}/callback");
    let api_base = profile.base_url;

    let mut hints = Vec::new();
    if let Ok(env_id) = std::env::var("ATOMICMEMORY_OAUTH_CLIENT_ID")
        && !env_id.is_empty()
        && env_id != client_id
        && is_production_api_url(&api_base)
    {
        hints.push(format!(
            "ATOMICMEMORY_OAUTH_CLIENT_ID={env_id} is set but ignored on production — login uses shipped client {client_id}. Run: unset ATOMICMEMORY_OAUTH_CLIENT_ID"
        ));
    }
    if !is_production_api_url(&api_base) {
        hints.push(
            "Using a custom Cloud API URL — OAuth issuer and client_id must be configured explicitly."
                .into(),
        );
    }

    // The doctor is the diagnostic for exactly these failures, so a failed
    // check must land in the report (oauth_metadata_ok=false plus a hint)
    // rather than error out of the doctor before it can say anything. Before
    // this, oauth_metadata_ok was hardcoded true after a `?`, a check that
    // could never be observed failing.
    let meta = match discover_metadata(&issuer).await {
        Ok(meta) => Some(meta),
        Err(err) => {
            hints.push(format!(
                "OAuth metadata discovery failed for {issuer}: {err:#}. \
                 Login cannot proceed until the issuer is reachable."
            ));
            None
        }
    };
    let oauth_metadata_ok = meta.is_some();

    // `Some(false)` means Clerk answered and rejected the client; `None` means
    // we never got an answer (discovery or the probe itself failed). Only the
    // former justifies an `invalid_client` diagnosis — otherwise the report
    // contradicts itself, pairing "connection refused" with "Clerk rejected
    // this client_id".
    let clerk_probe: Option<bool> = match &meta {
        Some(meta) => {
            match probe_clerk_public_client(&meta.token_endpoint, &client_id, &redirect_uri).await {
                Ok(None) => {
                    hints.push(format!(
                        "Clerk returned an unrecognized response from {} — client registration \
                         could not be confirmed either way.",
                        meta.token_endpoint
                    ));
                    None
                }
                Ok(registered) => registered,
                Err(err) => {
                    hints.push(format!(
                        "Could not reach the Clerk token endpoint at {}: {err:#}",
                        meta.token_endpoint
                    ));
                    None
                }
            }
        }
        None => None,
    };
    let clerk_client_registered = clerk_probe.unwrap_or(false);

    if clerk_probe == Some(false) {
        if is_production_api_url(&api_base) {
            hints.push(
                "Clerk rejected this client_id at the token endpoint (invalid_client). \
                 Run `am auth doctor` and confirm the shipped OAuth client is registered for production."
                    .into(),
            );
        } else {
            hints.push(format!(
                "Clerk rejected client_id {client_id} at {issuer} (invalid_client). \
                 Confirm the OAuth app is public, redirect URI {redirect_uri} is allowlisted, \
                 and the API JWT audience includes {client_id}."
            ));
        }
        hints.push("Until fixed, use `am auth login --token <dashboard-jwt>`.".into());
    }

    let api_health_ok = match probe_api_health(&api_base).await {
        Ok(ok) => Some(ok),
        Err(e) => {
            hints.push(format!("API health check failed for {api_base}: {e:#}"));
            Some(false)
        }
    };

    let (authorization_endpoint, token_endpoint) = match meta {
        Some(meta) => (meta.authorization_endpoint, meta.token_endpoint),
        None => (String::new(), String::new()),
    };

    Ok(DoctorReport {
        issuer,
        client_id,
        redirect_uri,
        authorization_endpoint,
        token_endpoint,
        oauth_metadata_ok,
        clerk_client_registered,
        api_health_ok,
        api_base_url: api_base,
        hints,
    })
}

pub fn report_ok(report: &DoctorReport) -> bool {
    report.oauth_metadata_ok && report.clerk_client_registered
}

/// Probe the token endpoint with a dummy code.
///
/// `Some(true)` — the provider answered `invalid_grant`: the public client
/// exists and accepts PKCE. `Some(false)` — it answered `invalid_client`, a
/// definite rejection. `None` — any other response, which says nothing about
/// registration. Collapsing that third case into `false` produced reports that
/// diagnosed `invalid_client` from a `temporarily_unavailable` reply.
async fn probe_clerk_public_client(
    token_endpoint: &str,
    client_id: &str,
    redirect_uri: &str,
) -> Result<Option<bool>> {
    let client = oauth_http_client()?;
    let body: serde_json::Value = client
        .post(token_endpoint)
        .form(&[
            ("grant_type", "authorization_code"),
            ("client_id", client_id),
            ("code", "am-doctor-probe"),
            ("redirect_uri", redirect_uri),
            (
                "code_verifier",
                "am-doctor-probe-verifier-not-for-real-login",
            ),
        ])
        .send()
        .await
        .context("probe clerk token endpoint")?
        .json()
        .await
        .context("parse clerk probe response")?;

    Ok(classify_clerk_probe(
        body.get("error").and_then(|v| v.as_str()),
    ))
}

/// Map a token-endpoint error code to client-registration status.
fn classify_clerk_probe(error: Option<&str>) -> Option<bool> {
    match error {
        Some("invalid_grant") => Some(true),
        Some("invalid_client") => Some(false),
        Some(other) => {
            tracing::warn!(error = other, "unexpected clerk probe error");
            None
        }
        None => None,
    }
}

async fn probe_api_health(base_url: &str) -> Result<bool> {
    let url = format!("{}/healthz", base_url.trim_end_matches('/'));
    let client = oauth_http_client()?;
    let status = client
        .get(&url)
        .timeout(API_HEALTH_TIMEOUT)
        .send()
        .await
        .with_context(|| format!("GET {url}"))?
        .status();
    Ok(status.is_success())
}

pub async fn require_login_ready(
    api_base_url: Option<&str>,
    overrides: DoctorOverrides,
) -> Result<()> {
    let report = run_doctor(api_base_url.map(str::to_string), overrides).await?;
    if report_ok(&report) {
        return Ok(());
    }
    bail!(
        "OAuth preflight failed — run `am auth doctor` for details.\n{}",
        report.hints.join("\n")
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::DEFAULT_CLOUD_URL;

    #[test]
    fn report_ok_requires_clerk_client() {
        let ok = DoctorReport {
            issuer: "https://issuer".into(),
            client_id: "cid".into(),
            redirect_uri: "http://127.0.0.1:9876/callback".into(),
            authorization_endpoint: "https://issuer/oauth/authorize".into(),
            token_endpoint: "https://issuer/oauth/token".into(),
            oauth_metadata_ok: true,
            clerk_client_registered: true,
            api_health_ok: Some(true),
            api_base_url: DEFAULT_CLOUD_URL.into(),
            hints: vec![],
        };
        assert!(report_ok(&ok));

        let bad = DoctorReport {
            clerk_client_registered: false,
            ..ok
        };
        assert!(!report_ok(&bad));
    }

    #[test]
    fn only_invalid_client_is_a_definite_rejection() {
        // Table over every response class the token endpoint can produce.
        assert_eq!(classify_clerk_probe(Some("invalid_grant")), Some(true));
        assert_eq!(classify_clerk_probe(Some("invalid_client")), Some(false));
        for indeterminate in [
            Some("temporarily_unavailable"),
            Some("server_error"),
            Some("slow_down"),
            Some(""),
            None,
        ] {
            assert_eq!(
                classify_clerk_probe(indeterminate),
                None,
                "{indeterminate:?} must not be read as a registration verdict"
            );
        }
    }
}
