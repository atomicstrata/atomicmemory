//! `am auth` — login, logout, status, and auth diagnostics.

use anyhow::Result;
use clap::Subcommand;

use crate::auth::claims::decode_id_token;
use crate::auth::device_login::{DeviceLoginOptions, run_device_login};
use crate::auth::doctor::{DoctorOverrides, report_ok, run_doctor};
use crate::auth::login::{LoginOptions, run_login};
use crate::auth::token::valid_bearer_token;
use crate::auth::token_login::run_login_token;
use crate::cli::GlobalOptions;
use crate::config::{
    clear_oauth, ensure_config_initialized, resolve_profile, store_profile_base_url,
};
use crate::output::{emit, message};

/// How `am auth login` authenticates after flag parsing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthLoginMethod {
    /// Paste a dashboard session JWT (`--token`).
    Token,
    /// OAuth device flow (headless / remote VPS; refreshable).
    Device,
    /// Browser OAuth with loopback callback.
    Browser,
}

/// Pick the login path from mutually exclusive / headless-routing flags.
///
/// `--device` and `--no-browser` both select device flow: loopback OAuth cannot
/// finish when the authorize URL is opened on another machine.
pub fn select_auth_login_method(
    has_token: bool,
    device: bool,
    no_browser: bool,
) -> AuthLoginMethod {
    if has_token {
        AuthLoginMethod::Token
    } else if device || no_browser {
        AuthLoginMethod::Device
    } else {
        AuthLoginMethod::Browser
    }
}

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
        /// Skip opening a browser; use OAuth device flow instead (same as `--device`)
        #[arg(long, conflicts_with_all = ["token", "port", "fresh", "no_org"])]
        no_browser: bool,
        /// Authenticate via OAuth device flow (preferred for remote / headless hosts)
        #[arg(long, conflicts_with_all = ["token", "port", "fresh", "no_org"])]
        device: bool,
        /// Paste a Clerk session JWT instead of browser OAuth (short-lived; no refresh)
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
            device,
            token,
            skip_project_select,
            no_org,
            fresh,
        } => {
            ensure_config_initialized()?;
            if let Some(url) = global.base_url.as_deref() {
                store_profile_base_url(&profile_name, url)?;
            }
            let method = select_auth_login_method(token.is_some(), device, no_browser);
            match method {
                AuthLoginMethod::Token => {
                    let jwt = token.expect("token method requires --token");
                    run_login_token(
                        &profile_name,
                        jwt,
                        skip_project_select,
                        global.base_url.as_deref(),
                    )
                    .await
                }
                AuthLoginMethod::Device => {
                    let resolved = resolve_profile(
                        Some(&profile_name),
                        global.base_url.as_deref(),
                        global.environment,
                    )?;
                    run_device_login(
                        DeviceLoginOptions {
                            profile: profile_name,
                            base_url: resolved.base_url,
                            client_id,
                            issuer,
                            quiet: global.quiet,
                            verbose: global.verbose > 0,
                            skip_project_select,
                        },
                        None,
                        None,
                    )
                    .await
                }
                AuthLoginMethod::Browser => {
                    let resolved = resolve_profile(
                        Some(&profile_name),
                        global.base_url.as_deref(),
                        global.environment,
                    )?;
                    run_login(
                        LoginOptions {
                            profile: profile_name,
                            port,
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
            }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::Cli;
    use crate::cli::Command;
    use clap::Parser;

    #[test]
    fn select_method_prefers_token_then_device_then_browser() {
        assert_eq!(
            select_auth_login_method(true, false, false),
            AuthLoginMethod::Token
        );
        assert_eq!(
            select_auth_login_method(false, true, false),
            AuthLoginMethod::Device
        );
        assert_eq!(
            select_auth_login_method(false, false, true),
            AuthLoginMethod::Device
        );
        assert_eq!(
            select_auth_login_method(false, true, true),
            AuthLoginMethod::Device
        );
        assert_eq!(
            select_auth_login_method(false, false, false),
            AuthLoginMethod::Browser
        );
    }

    #[test]
    fn auth_login_device_flag_parses() {
        let cli = Cli::try_parse_from(["am", "auth", "login", "--device"]).unwrap();
        match cli.command {
            Command::Auth(AuthCommand::Login {
                device,
                no_browser,
                token,
                ..
            }) => {
                assert!(device);
                assert!(!no_browser);
                assert!(token.is_none());
            }
            other => panic!("expected auth login --device, got {other:?}"),
        }
    }

    #[test]
    fn auth_login_no_browser_routes_like_device() {
        let cli = Cli::try_parse_from(["am", "auth", "login", "--no-browser"]).unwrap();
        match cli.command {
            Command::Auth(AuthCommand::Login {
                device,
                no_browser,
                token,
                ..
            }) => {
                assert!(!device);
                assert!(no_browser);
                assert!(token.is_none());
                assert_eq!(
                    select_auth_login_method(token.is_some(), device, no_browser),
                    AuthLoginMethod::Device
                );
            }
            other => panic!("expected auth login --no-browser, got {other:?}"),
        }
    }

    #[test]
    fn auth_login_token_parses_as_token_method() {
        let cli = Cli::try_parse_from(["am", "auth", "login", "--token", "eyJ.test"]).unwrap();
        match cli.command {
            Command::Auth(AuthCommand::Login {
                device,
                no_browser,
                token,
                ..
            }) => {
                assert!(!device);
                assert!(!no_browser);
                assert_eq!(token.as_deref(), Some("eyJ.test"));
                assert_eq!(
                    select_auth_login_method(token.is_some(), device, no_browser),
                    AuthLoginMethod::Token
                );
            }
            other => panic!("expected auth login --token, got {other:?}"),
        }
    }

    #[test]
    fn auth_login_default_is_browser() {
        let cli = Cli::try_parse_from(["am", "auth", "login"]).unwrap();
        match cli.command {
            Command::Auth(AuthCommand::Login {
                device,
                no_browser,
                token,
                ..
            }) => {
                assert_eq!(
                    select_auth_login_method(token.is_some(), device, no_browser),
                    AuthLoginMethod::Browser
                );
            }
            other => panic!("expected auth login, got {other:?}"),
        }
    }

    #[test]
    fn no_browser_rejects_the_same_flags_as_device() {
        // Both spellings select the device flow, which cannot honor browser-only
        // options, so both must refuse them rather than silently ignore them.
        for spelling in ["--device", "--no-browser"] {
            for extra in [
                &["--fresh"][..],
                &["--no-org"][..],
                &["--port", "9999"][..],
                &["--token", "x"][..],
            ] {
                let mut args = vec!["am", "auth", "login", spelling];
                args.extend_from_slice(extra);
                assert!(
                    Cli::try_parse_from(&args).is_err(),
                    "{args:?} must be rejected, not silently ignored"
                );
            }
        }
    }

    #[test]
    fn device_flow_accepts_oauth_pair_overrides() {
        for spelling in ["--device", "--no-browser"] {
            Cli::try_parse_from([
                "am",
                "auth",
                "login",
                spelling,
                "--issuer",
                "https://clerk.custom.example",
                "--client-id",
                "custom-client",
            ])
            .unwrap_or_else(|err| panic!("{spelling} with overrides must parse: {err}"));
        }
    }

    #[test]
    fn auth_login_rejects_device_with_token() {
        let err = Cli::try_parse_from(["am", "auth", "login", "--device", "--token", "x"])
            .expect_err("device conflicts with token");
        let msg = err.to_string();
        assert!(
            msg.contains("cannot be used with") || msg.contains("conflict"),
            "unexpected clap error: {msg}"
        );
    }

    #[test]
    fn headless_hint_points_at_device_flow() {
        use crate::auth::login::headless_login_next_steps;
        let msg = headless_login_next_steps(Some("No such file or directory"));
        assert!(msg.contains("Could not open a browser"));
        assert!(msg.contains("am auth login --device"));
        assert!(msg.contains("am auth login --token"));
        assert!(!msg.contains("cancel and run"));
    }
}
