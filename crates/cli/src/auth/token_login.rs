//! Paste a Clerk session JWT (same token the web dashboard uses).

use anyhow::{Context, Result, bail};
use chrono::Utc;

use crate::auth::claims::decode_id_token;
use crate::auth::setup::setup_default_project;
use crate::config::{OAuthTokens, resolve_profile, store_oauth};

pub async fn run_login_token(
    profile: &str,
    token: String,
    skip_project_select: bool,
    base_url: Option<&str>,
) -> Result<()> {
    let token = token.trim().to_string();
    if token.is_empty() {
        bail!("empty token — pass --token or pipe JWT on stdin");
    }

    // The pasted session belongs to the Cloud origin this invocation targets;
    // record it so the token can never be replayed against another origin.
    let target_base_url = resolve_profile(Some(profile), base_url, None)?.base_url;

    let claims = decode_id_token(&token).context("decode pasted JWT")?;
    if let Some(exp) = claims.exp
        && exp <= Utc::now().timestamp()
    {
        bail!("token is expired — sign in via the web dashboard and paste a fresh JWT");
    }

    store_oauth(
        profile,
        OAuthTokens {
            id_token: token,
            refresh_token: None,
            expires_at: claims.exp,
            issuer: claims.iss,
            api_origin: None,
        },
        &target_base_url,
    )?;
    eprintln!("Saved session for profile '{profile}'.");
    eprintln!(
        "Note: pasted tokens do not include a refresh token — re-login when the session expires."
    );
    if !skip_project_select {
        setup_default_project(profile, true, base_url).await?;
    }
    Ok(())
}
