//! Clerk OAuth Authorization Code + PKCE loopback login.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use axum::Router;
use axum::extract::{Query, State};
use axum::response::{Html, IntoResponse};
use axum::routing::get;
use tokio::sync::{Mutex, oneshot};

use crate::auth::auth_wait::wait_for_oneshot;
use crate::auth::clerk_oauth::{
    invalid_client_help, reject_blank_oauth_overrides, resolve_oauth_pair, resolve_public_client_id,
};
use crate::auth::doctor::{DoctorOverrides, require_login_ready};
use crate::auth::login_feedback::LoginFeedback;
use crate::auth::pkce::{generate_pkce_pair, generate_state};
use crate::auth::setup::setup_default_project;
use crate::auth::token::{build_authorize_url, discover_metadata, exchange_code};
use crate::config::{
    DEFAULT_OAUTH_CALLBACK_PORT, clear_oauth, load_config, resolve_profile, store_oauth,
    update_config,
};
use crate::progress::ProgressReporter;

const CALLBACK_TIMEOUT: Duration = Duration::from_secs(120);

/// Next steps when loopback browser OAuth cannot finish on this host.
pub fn headless_login_next_steps(open_error: Option<&str>) -> String {
    let mut msg = String::new();
    if let Some(err) = open_error {
        msg.push_str(&format!("Could not open a browser ({err}).\n"));
    }
    msg.push_str(
        "Browser OAuth uses a loopback callback on this machine, so opening the authorize \
         URL on another host cannot finish login.\n\
         On a remote or headless host, use device login (stores a refreshable Cloud session):\n\
           am auth login --device\n\
         Short paste session (no refresh token): am auth login --token <dashboard-jwt>",
    );
    msg
}

#[derive(Debug, Clone)]
pub struct LoginOptions {
    pub profile: String,
    pub port: Option<u16>,
    pub issuer: Option<String>,
    pub client_id: Option<String>,
    pub skip_project_select: bool,
    pub base_url: Option<String>,
    /// Request Clerk `user:org:read` (requires scope enabled on the OAuth app)
    pub org_scope: bool,
    /// Drop stored OAuth tokens before opening the browser (re-consent with `prompt=consent`).
    pub fresh_login: bool,
    pub verbose: bool,
    pub quiet: bool,
}

pub async fn run_login(
    opts: LoginOptions,
    progress: Option<&mut dyn ProgressReporter>,
    progress_step: Option<&str>,
) -> Result<()> {
    let feedback = LoginFeedback::detect(opts.verbose, opts.quiet);
    let step_id = progress_step.unwrap_or("identity");
    // Before any config write: browser login persists overrides into the
    // global [oauth] table, so a blank one would replace a working pair.
    reject_blank_oauth_overrides(opts.issuer.as_deref(), opts.client_id.as_deref())?;

    let mut config = load_config()?;
    if let Some(issuer) = opts.issuer.clone() {
        config.oauth.issuer = Some(issuer);
    }
    let profile = resolve_profile(Some(&opts.profile), opts.base_url.as_deref(), None)?;
    let login_base_url = profile.base_url;
    let client_id = resolve_public_client_id(&config, opts.client_id.clone(), &login_base_url)?;
    if opts.client_id.is_some() || config.oauth.client_id.as_deref() != Some(client_id.as_str()) {
        let issuer_override = opts.issuer.clone();
        let stored_client_id = client_id.clone();
        update_config(|cfg| {
            if let Some(issuer) = issuer_override {
                cfg.oauth.issuer = Some(issuer);
            }
            cfg.oauth.client_id = Some(stored_client_id);
            Ok(())
        })?;
    }
    let (issuer, _) = resolve_oauth_pair(
        &config,
        &login_base_url,
        opts.client_id.clone(),
        opts.issuer.clone(),
    )?;

    require_login_ready(
        Some(&login_base_url),
        DoctorOverrides {
            client_id: Some(client_id.clone()),
            issuer: Some(issuer.clone()),
        },
    )
    .await?;

    if opts.fresh_login {
        clear_oauth(&opts.profile)?;
    }

    let meta = discover_metadata(&issuer).await?;

    let pkce = generate_pkce_pair();
    let state = generate_state();
    let port = opts.port.unwrap_or(DEFAULT_OAUTH_CALLBACK_PORT);
    let listener = tokio::net::TcpListener::bind(SocketAddr::from((
        std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST),
        port,
    )))
    .await
    .with_context(|| format!("bind loopback callback server on port {port}"))?;
    let redirect_uri = format!("http://127.0.0.1:{port}/callback");

    let (tx, rx) = oneshot::channel::<CallbackResult>();
    let shared = Arc::new(CallbackState {
        expected_state: state.clone(),
        tx: Arc::new(Mutex::new(Some(tx))),
    });

    let app = Router::new()
        .route("/callback", get(callback))
        .with_state(shared);

    let server =
        tokio::spawn(async move { axum::serve(listener, app).await.context("callback server") });

    let authorize_url = build_authorize_url(
        &meta.authorization_endpoint,
        &client_id,
        &redirect_uri,
        &state,
        &pkce.challenge,
        opts.org_scope,
    )?;

    if feedback.show_authorize_url() {
        eprintln!("Authorize URL:\n{authorize_url}\n");
    }
    // Loopback OAuth only works when a browser on THIS host hits redirect_uri.
    // A failed open would leave the process stranded — exit with the supported
    // remote path instead of waiting on 127.0.0.1. (`--no-browser` never reaches
    // here: it selects the device flow before browser login starts.)
    if let Err(err) = open::that(authorize_url.as_str()) {
        server.abort();
        bail!("{}", headless_login_next_steps(Some(&err.to_string())));
    }
    if feedback.concise_tty() {
        eprintln!("Complete sign-in in your browser…");
    } else if feedback.show_waiting_message() {
        eprintln!("Waiting for browser login on {redirect_uri} …");
        if feedback.show_recovery_hints() {
            eprintln!(
                "Approve “Atomic Strata Cloud CLI” when prompted — you should land on {redirect_uri}."
            );
            eprintln!(
                "If the browser stays on memory.dev/projects, paste the Authorize URL above into a \
                 private/incognito window (no sign-out required)."
            );
        }
    }

    let callback = wait_for_oneshot(
        rx,
        progress,
        step_id,
        CALLBACK_TIMEOUT,
        "waiting for browser",
    )
    .await
    .map_err(|err| {
        if feedback.show_authorize_url() {
            anyhow::anyhow!(
                "{err} — no callback received at {redirect_uri}.\n\
                 Paste the Authorize URL printed above into a private/incognito window and approve access.\n\
                 Remote/headless: am auth login --device\n\
                 Short paste: am auth login --token <jwt from memory.dev with an org selected>"
            )
        } else {
            anyhow::anyhow!(
                "{err} — no callback received at {redirect_uri}.\n\
                 Re-run with --verbose for the authorize URL and recovery steps.\n\
                 Remote/headless: am auth login --device\n\
                 Short paste: am auth login --token <jwt from memory.dev with an org selected>"
            )
        }
    })?;

    server.abort();

    let code = match callback {
        CallbackResult::Ok { code, .. } => code,
        CallbackResult::Err { error, description } => {
            if error == "invalid_client" {
                bail!("{}\n{}", description, invalid_client_help());
            }
            if error == "invalid_scope" && description.contains("user:org:read") {
                bail!(
                    "oauth error: {error} — {description}\n\
                     Omit --no-org for now, or enable the user:org:read scope on the \
                     Atomic Strata Cloud CLI OAuth app in Clerk Dashboard.\n\
                     Remote/headless: am auth login --device\n\
                     Short paste: am auth login --token <jwt from memory.dev with an org selected>"
                );
            }
            bail!("oauth error: {error} — {description}");
        }
    };

    let mut tokens = exchange_code(
        &meta.token_endpoint,
        &client_id,
        &code,
        &redirect_uri,
        &pkce.verifier,
    )
    .await
    .map_err(|e| {
        if e.to_string().contains("invalid_client") {
            anyhow::anyhow!("{e}\n{}", invalid_client_help())
        } else {
            e
        }
    })?;
    tokens.issuer = Some(issuer);
    store_oauth(&opts.profile, tokens, &login_base_url)?;
    if let Some(base_url) = opts.base_url.clone() {
        update_config(|cfg| {
            let entry = cfg.profiles.entry(opts.profile.clone()).or_default();
            entry.base_url = Some(base_url);
            Ok(())
        })?;
    }
    if feedback.show_success() {
        eprintln!("{}", feedback.success_line(&opts.profile));
    }
    if !opts.skip_project_select {
        setup_default_project(&opts.profile, true, opts.base_url.as_deref()).await?;
    }
    Ok(())
}

#[derive(Clone)]
struct CallbackState {
    expected_state: String,
    tx: Arc<Mutex<Option<oneshot::Sender<CallbackResult>>>>,
}

#[derive(Debug)]
enum CallbackResult {
    Ok { code: String, _state: String },
    Err { error: String, description: String },
}

#[derive(Debug, serde::Deserialize)]
struct CallbackQuery {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

async fn callback(
    State(state): State<Arc<CallbackState>>,
    Query(q): Query<CallbackQuery>,
) -> impl IntoResponse {
    let result = if let Some(error) = q.error {
        CallbackResult::Err {
            error,
            description: q.error_description.unwrap_or_default(),
        }
    } else if q.state.as_deref() != Some(state.expected_state.as_str()) {
        CallbackResult::Err {
            error: "invalid_state".into(),
            description: "CSRF state mismatch".into(),
        }
    } else if let Some(code) = q.code {
        CallbackResult::Ok {
            code,
            _state: q.state.unwrap_or_default(),
        }
    } else {
        CallbackResult::Err {
            error: "missing_code".into(),
            description: "authorization code missing".into(),
        }
    };

    let is_ok = matches!(result, CallbackResult::Ok { .. });
    if let Some(tx) = state.tx.lock().await.take() {
        let _ = tx.send(result);
    }
    if is_ok {
        Html(CALLBACK_SUCCESS_HTML).into_response()
    } else {
        Html(CALLBACK_ERROR_HTML).into_response()
    }
}

const CALLBACK_SUCCESS_HTML: &str = r#"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Login complete</title>
<style>
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #000;
    color: #fff;
    font-family: system-ui, -apple-system, sans-serif;
    text-align: center;
  }
  #countdown { opacity: 0.75; margin-top: 0.75rem; font-size: 0.95rem; }
</style>
</head>
<body>
  <div>
    <p>Login complete. You can close this window.</p>
    <p id="countdown">Closing in 3s…</p>
  </div>
  <script>
  (function () {
    var remaining = 3;
    var el = document.getElementById('countdown');
    var timer = setInterval(function () {
      remaining -= 1;
      if (remaining > 0) {
        el.textContent = 'Closing in ' + remaining + 's…';
        return;
      }
      clearInterval(timer);
      el.textContent = 'You can close this window.';
      try { window.open('', '_self'); } catch (_) {}
      try { window.close(); } catch (_) {}
    }, 1000);
  })();
  </script>
</body>
</html>
"#;

const CALLBACK_ERROR_HTML: &str = r#"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Login failed</title>
<style>
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #000;
    color: #fff;
    font-family: system-ui, -apple-system, sans-serif;
    text-align: center;
  }
</style>
</head>
<body>
  <p>Login failed. You can close this window and check the CLI.</p>
</body>
</html>
"#;
