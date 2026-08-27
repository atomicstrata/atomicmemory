//! Connected Local operator helpers — overview, env bootstrap, and doctor checks.

use std::time::Duration;

use am_cloud_types::RuntimePresence;
use anyhow::{Result, bail};
use chrono::{DateTime, Utc};
use clap::{Args, Subcommand, ValueEnum};
use serde::Serialize;

use crate::auth::token::valid_bearer_token;
use crate::cli::GlobalOptions;
use crate::commands::client::{cloud_api_key_client, dashboard_client, memory_client, resolve_ctx};
use crate::commands::connect_project::{ConnectProjectOptions, run as run_connect_project};
use crate::commands::local_clients::{
    KeyProvenance, redact_secret, render_client_env_block, resolve_local_clients,
};
use crate::config::{ProfileKind, jwks_url, require_api_key, resolve_core_api_key};
use crate::instance::docker::DockerRunner;
use crate::instance::managed_core_profile_mismatch;
use crate::instance::{
    CORE_STATE_KEY_PATH, DEFAULT_CONTAINER_NAME, RealDockerRunner, read_managed_core_api_key_with,
};
use crate::output::{emit, message};

const RECENT_TRACE_WINDOW: Duration = Duration::from_secs(15 * 60);

/// Which environment block `connect env` emits.
#[derive(Debug, Clone, Copy, Default, ValueEnum, PartialEq, Eq)]
pub enum EnvAudience {
    /// Core outbound → Cloud trace sync (default, backward compatible).
    #[default]
    Sync,
    /// Local apps / SDKs → Core.
    Clients,
    /// Both blocks, clearly labeled.
    All,
}

#[derive(Debug, Args)]
#[command(args_conflicts_with_subcommands = true)]
pub struct ConnectOptions {
    /// Cloud project id or slug — one-shot connect (login, link, key, Core, verify)
    #[arg(long)]
    pub project: Option<String>,
    /// Authenticate via OAuth device flow instead of browser login
    #[arg(long)]
    pub device: bool,
    /// Skip starting Core when using `--project`
    #[arg(long)]
    pub no_instance: bool,
    /// Skip memory smoke verification when using `--project`
    #[arg(long)]
    pub skip_verify: bool,
    /// Replace foreign Docker container when starting Core (`--project`)
    #[arg(long)]
    pub replace: bool,
    #[command(subcommand)]
    pub command: Option<ConnectCommand>,
}

#[derive(Debug, Subcommand)]
pub enum ConnectCommand {
    /// Cloud/Core connected-local overview (traces, runtimes, health)
    Overview,
    /// Deprecated alias for `overview` (hidden; removed next release)
    #[command(hide = true)]
    Status,
    /// Print Connected Local environment variables
    Env {
        /// Which credential audience to print
        #[arg(long, value_enum, default_value_t = EnvAudience::Sync)]
        r#for: EnvAudience,
        /// Include raw secrets in output (default: redacted)
        #[arg(long)]
        show_secrets: bool,
    },
    /// Run ordered Connected Local readiness checks
    Doctor,
    /// Mint and print a short-lived Core JWT (debugging)
    Token {
        /// Print token to stdout (required for scripting)
        #[arg(long)]
        print_token: bool,
    },
}

pub async fn run(opts: ConnectOptions, global: &GlobalOptions) -> Result<()> {
    if let Some(project) = opts.project {
        if !global.quiet {
            eprintln!(
                "Note: prefer `am init --project` for onboarding — `am connect --project` remains supported."
            );
        }
        let connect_opts = ConnectProjectOptions {
            no_instance: opts.no_instance,
            skip_verify: opts.skip_verify,
            replace: opts.replace,
            instance_image: None,
            interactive: !global.quiet,
        };
        return run_connect_project(&project, opts.device, &connect_opts, global).await;
    }

    match opts.command {
        Some(ConnectCommand::Overview | ConnectCommand::Status) => run_overview(global).await,
        Some(ConnectCommand::Env {
            r#for,
            show_secrets,
        }) => run_env(global, r#for, show_secrets).await,
        Some(ConnectCommand::Doctor) => run_doctor(global).await,
        Some(ConnectCommand::Token { print_token }) => run_token(global, print_token).await,
        None => run_overview(global).await,
    }
}

async fn run_overview(global: &GlobalOptions) -> Result<()> {
    let profile = resolve_ctx(global).await?;
    ensure_local_profile(&profile)?;

    let mut report = serde_json::json!({
        "profile": profile.name,
        "kind": format!("{:?}", profile.kind),
        "cloud_base_url": profile.base_url,
        "local_url": profile.memory_base_url,
        "project_id": profile.project_id,
        "core_auth": core_auth_mode(&profile),
    });

    if let Ok((_p, dash)) = dashboard_client(global).await {
        if let Ok(h) = dash.healthz().await {
            report["cloud_health"] = h;
        }
        if let Some(project_id) = profile.project_id.as_deref() {
            if let Ok(traces) = dash.list_traces(project_id, Some(5)).await {
                report["recent_traces"] = serde_json::to_value(&traces)?;
            }
            match dash.list_runtimes(project_id).await {
                Ok(runtimes) => {
                    report["runtimes"] = serde_json::to_value(&runtimes)?;
                    report["runtime_online_count"] = serde_json::json!(
                        runtimes
                            .iter()
                            .filter(|r| r.presence == RuntimePresence::Online)
                            .count()
                    );
                }
                Err(err) => {
                    report["runtimes_error"] = serde_json::json!(err.to_string());
                }
            }
        }
    }

    if let Ok((_p, mem)) = memory_client(global).await
        && let Ok(h) = mem.health().await
    {
        report["core_health"] = serde_json::to_value(h)?;
    }

    emit(global.output, &report, global.quiet)
}

async fn run_env(global: &GlobalOptions, audience: EnvAudience, show_secrets: bool) -> Result<()> {
    let profile = resolve_ctx(global).await?;
    ensure_local_profile(&profile)?;

    let block = match audience {
        EnvAudience::Sync => {
            let api_key = require_api_key(&profile)?;
            render_trace_sync_env(&profile.base_url, &api_key, show_secrets)
        }
        EnvAudience::Clients => {
            let key = resolve_client_key_for_env(&profile, show_secrets).await?;
            render_client_env_block(&profile.memory_base_url, &key, show_secrets)
        }
        EnvAudience::All => {
            let api_key = require_api_key(&profile)?;
            let sync = render_trace_sync_env(&profile.base_url, &api_key, show_secrets);
            let client_key = resolve_client_key_for_env(&profile, show_secrets).await?;
            let clients =
                render_client_env_block(&profile.memory_base_url, &client_key, show_secrets);
            format!("{sync}\n\n{clients}")
        }
    };

    if global.quiet {
        println!("{block}");
    } else {
        match audience {
            EnvAudience::Sync => {
                message(
                    true,
                    "# Connected Local — Core trace sync (paste into Core .env)",
                );
                println!("{block}");
                message(true, &next_step_after_connect_env_sync());
            }
            EnvAudience::Clients => {
                message(true, "# Connected Local — local apps / SDKs → Core");
                println!("{block}");
                message(true, &next_step_after_connect_env_clients());
            }
            EnvAudience::All => {
                message(true, "# Connected Local — all environment blocks");
                println!("{block}");
                message(true, &next_step_after_connect_env_sync());
            }
        }
    }
    Ok(())
}

async fn resolve_client_key_for_env(
    profile: &crate::config::ResolvedProfile,
    _show_secrets: bool,
) -> Result<String> {
    let docker = RealDockerRunner::new();
    let state_key = read_managed_core_key(&docker, &profile.name, &profile.memory_base_url).await?;
    if let Some(key) = state_key {
        return Ok(key);
    }
    if let Some(key) = resolve_core_api_key() {
        return Ok(key);
    }
    bail!(
        "no CORE_API_KEY available — start managed Core (`am instance start`) or read:\n  docker exec {DEFAULT_CONTAINER_NAME} cat {CORE_STATE_KEY_PATH}"
    );
}

async fn read_managed_core_key(
    docker: &dyn DockerRunner,
    profile_name: &str,
    destination_url: &str,
) -> Result<Option<String>> {
    read_managed_core_api_key_with(docker, profile_name, destination_url).await
}

async fn run_doctor(global: &GlobalOptions) -> Result<()> {
    message(
        !global.quiet,
        "Checking Core ↔ Cloud wiring (Docker lifecycle: `am instance status`)",
    );

    let profile = resolve_ctx(global).await?;
    let docker = RealDockerRunner::new();
    let mut checks = Vec::new();

    checks.push(check_local_profile(&profile));
    checks.push(check_logged_in(&profile).await);
    checks.push(check_cloud_api_key(&profile));
    checks.push(check_core_reachable(global, &profile).await);
    checks.push(check_core_profile_label(&profile, &docker).await);
    checks.push(check_jwks_reachable(&profile.base_url).await);
    checks.push(check_mint_token(global).await);
    checks.push(check_local_client_auth(&profile, &docker, !global.quiet).await);
    if let Some(project_id) = profile.project_id.as_deref() {
        checks.push(check_recent_trace(global, project_id).await);
        checks.push(check_runtime_presence(global, project_id).await);
    }

    let ready = checks
        .iter()
        .all(|c| c.status == "pass" || c.status == "warn");
    let report = ConnectDoctorReport {
        profile: profile.name.clone(),
        checks: checks.clone(),
        ready,
    };
    emit(global.output, &report, global.quiet)?;

    for check in &checks {
        if check.status == "fail" {
            if let Some(hint) = &check.hint {
                message(!global.quiet, hint);
            }
            anyhow::bail!("connect doctor failed: {}", check.name);
        }
    }

    message(!global.quiet, &next_step_after_doctor_pass());
    Ok(())
}

async fn run_token(global: &GlobalOptions, print_token: bool) -> Result<()> {
    if !print_token {
        anyhow::bail!("refusing to print token — pass --print-token for scripting use");
    }
    let profile = resolve_ctx(global).await?;
    ensure_local_profile(&profile)?;
    let (_profile, client) = cloud_api_key_client(global).await?;
    let token = client.mint_local_token().await?;
    eprintln!("warning: token printed to stdout; avoid logging or piping to files");
    println!("{}", token.access_token);
    Ok(())
}

fn ensure_local_profile(profile: &crate::config::ResolvedProfile) -> Result<()> {
    if profile.kind != ProfileKind::Local {
        anyhow::bail!(
            "connect commands require a local profile — run `am link local` or `am config profile add --kind local`"
        );
    }
    Ok(())
}

fn core_auth_mode(profile: &crate::config::ResolvedProfile) -> &'static str {
    if resolve_core_api_key().is_some() {
        "core_api_key_env"
    } else if profile.api_key.is_some() {
        "cloud_jwt_mint"
    } else {
        "unset"
    }
}

#[derive(Debug, Clone, Serialize)]
struct DoctorCheck {
    name: String,
    status: String,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    hint: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct ConnectDoctorReport {
    profile: String,
    checks: Vec<DoctorCheck>,
    ready: bool,
}

fn check_local_profile(profile: &crate::config::ResolvedProfile) -> DoctorCheck {
    if profile.kind == ProfileKind::Local {
        DoctorCheck {
            name: "local_profile".into(),
            status: "pass".into(),
            message: format!("profile '{}' is local", profile.name),
            hint: None,
        }
    } else {
        DoctorCheck {
            name: "local_profile".into(),
            status: "fail".into(),
            message: "active profile is not local".into(),
            hint: Some("run `am link local` or switch with `am config profile use`".into()),
        }
    }
}

async fn check_logged_in(profile: &crate::config::ResolvedProfile) -> DoctorCheck {
    match valid_bearer_token(&profile.name, &profile.base_url).await {
        Ok(_) => DoctorCheck {
            name: "cloud_login".into(),
            status: "pass".into(),
            message: "Clerk session token available".into(),
            hint: None,
        },
        Err(err) => DoctorCheck {
            name: "cloud_login".into(),
            status: "fail".into(),
            message: err.to_string(),
            hint: Some("run `am auth login`".into()),
        },
    }
}

fn check_cloud_api_key(profile: &crate::config::ResolvedProfile) -> DoctorCheck {
    match require_api_key(profile) {
        Ok(key) if key.starts_with("amc_") => DoctorCheck {
            name: "cloud_api_key".into(),
            status: "pass".into(),
            message: "Cloud API key (amc_) stored for trace sync and JWT mint".into(),
            hint: None,
        },
        Ok(_) => DoctorCheck {
            name: "cloud_api_key".into(),
            status: "fail".into(),
            message: "stored key is not a Cloud API key (amc_…)".into(),
            hint: Some(
                "run `am key create connected-traces --save` — do not store CORE_API_KEY here"
                    .into(),
            ),
        },
        Err(err) => DoctorCheck {
            name: "cloud_api_key".into(),
            status: "fail".into(),
            message: err.to_string(),
            hint: Some("run `am key create connected-traces --save`".into()),
        },
    }
}

async fn check_core_reachable(
    global: &GlobalOptions,
    profile: &crate::config::ResolvedProfile,
) -> DoctorCheck {
    match memory_client(global).await {
        Ok((_p, client)) => match client.health().await {
            Ok(_) => DoctorCheck {
                name: "core_reachable".into(),
                status: "pass".into(),
                message: format!("Core health OK at {}", profile.memory_base_url),
                hint: None,
            },
            Err(err) => DoctorCheck {
                name: "core_reachable".into(),
                status: "fail".into(),
                message: err.to_string(),
                hint: Some(format!(
                    "ensure Core is running at {} (default port 17350)",
                    profile.memory_base_url
                )),
            },
        },
        Err(err) => DoctorCheck {
            name: "core_reachable".into(),
            status: "fail".into(),
            message: err.to_string(),
            hint: Some(
                "set CORE_API_KEY for direct Core auth, or store amc_ and ensure Cloud is reachable"
                    .into(),
            ),
        },
    }
}

async fn check_jwks_reachable(cloud_base_url: &str) -> DoctorCheck {
    let url = match jwks_url(cloud_base_url) {
        Ok(url) => url,
        Err(err) => {
            return DoctorCheck {
                name: "jwks_reachable".into(),
                status: "fail".into(),
                message: err.to_string(),
                hint: None,
            };
        }
    };
    let client = match reqwest::Client::builder()
        // Cloud/CDN returns 403 when User-Agent is missing (bare reqwest default).
        .user_agent(concat!("am/", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(10))
        .build()
    {
        Ok(client) => client,
        Err(err) => {
            return DoctorCheck {
                name: "jwks_reachable".into(),
                status: "fail".into(),
                message: err.to_string(),
                hint: None,
            };
        }
    };
    match client.get(&url).send().await {
        Ok(resp) if resp.status().is_success() => DoctorCheck {
            name: "jwks_reachable".into(),
            status: "pass".into(),
            message: format!("JWKS reachable at {url}"),
            hint: None,
        },
        Ok(resp) => DoctorCheck {
            name: "jwks_reachable".into(),
            status: "fail".into(),
            message: format!("JWKS returned HTTP {}", resp.status()),
            hint: Some("verify Cloud API base URL on the profile".into()),
        },
        Err(err) => DoctorCheck {
            name: "jwks_reachable".into(),
            status: "fail".into(),
            message: err.to_string(),
            hint: Some(format!("check network access to {url}")),
        },
    }
}

async fn check_mint_token(global: &GlobalOptions) -> DoctorCheck {
    match cloud_api_key_client(global).await {
        Ok((_p, client)) => match client.mint_local_token().await {
            Ok(token) if !token.access_token.is_empty() => DoctorCheck {
                name: "jwt_mint".into(),
                status: "pass".into(),
                message: format!("Cloud minted Core JWT (expires_in={}s)", token.expires_in),
                hint: None,
            },
            Ok(_) => DoctorCheck {
                name: "jwt_mint".into(),
                status: "fail".into(),
                message: "mint returned empty access_token".into(),
                hint: None,
            },
            Err(err) => DoctorCheck {
                name: "jwt_mint".into(),
                status: "fail".into(),
                message: err.to_string(),
                hint: Some(
                    "ensure project is type=local and Cloud API key belongs to that project".into(),
                ),
            },
        },
        Err(err) => DoctorCheck {
            name: "jwt_mint".into(),
            status: "fail".into(),
            message: err.to_string(),
            hint: None,
        },
    }
}

async fn check_local_client_auth(
    profile: &crate::config::ResolvedProfile,
    docker: &dyn DockerRunner,
    quiet: bool,
) -> DoctorCheck {
    let state_key = read_managed_core_key(docker, &profile.name, &profile.memory_base_url)
        .await
        .unwrap_or(None);
    let info = resolve_local_clients(&profile.memory_base_url, state_key.as_deref(), !quiet);

    match info.provenance {
        KeyProvenance::CoreState | KeyProvenance::ShellOverride => {
            let display = info.core_api_key.unwrap_or_else(|| "****".into());
            DoctorCheck {
                name: "local_client_auth".into(),
                status: "pass".into(),
                message: format!(
                    "local services should use CORE_API_KEY={display} at {}",
                    profile.memory_base_url
                ),
                hint: None,
            }
        }
        KeyProvenance::Unavailable => DoctorCheck {
            name: "local_client_auth".into(),
            status: "warn".into(),
            message: "CORE_API_KEY not available from running Core".into(),
            hint: Some(format!(
                "run `am instance start` or read: docker exec {DEFAULT_CONTAINER_NAME} cat {CORE_STATE_KEY_PATH}"
            )),
        },
    }
}

async fn check_core_profile_label(
    profile: &crate::config::ResolvedProfile,
    docker: &dyn DockerRunner,
) -> DoctorCheck {
    match docker.inspect(DEFAULT_CONTAINER_NAME).await {
        Ok(Some(inspect)) if inspect.managed_by_cli && inspect.state.is_running() => {
            if managed_core_profile_mismatch(&inspect, &profile.name) {
                DoctorCheck {
                    name: "core_profile".into(),
                    status: "warn".into(),
                    message: format!(
                        "Core container profile label {:?} does not match CLI profile '{}'",
                        inspect.profile_label, profile.name
                    ),
                    hint: Some(
                        "Run `am init --project <slug>` or `am instance start --replace` to point Core trace sync at this project".into(),
                    ),
                }
            } else {
                DoctorCheck {
                    name: "core_profile".into(),
                    status: "pass".into(),
                    message: format!("Core container profile matches '{}'", profile.name),
                    hint: None,
                }
            }
        }
        Ok(Some(_)) => DoctorCheck {
            name: "core_profile".into(),
            status: "warn".into(),
            message: "managed Core container is not running".into(),
            hint: Some("run `am instance start`".into()),
        },
        Ok(None) => DoctorCheck {
            name: "core_profile".into(),
            status: "warn".into(),
            message: "no CLI-managed Core container".into(),
            hint: Some("run `am instance start` or `am init --project <slug>`".into()),
        },
        Err(err) => DoctorCheck {
            name: "core_profile".into(),
            status: "warn".into(),
            message: format!("could not inspect Core container: {err}"),
            hint: None,
        },
    }
}

async fn check_recent_trace(global: &GlobalOptions, project_id: &str) -> DoctorCheck {
    let (_profile, dash) = match dashboard_client(global).await {
        Ok(v) => v,
        Err(err) => {
            return DoctorCheck {
                name: "recent_trace".into(),
                status: "warn".into(),
                message: format!("could not query traces: {err}"),
                hint: None,
            };
        }
    };
    match dash.list_traces(project_id, Some(1)).await {
        Ok(traces) => {
            let Some(latest) = traces.first() else {
                return DoctorCheck {
                    name: "recent_trace".into(),
                    status: "warn".into(),
                    message: "no traces ingested yet".into(),
                    hint: Some(
                        "configure Core trace sync (`am connect env --for sync`) and run a memory operation"
                            .into(),
                    ),
                };
            };
            if trace_is_recent(latest.created_at) {
                DoctorCheck {
                    name: "recent_trace".into(),
                    status: "pass".into(),
                    message: format!("latest trace at {}", latest.created_at),
                    hint: None,
                }
            } else {
                DoctorCheck {
                    name: "recent_trace".into(),
                    status: "warn".into(),
                    message: format!("latest trace is stale ({})", latest.created_at),
                    hint: Some(
                        "verify CLOUD_TRACE_SYNC_ENABLED and ATOMICMEMORY_API_KEY on Core".into(),
                    ),
                }
            }
        }
        Err(err) => DoctorCheck {
            name: "recent_trace".into(),
            status: "warn".into(),
            message: err.to_string(),
            hint: None,
        },
    }
}

async fn check_runtime_presence(global: &GlobalOptions, project_id: &str) -> DoctorCheck {
    let (_profile, dash) = match dashboard_client(global).await {
        Ok(v) => v,
        Err(err) => {
            return DoctorCheck {
                name: "runtime_presence".into(),
                status: "warn".into(),
                message: format!("could not query runtimes: {err}"),
                hint: None,
            };
        }
    };
    match dash.list_runtimes(project_id).await {
        Ok(runtimes) if runtimes.is_empty() => DoctorCheck {
            name: "runtime_presence".into(),
            status: "warn".into(),
            message: "no runtimes registered yet".into(),
            hint: Some(
                "Core will register on heartbeat/trace upload once trace sync is configured".into(),
            ),
        },
        Ok(runtimes) => {
            let online = runtimes
                .iter()
                .filter(|r| r.presence == RuntimePresence::Online)
                .count();
            DoctorCheck {
                name: "runtime_presence".into(),
                status: if online > 0 { "pass" } else { "warn" }.into(),
                message: format!("{online}/{} runtime(s) online", runtimes.len()),
                hint: if online == 0 {
                    Some("check Core is running and trace sync/heartbeat is enabled".into())
                } else {
                    None
                },
            }
        }
        Err(err) => DoctorCheck {
            name: "runtime_presence".into(),
            status: "warn".into(),
            message: format!("runtime API unavailable: {err}"),
            hint: Some("upgrade Cloud API or ignore until runtime registry is deployed".into()),
        },
    }
}

fn trace_is_recent(created_at: DateTime<Utc>) -> bool {
    let age = Utc::now().signed_duration_since(created_at);
    age.to_std().is_ok_and(|d| d <= RECENT_TRACE_WINDOW)
}

pub fn render_trace_sync_env(cloud_base_url: &str, api_key: &str, show_secrets: bool) -> String {
    let jwks = jwks_url(cloud_base_url)
        .unwrap_or_else(|_| format!("{cloud_base_url}/.well-known/atomic-core/jwks.json"));
    let secret = if show_secrets {
        api_key.to_string()
    } else {
        redact_secret(api_key)
    };
    format!(
        "# Core → Cloud trace sync\nCLOUD_TRACE_SYNC_ENABLED=true\nATOMICMEMORY_API_URL={cloud_base_url}\nATOMICMEMORY_API_KEY={secret}\nCLOUD_JWKS_URL={jwks}"
    )
}

pub fn next_step_after_link_local() -> String {
    "Next: `am instance start` — run Core (or `am connect env --for sync` if Core already runs)"
        .to_string()
}

pub fn next_step_after_key_create() -> String {
    "Next: `am connect env --for sync` — configure Core trace sync (or `am instance start` for Docker-managed Core)"
        .to_string()
}

pub fn next_step_after_instance_start() -> String {
    "Next: `am connect doctor` — verify Core ↔ Cloud wiring".to_string()
}

pub fn next_step_after_connect_env_sync() -> String {
    "Next: restart Core with these vars, then `am connect doctor`".to_string()
}

pub fn next_step_after_connect_env_clients() -> String {
    "Next: point SDK/apps at this URL + `CORE_API_KEY`".to_string()
}

pub fn next_step_after_doctor_pass() -> String {
    "Next: `am memory search \"…\"` or `am trace list`".to_string()
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::Cli;
    use clap::Parser;

    #[test]
    fn connect_env_defaults_to_sync_audience() {
        let cli = Cli::try_parse_from(["am", "connect", "env"]).unwrap();
        match cli.command {
            crate::cli::Command::Connect(ConnectOptions {
                command:
                    Some(ConnectCommand::Env {
                        r#for,
                        show_secrets,
                    }),
                ..
            }) => {
                assert_eq!(r#for, EnvAudience::Sync);
                assert!(!show_secrets);
            }
            _ => panic!("expected connect env"),
        }
    }

    #[test]
    fn connect_env_accepts_for_clients_and_all() {
        let cli = Cli::try_parse_from(["am", "connect", "env", "--for", "clients"]).unwrap();
        match cli.command {
            crate::cli::Command::Connect(ConnectOptions {
                command: Some(ConnectCommand::Env { r#for, .. }),
                ..
            }) => {
                assert_eq!(r#for, EnvAudience::Clients);
            }
            _ => panic!("expected connect env clients"),
        }
        let cli = Cli::try_parse_from(["am", "connect", "env", "--for", "all"]).unwrap();
        match cli.command {
            crate::cli::Command::Connect(ConnectOptions {
                command: Some(ConnectCommand::Env { r#for, .. }),
                ..
            }) => {
                assert_eq!(r#for, EnvAudience::All);
            }
            _ => panic!("expected connect env all"),
        }
    }

    #[test]
    fn connect_overview_and_hidden_status_parse() {
        let cli = Cli::try_parse_from(["am", "connect", "overview"]).unwrap();
        assert!(matches!(
            cli.command,
            crate::cli::Command::Connect(ConnectOptions {
                command: Some(ConnectCommand::Overview),
                ..
            })
        ));
        let cli = Cli::try_parse_from(["am", "connect", "status"]).unwrap();
        assert!(matches!(
            cli.command,
            crate::cli::Command::Connect(ConnectOptions {
                command: Some(ConnectCommand::Status),
                ..
            })
        ));
    }

    #[test]
    fn connect_project_one_shot_parses() {
        let cli =
            Cli::try_parse_from(["am", "connect", "--project", "my-local", "--device"]).unwrap();
        match cli.command {
            crate::cli::Command::Connect(ConnectOptions {
                project, device, ..
            }) => {
                assert_eq!(project.as_deref(), Some("my-local"));
                assert!(device);
            }
            _ => panic!("expected connect --project"),
        }
    }

    #[test]
    fn render_env_redacts_secret_by_default() {
        let block = render_trace_sync_env(
            "https://api.atomicstrata.ai",
            "amc_test_secret_value",
            false,
        );
        assert!(block.contains("CLOUD_TRACE_SYNC_ENABLED=true"));
        assert!(block.contains("ATOMICMEMORY_API_URL=https://api.atomicstrata.ai"));
        assert!(!block.contains("amc_test_secret_value"));
        assert!(block.contains("amc_…"));
    }

    #[test]
    fn render_env_shows_secret_when_requested() {
        let block =
            render_trace_sync_env("https://api.atomicstrata.ai", "amc_test_secret_value", true);
        assert!(block.contains("amc_test_secret_value"));
    }

    #[test]
    fn render_env_all_includes_both_sections() {
        let sync = render_trace_sync_env("https://api.dev.example.com", "amc_test_key", false);
        let clients = render_client_env_block("http://127.0.0.1:17350", "corekey1234567890", false);
        let all = format!("{sync}\n\n{clients}");
        assert!(all.contains("Core → Cloud trace sync"));
        assert!(all.contains("Local clients → Core"));
    }

    #[test]
    fn local_client_auth_check_passes_with_resolved_key() {
        let info = resolve_local_clients("http://127.0.0.1:17350", Some("abcd1234efgh5678"), true);
        assert_eq!(info.provenance, KeyProvenance::CoreState);
        assert!(info.core_api_key.is_some());
    }
}
