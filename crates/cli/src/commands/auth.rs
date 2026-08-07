//! `am auth` — login, logout, status, and auth diagnostics.

use anyhow::Result;
use clap::Subcommand;

use crate::auth::claims::decode_id_token;
use crate::auth::doctor::{DoctorOverrides, report_ok, run_doctor};
use crate::auth::login::{LoginOptions, run_login};
use crate::auth::token::valid_bearer_token;
use crate::auth::token_login::run_login_token;
use crate::cli::GlobalOptions;
use crate::config::{
    clear_oauth, ensure_config_initialized, resolve_profile, store_profile_base_url,
};
use crate::output::{emit, message};

#[derive(Debug, Subcommand)]
pub enum AuthCommand {
    /// Log in via browser (OAuth2 PKCE loopback against Clerk)
    Login {
        /// Override Clerk issuer (default baked into the CLI)
        #[arg(long)]
        issuer: Option<String>,
        /// Override OAuth client_id (default baked into the CLI; do not set via env on login)
        #[arg(long)]
        client_id: Option<String>,
        /// Loopback callback port (default 9876; must match Clerk redirect URI)
        #[arg(long)]
        port: Option<u16>,
        #[arg(long)]
        no_browser: bool,
        /// Paste a Clerk session JWT instead of browser OAuth (works immediately)
        #[arg(long)]
        token: Option<String>,
        /// Skip interactive default-project selection after login
        #[arg(long)]
        skip_project_select: bool,
        /// Skip org scope on OAuth login (dashboard APIs may need `am init` afterward)
        #[arg(long)]
        no_org: bool,
        /// Clear stored CLI OAuth tokens, then re-run browser login (`prompt=consent`)
        #[arg(long)]
        fresh: bool,
    },
    /// Preflight OAuth + API health (no secrets; run before reporting login bugs)
    Doctor {
        /// Cloud API base URL to health-check (default production)
        #[arg(long, env = "ATOMICMEMORY_API_URL")]
        base_url: Option<String>,
        /// Clerk issuer to probe (default from config or production)
        #[arg(long)]
        issuer: Option<String>,
        /// OAuth client_id to probe (default shipped production client)
        #[arg(long)]
        client_id: Option<String>,
    },
    /// Remove stored credentials for the active profile
    Logout,
    /// Show the currently authenticated user
    Whoami,
    /// Print a valid bearer token (requires --print-token)
    Token {
        #[arg(long)]
        print_token: bool,
    },
}

pub async fn run(cmd: AuthCommand, global: &GlobalOptions) -> Result<()> {
    let profile_name = global
        .profile
        .clone()
        .or_else(|| resolve_profile(None, None, None).ok().map(|p| p.name))
        .unwrap_or_else(|| crate::config::DEFAULT_PROFILE.to_string());

    match cmd {
        AuthCommand::Login {
            issuer,
            client_id,
            port,
            no_browser,
            token,
            skip_project_select,
            no_org,
            fresh,
        } => {
            ensure_config_initialized()?;
            if let Some(url) = global.base_url.as_deref() {
                store_profile_base_url(&profile_name, url)?;
            }
            if let Some(jwt) = token {
                return run_login_token(
                    &profile_name,
                    jwt,
                    skip_project_select,
                    global.base_url.as_deref(),
                )
                .await;
            }
            let resolved = resolve_profile(
                Some(&profile_name),
                global.base_url.as_deref(),
                global.environment,
            )?;
            run_login(
                LoginOptions {
                    profile: profile_name,
                    port,
                    no_browser,
                    issuer,
                    client_id,
                    skip_project_select,
                    base_url: Some(resolved.base_url),
                    org_scope: !no_org,
                    fresh_login: fresh,
                    verbose: global.verbose > 0,
                    quiet: global.quiet,
                },
                None,
                None,
            )
            .await
        }
        AuthCommand::Doctor {
            base_url,
            issuer,
            client_id,
        } => {
            let report = run_doctor(
                base_url.or_else(|| global.base_url.clone()),
                DoctorOverrides { client_id, issuer },
            )
            .await?;
            let ready = report_ok(&report);
            emit(global.output, &report, global.quiet)?;
            if ready {
                message(
                    !global.quiet,
                    "OAuth preflight OK — browser login should work.",
                );
            } else {
                for hint in &report.hints {
                    message(!global.quiet, hint);
                }
                anyhow::bail!("OAuth preflight failed");
            }
            Ok(())
        }
        AuthCommand::Logout => {
            clear_oauth(&profile_name)?;
            message(!global.quiet, "Logged out.");
            Ok(())
        }
        AuthCommand::Whoami => {
            let profile = resolve_profile(Some(&profile_name), global.base_url.as_deref(), None)?;
            let token = valid_bearer_token(&profile_name, &profile.base_url).await?;
            let claims = decode_id_token(&token)?;
            emit(global.output, &claims, global.quiet)
        }
        AuthCommand::Token { print_token } => {
            if !print_token {
                anyhow::bail!("refusing to print token — pass --print-token for scripting use");
            }
            eprintln!("warning: token printed to stdout; avoid logging or piping to files");
            let profile = resolve_profile(Some(&profile_name), global.base_url.as_deref(), None)?;
            let token = valid_bearer_token(&profile_name, &profile.base_url).await?;
            println!("{token}");
            Ok(())
        }
    }
}
