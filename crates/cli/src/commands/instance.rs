//! CLI-managed local Core instance lifecycle (Docker-backed).

use std::io::{self, IsTerminal, Write as _};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use clap::Subcommand;
use reqwest::Url;
use serde::Serialize;

use crate::cli::GlobalOptions;
use crate::commands::client::{memory_client, resolve_ctx};
use crate::commands::cloud_api_key::{ProvisionOutcome, ensure_connected_local_cloud_api_key};
use crate::commands::connect::next_step_after_instance_start;
use crate::commands::local_clients::{render_local_clients_card, resolve_local_clients};
use crate::config::{
    ENV_CORE_IMAGE, OpenAiKeySource, ProfileKind, clear_openai_api_key, jwks_url, load_config,
    require_project_id, resolve_core_api_key, resolve_openai_api_key,
    resolve_openai_api_key_with_source, store_openai_api_key,
};
use crate::environment::{CoreImageInput, resolve_core_image};
use crate::instance::docker::{
    ContainerInspect, ContainerState, DEFAULT_BIND_HOST, DEFAULT_HOST_PORT, DockerRunner,
    InstanceEnv, RealDockerRunner, default_instance_config, managed_core_local_url, tail_lines,
};
use crate::instance::{
    DEFAULT_CONTAINER_NAME, DEFAULT_WAIT_SECS, HEALTH_POLL_INTERVAL_SECS, MAX_FAILURE_LOG_LINES,
    VOLUME_DATA, VOLUME_STATE, managed_core_cloud_env_mismatch, managed_core_profile_mismatch,
    resolve_instance_core_api_key,
};
use crate::output::{emit, message};
use crate::progress::{ProgressReporter, progress_for};
use crate::validation::{is_repromptable_openai_key_error, validate_openai_api_key};

#[derive(Debug, Subcommand)]
pub enum InstanceCommand {
    /// Start the local Core Docker container (idempotent)
    Start {
        /// Container image (default: derived from active Cloud environment)
        #[arg(long, env = "ATOMICMEMORY_CORE_IMAGE")]
        image: Option<String>,
        /// OpenAI API key for Core (overrides env and stored profile secret)
        #[arg(long, env = "OPENAI_API_KEY")]
        openai_api_key: Option<String>,
        /// Recreate an existing CLI-managed container
        #[arg(long)]
        replace: bool,
        /// Seconds to wait for Core health after start
        #[arg(long, default_value_t = DEFAULT_WAIT_SECS)]
        wait_secs: u64,
        /// Show raw `CORE_API_KEY` in output (default: redacted)
        #[arg(long)]
        show_secrets: bool,
    },
    /// Stop the managed Core container
    Stop,
    /// Restart the managed Core container
    Restart {
        #[arg(long, default_value_t = DEFAULT_WAIT_SECS)]
        wait_secs: u64,
    },
    /// Show container, Core health, and local client credentials
    Status {
        /// Show raw `CORE_API_KEY` in output (default: redacted)
        #[arg(long)]
        show_secrets: bool,
    },
    /// Tail container logs
    Logs {
        #[arg(short, long)]
        follow: bool,
        #[arg(long, default_value_t = 100)]
        tail: u32,
    },
    /// Remove the managed container (volumes preserved unless --purge-data)
    Remove {
        /// Also delete named data volumes (requires --yes)
        #[arg(long)]
        purge_data: bool,
        /// Confirm destructive volume deletion
        #[arg(long)]
        yes: bool,
    },
}

pub async fn run(cmd: InstanceCommand, global: &GlobalOptions) -> Result<()> {
    let docker: Arc<dyn DockerRunner> = Arc::new(RealDockerRunner::new());
    match cmd {
        InstanceCommand::Start {
            image,
            openai_api_key,
            replace,
            wait_secs,
            show_secrets,
        } => {
            let mut progress = progress_for(global);
            let result = run_start(
                global,
                docker.as_ref(),
                StartOptions {
                    image,
                    openai_api_key,
                    replace,
                    sync_managed: false,
                    wait_secs,
                    show_secrets,
                    brief_output: false,
                    progress: Some(progress.as_mut()),
                    brief_progress_id: None,
                    allow_prompts: global.allow_prompts(false),
                },
            )
            .await
            .map(|_| ());
            progress.finish();
            result
        }
        InstanceCommand::Stop => run_stop(global, docker.as_ref()).await,
        InstanceCommand::Restart { wait_secs } => {
            run_restart(global, docker.as_ref(), wait_secs).await
        }
        InstanceCommand::Status { show_secrets } => {
            run_status(global, docker.as_ref(), show_secrets).await
        }
        InstanceCommand::Logs { follow, tail } => {
            run_logs(global, docker.as_ref(), follow, tail).await
        }
        InstanceCommand::Remove { purge_data, yes } => {
            run_remove(global, docker.as_ref(), purge_data, yes).await
        }
    }
}

/// Start Core during `am init` — progress on stderr, no JSON status blob.
pub(crate) async fn run_start_brief<'a>(
    global: &GlobalOptions,
    cmd: InstanceCommand,
    // INTERNAL recreate requirement, passed separately so it can never be
    // mistaken for the operator's `--replace` authority downstream.
    sync_managed: bool,
    progress: Option<&'a mut dyn ProgressReporter>,
    brief_progress_id: Option<&'a str>,
    // When false, OpenAI key stdin prompts are skipped (`am init --yes`).
    allow_prompts: bool,
) -> Result<bool> {
    let InstanceCommand::Start {
        image,
        openai_api_key,
        replace,
        wait_secs,
        show_secrets,
    } = cmd
    else {
        anyhow::bail!("run_start_brief expects InstanceCommand::Start");
    };
    let docker: Arc<dyn DockerRunner> = Arc::new(RealDockerRunner::new());
    run_start(
        global,
        docker.as_ref(),
        StartOptions {
            image,
            openai_api_key,
            replace,
            sync_managed,
            wait_secs,
            show_secrets,
            brief_output: true,
            progress,
            brief_progress_id,
            allow_prompts,
        },
    )
    .await
}

async fn ensure_local_profile(global: &GlobalOptions) -> Result<crate::config::ResolvedProfile> {
    let profile = resolve_ctx(global).await?;
    if profile.kind != ProfileKind::Local {
        bail!(
            "instance commands require a local profile — run `am link local` or `am config profile add --kind local`"
        );
    }
    require_project_id(&profile, None)?;
    Ok(profile)
}

fn read_openai_api_key_from_prompt(reason: &str) -> Result<String> {
    eprintln!("{reason}");
    eprint!("Paste OPENAI_API_KEY (input hidden): ");
    io::stderr().flush().ok();
    let key = rpassword::read_password().context("read OPENAI_API_KEY")?;
    if key.trim().is_empty() {
        bail!(
            "OPENAI_API_KEY is required — enter a non-empty key at the prompt or set OPENAI_API_KEY in the environment"
        );
    }
    Ok(key.trim().to_string())
}

async fn ensure_openai_api_key(
    profile_name: &str,
    flag_override: Option<String>,
    interactive: bool,
) -> Result<String> {
    let can_prompt = interactive && io::stdin().is_terminal();
    let mut candidate = flag_override
        .filter(|s| !s.is_empty())
        .map(|key| (key, OpenAiKeySource::Flag))
        .or_else(|| resolve_openai_api_key_with_source(profile_name));

    if candidate.is_none() {
        if !can_prompt {
            bail!(
                "OPENAI_API_KEY is required to start Core — set OPENAI_API_KEY in the environment or run interactively"
            );
        }
        candidate = Some((
            read_openai_api_key_from_prompt(
                "OpenAI API key required to start Core (stored in credentials.toml, mode 0600).",
            )?,
            OpenAiKeySource::Prompted,
        ));
    }

    // Allow a couple of fresh pastes after 401/403/format failures on TTY.
    const MAX_REPROMPTS: u8 = 2;
    let mut reprompts = 0u8;
    loop {
        let (key, source) = candidate.clone().expect("openai key candidate must be set");
        message(can_prompt, "Validating OpenAI API key with api.openai.com…");
        match validate_openai_api_key(&key).await {
            Ok(()) => {
                // A flag or environment value is an override for this run only.
                // Persisting it wrote a CI secret to disk without asking.
                if source.should_persist() {
                    store_openai_api_key(profile_name, &key)?;
                    message(
                        can_prompt,
                        "OpenAI API key saved for this profile (not printed).",
                    );
                }
                return Ok(key);
            }
            Err(err)
                if can_prompt
                    && is_repromptable_openai_key_error(&err)
                    && reprompts < MAX_REPROMPTS =>
            {
                reprompts += 1;
                // Clear only the credential that was actually rejected. The old
                // guard asked whether *any* key resolved, so an exported
                // OPENAI_API_KEY made a bad flag delete the stored key.
                if source.should_clear_stored() {
                    clear_openai_api_key(profile_name)?;
                }
                let head = err
                    .to_string()
                    .lines()
                    .next()
                    .unwrap_or("OpenAI rejected the key")
                    .to_string();
                candidate = Some((
                    read_openai_api_key_from_prompt(&format!(
                        "{head}\nEnter a fresh key to continue (stored in credentials.toml, mode 0600)."
                    ))?,
                    OpenAiKeySource::Prompted,
                ));
            }
            Err(err) => return Err(err),
        }
    }
}

/// True when ensure_openai_api_key may read stdin (missing key or rejectable stored/env key).
fn may_prompt_openai_key(interactive: bool) -> bool {
    interactive && io::stdin().is_terminal()
}

fn may_prompt_for_input(allow_prompts: bool) -> bool {
    allow_prompts && io::stdin().is_terminal()
}

fn needs_interactive_openai_key(
    profile_name: &str,
    flag_override: &Option<String>,
    interactive: bool,
) -> bool {
    interactive
        && io::stdin().is_terminal()
        && flag_override.as_ref().is_none_or(|s| s.is_empty())
        && std::env::var("OPENAI_API_KEY").is_err()
        && resolve_openai_api_key(profile_name).is_none()
}

/// Which replacement actions a run is permitted to take.
///
/// Two unrelated things used to share one boolean. `opts.replace` is the
/// OPERATOR's authority to replace a container, including one this CLI does not
/// manage. A created or rotated Cloud key is an INTERNAL requirement to recreate
/// OUR OWN container so it picks up the new credential. Assigning the second
/// into the first meant a routine key rotation force-removed an unrelated
/// container named `atomic-memory`, because the foreign-container branch reads
/// that flag as consent.
///
/// Internal state may require recreating what we own. It must never authorise
/// destroying what we do not.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ReplacementPlan {
    /// Recreate the CLI-managed container (operator asked, or credentials moved).
    recreate_managed: bool,
    /// Force-remove a container this CLI did not create. Operator authority only.
    may_replace_foreign: bool,
}

impl ReplacementPlan {
    fn resolve(
        operator_replace: bool,
        needs_credential_sync: bool,
        confirmed_managed_recreate: bool,
    ) -> Self {
        Self {
            recreate_managed: operator_replace
                || needs_credential_sync
                || confirmed_managed_recreate,
            may_replace_foreign: operator_replace,
        }
    }
}

fn confirm_replace_foreign_container(
    container_name: &str,
    replace_flag: bool,
    allow_prompts: bool,
) -> Result<bool> {
    if replace_flag {
        return Ok(true);
    }
    if !allow_prompts || !io::stdin().is_terminal() {
        bail!(
            "container '{container_name}' exists but was not created by `am instance` (likely a manual docker run).\n\
             Remove it: docker rm -f {container_name}\n\
             Or recreate via CLI: am instance start --replace"
        );
    }
    eprint!(
        "Container '{container_name}' exists (not CLI-managed). Replace it? [y/N] (--replace): "
    );
    io::stderr().flush().ok();
    let mut line = String::new();
    io::stdin()
        .read_line(&mut line)
        .context("read confirmation")?;
    Ok(matches!(line.trim().to_lowercase().as_str(), "y" | "yes"))
}

/// Interactive consent to recreate a CLI-managed Core that no longer matches the active profile.
fn confirm_recreate_mismatched_managed_container(
    container_name: &str,
    profile_name: &str,
    allow_prompts: bool,
) -> Result<bool> {
    if !allow_prompts || !io::stdin().is_terminal() {
        bail!(
            "Core container profile or Cloud env does not match active CLI profile '{profile_name}' — run `am instance start --replace`"
        );
    }
    eprint!(
        "Core container '{container_name}' does not match profile '{profile_name}' (profile/Cloud env).\n\
         Recreate it for this profile? [y/N] (--replace): "
    );
    io::stderr().flush().ok();
    let mut line = String::new();
    io::stdin()
        .read_line(&mut line)
        .context("read recreate confirmation")?;
    Ok(matches!(line.trim().to_lowercase().as_str(), "y" | "yes"))
}

async fn ensure_cloud_api_key(
    global: &GlobalOptions,
    profile: &crate::config::ResolvedProfile,
) -> Result<(String, ProvisionOutcome)> {
    ensure_connected_local_cloud_api_key(global, profile).await
}

fn build_instance_env(
    profile: &crate::config::ResolvedProfile,
    api_key: &str,
    openai_api_key: &str,
    core_api_key: String,
) -> Result<InstanceEnv> {
    let jwks = jwks_url(&profile.base_url)?;
    Ok(InstanceEnv {
        openai_api_key: openai_api_key.to_string(),
        atomicmemory_api_key: api_key.to_string(),
        atomicmemory_api_url: profile.base_url.clone(),
        cloud_jwks_url: jwks,
        core_api_key: Some(core_api_key),
    })
}

async fn ensure_core_key_override_allowed(
    docker: &dyn DockerRunner,
    container_name: &str,
    shell_override: Option<&str>,
    replace: bool,
) -> Result<()> {
    let Some(shell_key) = shell_override.filter(|k| !k.is_empty()) else {
        return Ok(());
    };
    let inspect = docker.inspect(container_name).await?;
    let Some(inspect) = inspect else {
        return Ok(());
    };
    if !inspect.managed_by_cli || !inspect.state.is_running() {
        return Ok(());
    }
    if let Some(persisted) = docker.read_core_api_key(container_name).await?
        && persisted != shell_key
        && !replace
    {
        bail!(
            "CORE_API_KEY override differs from the running container's persisted key.\n\
             Recreate with override: CORE_API_KEY=<secret> am instance start --replace"
        );
    }
    Ok(())
}

fn format_auth_chain_diag(cloud_base_url: &str, detail: &str) -> String {
    format!(
        "Core HTTP is up (401 on unauthenticated health) — verifying auth chain ({detail}). Cloud tier={cloud_base_url}"
    )
}

async fn core_health_probe(
    global: &GlobalOptions,
    docker: &dyn DockerRunner,
    container_name: &str,
    local_url: &Url,
    bootstrap_core_key: Option<&str>,
) -> Result<()> {
    if let Some(key) = bootstrap_core_key.filter(|k| !k.is_empty()) {
        let client = am_cloud_client::MemoryClient::new(local_url.clone(), key.to_string())
            .context("create bootstrap core memory client")?;
        client.health().await.context("bootstrap core health")?;
    } else if let Some(key) = docker.read_core_api_key(container_name).await? {
        let client = am_cloud_client::MemoryClient::new(local_url.clone(), key)
            .context("create persisted core memory client")?;
        client.health().await.context("persisted core health")?;
    } else if let Some(inspect) = docker.inspect(container_name).await?
        && let Some(key) = inspect.core_api_key
    {
        let client = am_cloud_client::MemoryClient::new(local_url.clone(), key)
            .context("create inspect core memory client")?;
        client.health().await.context("inspect env core health")?;
    } else {
        let (_p, client) = memory_client(global).await?;
        client.health().await.context("memory client core health")?;
    }
    Ok(())
}

struct CoreHealthWaitContext<'a> {
    global: &'a GlobalOptions,
    docker: &'a dyn DockerRunner,
    container_name: &'a str,
    /// Cloud base URL for the auth-chain DIAGNOSTIC only. Never probed and
    /// never sent a credential; the probe URL is derived below.
    cloud_base_url_for_diag: &'a str,
    timeout: Duration,
    emit_plain_ticks: bool,
    bootstrap_core_key: Option<&'a str>,
    brief_parent: Option<&'a str>,
}

/// Keep the failure from the deepest startup stage ever reached, and within a
/// stage the most recent message.
///
/// Stages: 0 = port closed, 1 = HTTP reachable but unhealthy, 2 = authenticated
/// health failed. A container that is still booting reports stage 0 on the
/// first poll every single time, so preferring the *earliest* failure pinned
/// every timeout to "port not accepting connections yet" and threw away the
/// stage-2 auth diagnosis that says what is actually wrong. Preferring the
/// latest failure instead was the original bug: the unconditional stage-2 probe
/// overwrote a genuine stage-0 result. Deepest-stage-wins is correct for both:
/// it reports how far startup got before it stopped.
fn record_deepest_health_failure(
    deepest: &mut Option<(u8, String)>,
    priority: u8,
    message: String,
) {
    let replace = deepest
        .as_ref()
        .map(|(existing, _)| priority >= *existing)
        .unwrap_or(true);
    if replace {
        *deepest = Some((priority, message));
    }
}

async fn wait_for_core_health(
    ctx: CoreHealthWaitContext<'_>,
    progress: &mut Option<&mut dyn ProgressReporter>,
) -> Result<()> {
    let CoreHealthWaitContext {
        global,
        docker,
        container_name,
        cloud_base_url_for_diag,
        timeout,
        emit_plain_ticks,
        bootstrap_core_key,
        brief_parent,
    } = ctx;
    // Probe what we PUBLISHED, never what the profile claims. This function
    // sends the bootstrap Core key as a bearer to whatever URL it probes, and
    // `profile.memory_base_url` derives from the Cloud API's
    // `project.local_url` - so parsing it here handed the key to any host a
    // project record named, on every default `am instance start`, bypassing
    // the container-label guard entirely (that guard runs on the read path,
    // not on this probe). No profile parameter, so it cannot come back.
    let local_url = managed_core_local_url()
        .parse::<Url>()
        .context("parse derived local_url for health check")?;
    let host_port = DEFAULT_HOST_PORT;
    let host = DEFAULT_BIND_HOST;

    let deadline = tokio::time::Instant::now() + timeout;
    let mut last_progress = tokio::time::Instant::now() - Duration::from_secs(10);
    let mut deepest_failure: Option<(u8, String)> = None;

    loop {
        if let Some(inspect) = docker.inspect(container_name).await?
            && matches!(inspect.state, ContainerState::Exited)
        {
            let logs = docker
                .logs_tail(container_name, 30)
                .await
                .unwrap_or_default();
            bail!(
                "Core container exited before becoming healthy.\n\
                 Recent logs:\n{}\n\
                 Try: am instance logs --tail 50",
                tail_lines(&logs, MAX_FAILURE_LOG_LINES)
            );
        }

        let port_open = tokio::net::TcpStream::connect((host, host_port))
            .await
            .is_ok();

        let mut current_diag = if !port_open {
            let message = format!("port {host}:{host_port} not accepting connections yet");
            record_deepest_health_failure(&mut deepest_failure, 0, message.clone());
            message
        } else if let Ok(resp) = reqwest::Client::new()
            .get(
                local_url
                    .join("v1/memories/health")
                    .unwrap_or(local_url.clone()),
            )
            .timeout(Duration::from_secs(3))
            .send()
            .await
        {
            if resp.status().is_success() {
                return Ok(());
            }
            if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
                "Core HTTP is up (401 on unauthenticated health) — verifying auth chain".to_string()
            } else {
                let message = format!("Core returned HTTP {}", resp.status());
                record_deepest_health_failure(&mut deepest_failure, 1, message.clone());
                message
            }
        } else {
            let message = "Core port open but HTTP health probe failed".to_string();
            record_deepest_health_failure(&mut deepest_failure, 1, message.clone());
            message
        };

        if port_open {
            match core_health_probe(
                global,
                docker,
                container_name,
                &local_url,
                bootstrap_core_key,
            )
            .await
            {
                Ok(()) => return Ok(()),
                Err(err) => {
                    let message = format_auth_chain_diag(
                        cloud_base_url_for_diag,
                        &format!("authenticated health failed: {err}"),
                    );
                    current_diag = message.clone();
                    record_deepest_health_failure(&mut deepest_failure, 2, message);
                }
            }
        }

        if tokio::time::Instant::now() >= deadline {
            let timeout_diag = deepest_failure
                .map(|(_, message)| message)
                .unwrap_or(current_diag);
            bail!(
                concat!(
                    "Core health check timed out after {}s — last status: {}\n",
                    "Diagnostics:\n",
                    "• am instance status\n",
                    "• am instance logs --tail 50\n",
                    "• am connect doctor\n",
                    "• If you switched Cloud tiers (dev ↔ staging): am --base-url <tier> key create --save\n",
                    "  then: am --base-url <tier> instance start --replace"
                ),
                timeout.as_secs(),
                timeout_diag
            );
        }

        if last_progress.elapsed() >= Duration::from_secs(8) {
            let elapsed = timeout.as_secs().saturating_sub(
                deadline
                    .saturating_duration_since(tokio::time::Instant::now())
                    .as_secs(),
            );
            let progress_diag = current_diag.as_str();
            if brief_parent.is_some() {
                progress_tick(
                    progress,
                    brief_parent,
                    "health",
                    &format!(
                        "waiting for Core ({elapsed}s/{}) — {progress_diag}",
                        timeout.as_secs()
                    ),
                );
            } else if emit_plain_ticks {
                message(
                    true,
                    &format!(
                        "Waiting for Core ({elapsed}s/{}) — {progress_diag}",
                        timeout.as_secs()
                    ),
                );
            }
            last_progress = tokio::time::Instant::now();
        }

        tokio::time::sleep(Duration::from_secs(HEALTH_POLL_INTERVAL_SECS)).await;
    }
}

struct StartOptions<'a> {
    /// INTERNAL requirement to recreate our own container (credentials or env
    /// moved). Never operator authority: it must not reach the
    /// foreign-container branch. Kept separate from `replace` all the way down
    /// the call chain, because collapsing the two upstream reintroduces the
    /// defect regardless of how carefully `run_start` separates them.
    sync_managed: bool,
    image: Option<String>,
    openai_api_key: Option<String>,
    replace: bool,
    wait_secs: u64,
    show_secrets: bool,
    brief_output: bool,
    progress: Option<&'a mut dyn ProgressReporter>,
    /// During init (`brief_output`), tick this parent step instead of nested steps.
    brief_progress_id: Option<&'a str>,
    // When false, OpenAI key stdin prompts are skipped (`am init --yes`).
    allow_prompts: bool,
}

/// Routes instance-start progress to nested steps or init parent ticks.
fn progress_step(
    progress: &mut Option<&mut dyn ProgressReporter>,
    brief_parent: Option<&str>,
    id: &str,
    label: &str,
    brief_detail: &str,
) {
    if let Some(p) = progress.as_deref_mut() {
        if let Some(parent) = brief_parent {
            p.tick(parent, brief_detail);
        } else {
            p.start_step(id, label);
        }
    }
}

fn progress_tick(
    progress: &mut Option<&mut dyn ProgressReporter>,
    brief_parent: Option<&str>,
    id: &str,
    detail: &str,
) {
    if let Some(p) = progress.as_deref_mut() {
        let step = brief_parent.unwrap_or(id);
        p.tick(step, detail);
    }
}

fn progress_succeed(
    progress: &mut Option<&mut dyn ProgressReporter>,
    brief_parent: Option<&str>,
    id: &str,
    detail: Option<&str>,
) {
    if let Some(parent) = brief_parent {
        if let Some(d) = detail.filter(|s| !s.is_empty())
            && let Some(p) = progress.as_deref_mut()
        {
            p.tick(parent, d);
        }
    } else if let Some(p) = progress.as_deref_mut() {
        p.succeed(id, detail);
    }
}

fn progress_warn(
    progress: &mut Option<&mut dyn ProgressReporter>,
    brief_parent: Option<&str>,
    id: &str,
    detail: Option<&str>,
) {
    if let Some(p) = progress.as_deref_mut() {
        let target = brief_parent.unwrap_or(id);
        p.warn(target, detail);
    }
}

fn progress_fail(
    progress: &mut Option<&mut dyn ProgressReporter>,
    brief_parent: Option<&str>,
    id: &str,
    detail: Option<&str>,
) {
    if let Some(p) = progress.as_deref_mut() {
        let target = brief_parent.unwrap_or(id);
        p.fail(target, detail);
    }
}

fn progress_pause(progress: &mut Option<&mut dyn ProgressReporter>) {
    if let Some(p) = progress.as_deref_mut() {
        p.pause_for_input();
    }
}

fn progress_resume(progress: &mut Option<&mut dyn ProgressReporter>) {
    if let Some(p) = progress.as_deref_mut() {
        p.resume_after_input();
    }
}

fn with_progress_paused_for_input<T>(
    progress: &mut Option<&mut dyn ProgressReporter>,
    should_pause: bool,
    op: impl FnOnce() -> T,
) -> T {
    if should_pause {
        progress_pause(progress);
    }
    let result = op();
    if should_pause {
        progress_resume(progress);
    }
    result
}

fn progress_is_active(progress: &Option<&mut dyn ProgressReporter>) -> bool {
    progress.is_some()
}

/// Whether an existing managed container must not be reused as-is.
///
/// Deliberately independent of container state: a stopped container carries
/// the same baked-in profile label and Cloud env as a running one, and the
/// `Some(_)` arm of the start match issues a plain `docker start` on it. Gating
/// this check on `state.is_running()` let an exited container from another
/// profile be started unchanged, serving that profile's credentials and JWKS
/// under the active profile's name.
fn existing_container_blocks_start(
    inspect: &ContainerInspect,
    profile_name: &str,
    expected_api_url: &str,
    expected_jwks_url: &str,
    replace: bool,
) -> bool {
    if replace || !inspect.managed_by_cli {
        return false;
    }
    managed_core_profile_mismatch(inspect, profile_name)
        || managed_core_cloud_env_mismatch(inspect, expected_api_url, expected_jwks_url)
}

async fn run_start(
    global: &GlobalOptions,
    docker: &dyn DockerRunner,
    mut opts: StartOptions<'_>,
) -> Result<bool> {
    progress_step(
        &mut opts.progress,
        opts.brief_progress_id,
        "credentials",
        "Resolve instance credentials",
        "resolve credentials",
    );
    let profile = ensure_local_profile(global).await?;
    docker.version().await?;

    let config_file = load_config()?;
    let env_image = std::env::var(ENV_CORE_IMAGE).ok();
    let resolved_image = resolve_core_image(&CoreImageInput {
        image_override: opts.image.as_deref().or(env_image.as_deref()),
        config_core_image: config_file.core_image.as_deref(),
    })
    .value;
    let config = default_instance_config(&profile.name, &resolved_image);
    let expected_jwks = jwks_url(&profile.base_url)?;

    let existing = docker.inspect(&config.container_name).await?;
    let mut confirmed_managed_recreate = false;
    if let Some(inspect) = &existing
        && existing_container_blocks_start(
            inspect,
            &profile.name,
            &profile.base_url,
            &expected_jwks,
            opts.replace,
        )
    {
        let may_prompt = may_prompt_for_input(opts.allow_prompts);
        let confirmed = with_progress_paused_for_input(&mut opts.progress, may_prompt, || {
            confirm_recreate_mismatched_managed_container(
                &config.container_name,
                &profile.name,
                opts.allow_prompts,
            )
        })?;
        if !confirmed {
            bail!(
                "leaving Core container unchanged — recreate later with `am instance start --replace`"
            );
        }
        confirmed_managed_recreate = true;
        progress_tick(
            &mut opts.progress,
            opts.brief_progress_id,
            "credentials",
            "recreate approved for profile mismatch",
        );
    }

    let missing_key =
        needs_interactive_openai_key(&profile.name, &opts.openai_api_key, opts.allow_prompts);
    let pause_for_openai = may_prompt_openai_key(opts.allow_prompts) && missing_key;
    if pause_for_openai {
        progress_pause(&mut opts.progress);
        progress_tick(
            &mut opts.progress,
            opts.brief_progress_id,
            "credentials",
            "OpenAI API key required below",
        );
    }
    progress_tick(
        &mut opts.progress,
        opts.brief_progress_id,
        "credentials",
        "validating OpenAI key",
    );
    let openai_key =
        ensure_openai_api_key(&profile.name, opts.openai_api_key, opts.allow_prompts).await;
    if pause_for_openai {
        progress_resume(&mut opts.progress);
    }
    let openai_key = openai_key?;

    let shell_override = resolve_core_api_key();
    ensure_core_key_override_allowed(
        docker,
        &config.container_name,
        shell_override.as_deref(),
        opts.replace,
    )
    .await?;

    progress_tick(
        &mut opts.progress,
        opts.brief_progress_id,
        "credentials",
        "Cloud API key",
    );
    let (api_key, cloud_key_outcome) = ensure_cloud_api_key(global, &profile).await?;

    let existing_for_drift = docker.inspect(&config.container_name).await?;
    // Derive the sync requirement from OBSERVED state, not only from what this
    // run happened to do. `requires_container_sync()` lives in memory: if a
    // rotation stored a new key and the process died before Docker recreation,
    // the next run probed the newly stored key, saw it work, reported `Reused`,
    // and left the container holding the invalidated one - healthy-looking and
    // permanently broken, with re-running unable to repair it.
    let credentials_drifted = existing_for_drift
        .as_ref()
        .filter(|inspect| inspect.managed_by_cli)
        .is_some_and(|inspect| inspect.atomicmemory_api_key.as_deref() != Some(api_key.as_str()));

    let plan = ReplacementPlan::resolve(
        opts.replace,
        opts.sync_managed || cloud_key_outcome.requires_container_sync() || credentials_drifted,
        confirmed_managed_recreate,
    );
    let needs_recreate = plan.recreate_managed;
    let core_api_key = resolve_instance_core_api_key(docker, false).await?;
    let env = build_instance_env(&profile, &api_key, &openai_key, core_api_key.clone())?;
    progress_succeed(
        &mut opts.progress,
        opts.brief_progress_id,
        "credentials",
        Some("ready"),
    );
    progress_step(
        &mut opts.progress,
        opts.brief_progress_id,
        "container",
        "Create or start container",
        "create or start container",
    );

    let existing = docker.inspect(&config.container_name).await?;

    match &existing {
        Some(inspect) if !inspect.managed_by_cli => {
            let may_prompt_foreign =
                may_prompt_for_input(opts.allow_prompts) && !plan.may_replace_foreign;
            let should_replace =
                with_progress_paused_for_input(&mut opts.progress, may_prompt_foreign, || {
                    confirm_replace_foreign_container(
                        &config.container_name,
                        plan.may_replace_foreign,
                        opts.allow_prompts,
                    )
                })?;
            if should_replace {
                docker.rm_force(&config.container_name).await?;
                docker.run(&config, &env).await?;
                if progress_is_active(&opts.progress) {
                    progress_succeed(
                        &mut opts.progress,
                        opts.brief_progress_id,
                        "container",
                        Some("replaced foreign container"),
                    );
                } else {
                    message(
                        !global.quiet,
                        "Removed prior container (not CLI-managed) and started a managed instance.",
                    );
                }
            } else {
                if progress_is_active(&opts.progress) {
                    progress_warn(
                        &mut opts.progress,
                        opts.brief_progress_id,
                        "container",
                        Some("left unchanged"),
                    );
                } else {
                    message(!global.quiet, "Leaving existing container unchanged.");
                }
                return Ok(false);
            }
        }
        Some(inspect) if inspect.state.is_running() && !needs_recreate => {
            if opts.brief_output {
                if progress_is_active(&opts.progress) {
                    progress_succeed(
                        &mut opts.progress,
                        opts.brief_progress_id,
                        "container",
                        Some("already running"),
                    );
                } else {
                    message(
                        !global.quiet,
                        &format!("Core already running at {}", profile.memory_base_url),
                    );
                }
                return Ok(true);
            }
            let report =
                instance_status_report(&profile, Some(inspect), docker, global, opts.show_secrets)
                    .await?;
            emit_instance_report(global, &report, opts.show_secrets)?;
            if progress_is_active(&opts.progress) {
                progress_succeed(
                    &mut opts.progress,
                    opts.brief_progress_id,
                    "container",
                    Some("already running"),
                );
            } else {
                message(!global.quiet, "Instance already running.");
            }
            return Ok(true);
        }
        Some(_) if needs_recreate => {
            docker.rm_force(&config.container_name).await?;
            docker.run(&config, &env).await?;
            if progress_is_active(&opts.progress) {
                progress_succeed(
                    &mut opts.progress,
                    opts.brief_progress_id,
                    "container",
                    Some("recreated"),
                );
            } else {
                message(!global.quiet, "Recreated managed container.");
            }
        }
        Some(_) => {
            docker.start(&config.container_name).await?;
            if progress_is_active(&opts.progress) {
                progress_succeed(
                    &mut opts.progress,
                    opts.brief_progress_id,
                    "container",
                    Some("started existing"),
                );
            } else {
                message(!global.quiet, "Started existing managed container.");
            }
        }
        None => {
            docker.run(&config, &env).await?;
            if progress_is_active(&opts.progress) {
                progress_succeed(
                    &mut opts.progress,
                    opts.brief_progress_id,
                    "container",
                    Some("started new"),
                );
            } else {
                message(!global.quiet, "Started new managed container.");
            }
        }
    }

    if opts.wait_secs > 0 {
        progress_step(
            &mut opts.progress,
            opts.brief_progress_id,
            "health",
            "Wait until Core healthy",
            "wait until Core healthy",
        );
        // Wizard spinner keeps ticking; plain/brief emit periodic messages.
        let emit_plain_ticks = !progress_is_active(&opts.progress) && !global.quiet;
        let health = wait_for_core_health(
            CoreHealthWaitContext {
                global,
                docker,
                container_name: &config.container_name,
                cloud_base_url_for_diag: &profile.base_url,
                timeout: Duration::from_secs(opts.wait_secs),
                emit_plain_ticks,
                bootstrap_core_key: Some(core_api_key.as_str()),
                brief_parent: opts.brief_progress_id,
            },
            &mut opts.progress,
        )
        .await;
        match health {
            Ok(()) => {
                if progress_is_active(&opts.progress) {
                    progress_succeed(
                        &mut opts.progress,
                        opts.brief_progress_id,
                        "health",
                        Some("healthy"),
                    );
                } else if !opts.brief_output {
                    message(!global.quiet, "Core is healthy.");
                }
            }
            Err(err) => {
                if progress_is_active(&opts.progress) {
                    progress_fail(
                        &mut opts.progress,
                        opts.brief_progress_id,
                        "health",
                        Some(&err.to_string()),
                    );
                }
                if let Ok(logs) = docker.logs_tail(&config.container_name, 20).await {
                    message(
                        !global.quiet,
                        &format!("Recent logs:\n{}", tail_lines(&logs, MAX_FAILURE_LOG_LINES)),
                    );
                }
                return Err(err);
            }
        }
    }

    if !opts.brief_output {
        let inspect = docker.inspect(&config.container_name).await?;
        let report = instance_status_report(
            &profile,
            inspect.as_ref(),
            docker,
            global,
            opts.show_secrets,
        )
        .await?;
        emit_instance_report(global, &report, opts.show_secrets)?;
        message(!global.quiet, &next_step_after_instance_start());
    }
    Ok(true)
}

async fn run_stop(global: &GlobalOptions, docker: &dyn DockerRunner) -> Result<()> {
    let profile = ensure_local_profile(global).await?;
    docker.version().await?;
    let name = DEFAULT_CONTAINER_NAME;
    if let Some(inspect) = docker.inspect(name).await? {
        if !inspect.managed_by_cli {
            bail!("container '{name}' is not managed by `am instance`");
        }
        docker.stop(name).await?;
        message(!global.quiet, "Instance stopped.");
    } else {
        message(!global.quiet, "No managed instance found.");
    }
    let report = instance_status_report(
        &profile,
        docker.inspect(name).await?.as_ref(),
        docker,
        global,
        false,
    )
    .await?;
    emit_instance_report(global, &report, false)
}

async fn run_restart(
    global: &GlobalOptions,
    docker: &dyn DockerRunner,
    wait_secs: u64,
) -> Result<()> {
    let profile = ensure_local_profile(global).await?;
    docker.version().await?;
    let name = DEFAULT_CONTAINER_NAME;
    let inspect = docker.inspect(name).await?;
    match inspect {
        Some(i) if i.managed_by_cli => {
            docker.stop(name).await?;
            docker.start(name).await?;
            message(!global.quiet, "Instance restarted.");
        }
        Some(_) => bail!("container '{name}' is not managed by `am instance`"),
        None => bail!("no managed instance '{name}' — run `am instance start`"),
    }
    if wait_secs > 0 {
        let mut progress: Option<&mut dyn ProgressReporter> = None;
        wait_for_core_health(
            CoreHealthWaitContext {
                global,
                docker,
                container_name: name,
                cloud_base_url_for_diag: &profile.base_url,
                timeout: Duration::from_secs(wait_secs),
                emit_plain_ticks: !global.quiet,
                bootstrap_core_key: None,
                brief_parent: None,
            },
            &mut progress,
        )
        .await?;
        message(!global.quiet, "Core is healthy.");
    }
    let report = instance_status_report(
        &profile,
        docker.inspect(name).await?.as_ref(),
        docker,
        global,
        false,
    )
    .await?;
    emit_instance_report(global, &report, false)
}

async fn run_status(
    global: &GlobalOptions,
    docker: &dyn DockerRunner,
    show_secrets: bool,
) -> Result<()> {
    let profile = ensure_local_profile(global).await?;
    docker.version().await?;
    let inspect = docker.inspect(DEFAULT_CONTAINER_NAME).await?;
    let report =
        instance_status_report(&profile, inspect.as_ref(), docker, global, show_secrets).await?;
    emit_instance_report(global, &report, show_secrets)
}

async fn run_logs(
    global: &GlobalOptions,
    docker: &dyn DockerRunner,
    follow: bool,
    tail: u32,
) -> Result<()> {
    let _profile = ensure_local_profile(global).await?;
    docker.version().await?;
    let name = DEFAULT_CONTAINER_NAME;
    if docker.inspect(name).await?.is_none() {
        bail!("no container '{name}' — run `am instance start`");
    }
    if follow {
        docker.logs_follow(name, tail).await
    } else {
        let logs = docker.logs_tail(name, tail).await?;
        if global.quiet {
            print!("{logs}");
        } else {
            println!("{logs}");
        }
        Ok(())
    }
}

async fn run_remove(
    global: &GlobalOptions,
    docker: &dyn DockerRunner,
    purge_data: bool,
    yes: bool,
) -> Result<()> {
    let profile = ensure_local_profile(global).await?;
    docker.version().await?;
    let name = DEFAULT_CONTAINER_NAME;

    if let Some(inspect) = docker.inspect(name).await?
        && !inspect.managed_by_cli
    {
        bail!("container '{name}' is not managed by `am instance`");
    }

    docker.rm_force(name).await?;
    message(!global.quiet, "Container removed.");

    if purge_data {
        validate_purge_confirmed(yes)?;
        docker.volume_rm(VOLUME_DATA).await?;
        docker.volume_rm(VOLUME_STATE).await?;
        message(!global.quiet, "Named volumes removed.");
    } else {
        message(
            !global.quiet,
            &format!(
                "Data volumes preserved ({VOLUME_DATA}, {VOLUME_STATE}). CORE_API_KEY persists in {VOLUME_STATE} until `--purge-data --yes`."
            ),
        );
    }

    let report = instance_status_report(&profile, None, docker, global, false).await?;
    emit_instance_report(global, &report, false)
}

fn validate_purge_confirmed(yes: bool) -> Result<()> {
    if !yes {
        bail!("refusing to delete volumes — pass both --purge-data and --yes");
    }
    Ok(())
}

#[derive(Debug, Serialize)]
struct InstanceStatusReport {
    profile: String,
    container_name: String,
    container: Option<ContainerStatus>,
    core_health: Option<String>,
    local_url: String,
    local_clients: crate::commands::local_clients::LocalClientsInfo,
}

#[derive(Debug, Serialize)]
struct ContainerStatus {
    state: String,
    image: String,
    managed_by_cli: bool,
    profile_label: Option<String>,
}

fn emit_instance_report(
    global: &GlobalOptions,
    report: &InstanceStatusReport,
    show_secrets: bool,
) -> Result<()> {
    emit(global.output, report, global.quiet)?;
    if !global.quiet {
        message(
            true,
            &render_local_clients_card(&report.local_clients, show_secrets),
        );
    }
    Ok(())
}

async fn read_profile_core_key(
    docker: &dyn DockerRunner,
    profile_name: &str,
    inspect: Option<&ContainerInspect>,
) -> Option<String> {
    let inspect = inspect?;
    if !inspect.managed_by_cli || !inspect.state.is_running() {
        return None;
    }
    if inspect.profile_label.as_deref() != Some(profile_name) {
        return None;
    }
    docker
        .read_core_api_key(DEFAULT_CONTAINER_NAME)
        .await
        .ok()
        .flatten()
}

async fn instance_status_report(
    profile: &crate::config::ResolvedProfile,
    inspect: Option<&ContainerInspect>,
    docker: &dyn DockerRunner,
    global: &GlobalOptions,
    show_secrets: bool,
) -> Result<InstanceStatusReport> {
    let container = inspect.map(|i| ContainerStatus {
        state: format!("{:?}", i.state).to_lowercase(),
        image: i.image.clone(),
        managed_by_cli: i.managed_by_cli,
        profile_label: i.profile_label.clone(),
    });

    let core_health = match memory_client(global).await {
        Ok((_p, client)) => match client.health().await {
            Ok(_) => Some("ok".into()),
            Err(e) => Some(format!("error: {e}")),
        },
        Err(e) => Some(format!("unavailable: {e}")),
    };

    let state_key = read_profile_core_key(docker, &profile.name, inspect).await;
    // Raw secrets depend on --show-secrets and nothing else. A `reveal_on_start`
    // override meant an ordinary `am instance start` printed the persisted
    // CORE_API_KEY, a usable bearer token, into terminals and captured logs
    // while the flag advertised that secrets were redacted without it.
    let reveal = show_secrets;
    let local_clients =
        resolve_local_clients(&profile.memory_base_url, state_key.as_deref(), reveal);

    Ok(InstanceStatusReport {
        profile: profile.name.clone(),
        container_name: DEFAULT_CONTAINER_NAME.to_string(),
        container,
        core_health,
        local_url: profile.memory_base_url.clone(),
        local_clients,
    })
}

#[cfg(test)]
mod tests {

    /// The separation must hold along the whole call chain, not just inside
    /// `run_start`.
    ///
    /// `ReplacementPlan` was introduced to split operator authority from the
    /// internal recreate requirement, but `connect_project` was still OR-ing
    /// `needs_env_sync || cloud_key_changed` into `InstanceCommand::Start.replace`
    /// upstream. By the time `run_start` saw it, the two were already one value,
    /// so onboarding a first-run or relinked profile could force-remove an
    /// unrelated container named `atomic-memory` without consent. Fixing the
    /// consumer is not enough when a producer collapses the inputs.
    #[test]
    fn the_replace_flag_carries_only_operator_authority_upstream() {
        let src = include_str!("connect_project.rs").replace('\r', "");
        let code: String = src
            .lines()
            .map(|line| line.split("//").next().unwrap_or(""))
            .collect::<Vec<_>>()
            .join("\n");

        // EVERY `replace:` occurrence, not the first: the first match is the
        // struct field declaration, which can never contain the forbidden
        // identifiers, so asserting on it passed with the defect present.
        let assignments: Vec<&str> = code
            .lines()
            .map(str::trim)
            .filter(|line| line.starts_with("replace:"))
            .collect();

        assert!(
            !assignments.is_empty(),
            "expected connect_project to set a replace field",
        );
        for assignment in assignments {
            assert!(
                !assignment.contains("needs_env_sync") && !assignment.contains("cloud_key_changed"),
                "internal sync state must not be OR'd into `replace`; it is read \
                 downstream as consent to delete a foreign container. Got: {assignment}",
            );
        }
    }

    /// A credential sync must never authorise deleting a container we do not own.
    ///
    /// The defect: `requires_container_sync()` assigned into `opts.replace`, and
    /// the foreign-container branch reads that flag as operator consent, calling
    /// `docker rm -f`. A first run with an unrelated container named
    /// `atomic-memory` could create a Cloud key and silently destroy it, with no
    /// `--replace` ever supplied and no prompt shown.
    #[test]
    fn credential_sync_never_authorises_replacing_a_foreign_container() {
        let plan = ReplacementPlan::resolve(false, true, false);

        assert!(
            plan.recreate_managed,
            "our own container must still be recreated to pick up the new key",
        );
        assert!(
            !plan.may_replace_foreign,
            "an internal credential sync is not operator consent to delete a foreign container",
        );
    }

    #[test]
    fn the_operator_flag_authorises_both() {
        let plan = ReplacementPlan::resolve(true, false, false);
        assert!(plan.recreate_managed);
        assert!(
            plan.may_replace_foreign,
            "--replace must still mean what it has always meant",
        );
    }

    #[test]
    fn neither_without_a_reason() {
        let plan = ReplacementPlan::resolve(false, false, false);
        assert!(!plan.recreate_managed);
        assert!(!plan.may_replace_foreign);
    }

    /// The startup health probe must authenticate against the URL we
    /// PUBLISHED, never one the profile supplies.
    ///
    /// The defect: `wait_for_core_health` parsed `profile.memory_base_url` and
    /// handed the raw bootstrap Core key to whatever host it named, as a bearer
    /// header, on every default `am instance start`. That URL derives from the
    /// Cloud API's `project.local_url`, so a project record pointing at an
    /// attacker host received the key during ordinary health checking - and the
    /// container-label guard never ran, because it guards the key READ path,
    /// not this probe.
    ///
    /// The probe reaches the network, so this asserts at the source level, the
    /// same way the reveal decision is guarded: the health path must derive its
    /// URL from the published binding and must not read the profile's.
    #[test]
    fn the_health_probe_targets_the_published_binding_not_the_profile() {
        // Windows checkouts carry CRLF, so the literal "\n}\n" search below
        // never matched there and the expect panicked. Normalise first: this
        // test is about identifiers, not line endings.
        let src = include_str!("instance.rs").replace('\r', "");
        let start = src
            .find("async fn wait_for_core_health")
            .expect("wait_for_core_health must exist");
        // End at the function's own closing brace (column 0). Slicing to the
        // next `async fn` overshot into this test module, whose doc comment
        // names the forbidden identifier - the assertion tripped on itself.
        let end = src[start..]
            .find("\n}\n")
            .map(|o| start + o)
            .expect("wait_for_core_health must have a closing brace");
        // Comments are stripped before asserting: prose in the function may
        // legitimately NAME the forbidden identifier while explaining why it
        // must not be read - only code counts, in either direction.
        let body: String = src[start..end]
            .lines()
            .map(|line| line.split("//").next().unwrap_or(""))
            .collect::<Vec<_>>()
            .join("\n");

        assert!(
            !body.contains("memory_base_url"),
            "the health path must not read the profile's local URL; it sends a bearer key",
        );
        assert!(
            body.contains("managed_core_local_url()"),
            "the probe URL must come from the published binding",
        );
    }

    /// Raw secrets must depend on `--show-secrets` and nothing else.
    ///
    /// The defect: a `reveal_on_start` parameter was OR'd into this decision and
    /// both start paths passed `true`, so an ordinary `am instance start`
    /// printed the persisted CORE_API_KEY (a usable bearer token) into terminals
    /// and captured logs, while the flag advertised redaction without it.
    ///
    /// `instance_status_report` reaches the network via `memory_client`, so it
    /// is not unit-testable without a refactor. This asserts the decision at the
    /// source level, which is the level the bug lived at: a redaction test
    /// against `resolve_local_clients` passes with the bug present, because the
    /// helper was always correct and the caller was not.
    #[test]
    fn raw_secrets_depend_only_on_the_show_secrets_flag() {
        let src = include_str!("instance.rs");
        let decision = src
            .lines()
            .map(str::trim)
            .find(|line| line.starts_with("let reveal ="))
            .expect("instance_status_report must compute a `reveal` decision");

        assert_eq!(
            decision, "let reveal = show_secrets;",
            "the reveal decision must not be widened by any other condition",
        );
    }
    use super::*;
    use crate::environment::Environment;
    use crate::instance::docker::{InstanceEnv, build_run_argv};

    const TEST_IMAGE: &str = Environment::PROD_CORE_IMAGE;

    fn sample_env() -> InstanceEnv {
        InstanceEnv {
            openai_api_key: "sk-test".into(),
            atomicmemory_api_key: "amc_test".into(),
            atomicmemory_api_url: "https://api.dev.example.com".into(),
            cloud_jwks_url: "https://api.dev.example.com/.well-known/atomic-core/jwks.json".into(),
            core_api_key: Some("generated-core-key".into()),
        }
    }

    #[test]
    fn instance_start_flags_have_defaults() {
        use crate::cli::Cli;
        use clap::Parser;
        let cli = Cli::try_parse_from(["am", "instance", "start"]).unwrap();
        match cli.command {
            crate::cli::Command::Instance(InstanceCommand::Start {
                image,
                openai_api_key,
                replace,
                wait_secs,
                show_secrets,
            }) => {
                assert!(image.is_none());
                assert!(openai_api_key.is_none());
                assert!(!replace);
                assert_eq!(wait_secs, DEFAULT_WAIT_SECS);
                assert!(!show_secrets);
            }
            _ => panic!("expected instance start"),
        }
    }

    #[test]
    fn instance_status_accepts_show_secrets() {
        use crate::cli::Cli;
        use clap::Parser;
        let cli = Cli::try_parse_from(["am", "instance", "status", "--show-secrets"]).unwrap();
        match cli.command {
            crate::cli::Command::Instance(InstanceCommand::Status { show_secrets }) => {
                assert!(show_secrets);
            }
            _ => panic!("expected instance status"),
        }
    }

    #[test]
    fn remove_requires_yes_with_purge() {
        assert!(validate_purge_confirmed(false).is_err());
        assert!(validate_purge_confirmed(true).is_ok());
    }

    #[test]
    fn foreign_container_confirm_fails_closed_without_allow_prompts() {
        let err = confirm_replace_foreign_container("atomic-memory", false, false)
            .unwrap_err()
            .to_string();
        assert!(err.contains("not created by `am instance`"));
        assert!(err.contains("am instance start --replace"));
    }

    #[test]
    fn may_prompt_for_input_requires_allow_prompts() {
        assert!(!may_prompt_for_input(false));
    }

    #[test]
    fn may_prompt_openai_key_requires_interactive_flag() {
        // Non-interactive (--yes / quiet) must stay fail-fast even on a TTY.
        assert!(!may_prompt_openai_key(false));
    }

    #[test]
    fn openai_key_source_persists_only_prompted_keys() {
        // The prompt is the only surface that tells the user the key is saved.
        assert!(OpenAiKeySource::Prompted.should_persist());
        // A CI runner exporting OPENAI_API_KEY must not get it written to disk,
        // and a one-off --openai-api-key must not outlive the invocation.
        assert!(!OpenAiKeySource::Environment.should_persist());
        assert!(!OpenAiKeySource::Flag.should_persist());
        // Already on disk; rewriting it is a no-op at best.
        assert!(!OpenAiKeySource::Stored.should_persist());
    }

    #[test]
    fn openai_key_source_clears_only_a_rejected_stored_key() {
        // Only the credential that was actually tried and rejected may be
        // deleted. Rejecting a flag or environment override says nothing about
        // the stored key, which was never even sent to OpenAI.
        assert!(OpenAiKeySource::Stored.should_clear_stored());
        assert!(!OpenAiKeySource::Flag.should_clear_stored());
        assert!(!OpenAiKeySource::Environment.should_clear_stored());
        assert!(!OpenAiKeySource::Prompted.should_clear_stored());
    }

    #[test]
    fn health_failure_keeps_deepest_stage_not_first_poll() {
        // A booting container reports a closed port on the first poll every
        // time. That must not outrank the auth-chain failure that follows.
        let mut failure = None;
        record_deepest_health_failure(&mut failure, 0, "port closed".to_string());
        record_deepest_health_failure(&mut failure, 0, "port closed".to_string());
        record_deepest_health_failure(&mut failure, 2, "auth chain failed".to_string());
        assert_eq!(
            failure.as_ref().map(|(_, m)| m.as_str()),
            Some("auth chain failed")
        );

        // Within one stage the freshest message wins.
        record_deepest_health_failure(&mut failure, 2, "auth chain failed (jwks)".to_string());
        assert_eq!(
            failure.as_ref().map(|(_, m)| m.as_str()),
            Some("auth chain failed (jwks)")
        );

        // A shallower later probe must not undo real progress.
        record_deepest_health_failure(&mut failure, 1, "HTTP 503".to_string());
        assert_eq!(
            failure.as_ref().map(|(_, m)| m.as_str()),
            Some("auth chain failed (jwks)")
        );
    }

    #[test]
    fn health_failure_reports_closed_port_when_core_never_starts() {
        // The original bug: an unconditional later probe overwrote the only
        // honest diagnosis. If the port never opens, that is the answer.
        let mut failure = None;
        record_deepest_health_failure(&mut failure, 0, "port closed".to_string());
        assert_eq!(
            failure.as_ref().map(|(_, m)| m.as_str()),
            Some("port closed")
        );
    }

    #[test]
    fn instance_remove_parser_accepts_purge_flags() {
        use crate::cli::Cli;
        use clap::Parser;
        let cli =
            Cli::try_parse_from(["am", "instance", "remove", "--purge-data", "--yes"]).unwrap();
        match cli.command {
            crate::cli::Command::Instance(crate::commands::instance::InstanceCommand::Remove {
                purge_data,
                yes,
            }) => {
                assert!(purge_data);
                assert!(yes);
            }
            _ => panic!("expected instance remove"),
        }
    }

    #[test]
    fn instance_logs_parser_defaults() {
        use crate::cli::Cli;
        use clap::Parser;
        let cli = Cli::try_parse_from(["am", "instance", "logs"]).unwrap();
        match cli.command {
            crate::cli::Command::Instance(crate::commands::instance::InstanceCommand::Logs {
                follow,
                tail,
            }) => {
                assert!(!follow);
                assert_eq!(tail, 100);
            }
            _ => panic!("expected instance logs"),
        }
    }

    #[test]
    fn argv_has_no_secrets_from_env_builder() {
        let config = default_instance_config("test", TEST_IMAGE);
        let env = sample_env();
        let argv = build_run_argv(&config, &env);
        let joined = argv.join(" ");
        assert!(!joined.contains("amc_"));
    }

    #[test]
    fn argv_includes_core_api_key_env_name_when_provisioned() {
        let config = default_instance_config("test", TEST_IMAGE);
        let env = sample_env();
        let argv = build_run_argv(&config, &env);
        assert!(argv.contains(&"CORE_API_KEY".to_string()));
        let joined = argv.join(" ");
        assert!(!joined.contains("generated-core-key"));
    }

    #[test]
    fn argv_includes_core_api_key_name_only_when_override_set() {
        let config = default_instance_config("test", TEST_IMAGE);
        let mut env = sample_env();
        env.core_api_key = Some("custom-core-secret".into());
        let argv = build_run_argv(&config, &env);
        assert!(argv.contains(&"CORE_API_KEY".to_string()));
        let joined = argv.join(" ");
        assert!(!joined.contains("custom-core-secret"));
    }

    #[test]
    fn format_auth_chain_diag_includes_tier_and_detail() {
        let diag = format_auth_chain_diag(
            "https://api.staging.example.com",
            "auth chain failed: authentication failed (401/403)",
        );
        assert!(diag.contains("401 on unauthenticated health"));
        assert!(diag.contains("api.staging.example.com"));
        assert!(diag.contains("authentication failed"));
    }

    #[test]
    fn cloud_key_tier_mismatch_hint_mentions_key_create() {
        let msg = crate::commands::cloud_api_key::ProvisionOutcome::Rotated {
            key_id: "key_x".into(),
            key_name: "connected-local-runtime-a1b2c3d4e5f6".into(),
        }
        .operator_message()
        .unwrap();
        assert!(msg.contains("connected-local-runtime-a1b2c3d4e5f6"));
        assert!(msg.contains("Rotated"));
        assert!(!msg.contains("quota-safe"));
    }

    fn managed_inspect(state: ContainerState, profile: &str) -> ContainerInspect {
        ContainerInspect {
            name: "atomic-memory".into(),
            image: "ghcr.io/atomicstrata/atomicmemory-core:latest".into(),
            state,
            managed_by_cli: true,
            profile_label: Some(profile.into()),
            local_url: Some("http://127.0.0.1:17350".into()),
            atomicmemory_api_url: Some("https://api.atomicstrata.ai".into()),
            cloud_jwks_url: Some("https://api.atomicstrata.ai/.well-known/jwks.json".into()),
            core_api_key: None,
            atomicmemory_api_key: None,
        }
    }

    #[test]
    fn cloud_key_rotated_outcome_forces_replace_sync() {
        assert!(
            ProvisionOutcome::Rotated {
                key_id: "key_x".into(),
                key_name: "connected-local-runtime-a1b2c3d4e5f6".into(),
            }
            .requires_container_sync()
        );
    }

    #[test]
    fn mismatched_container_blocks_start_in_every_state() {
        // A stopped container is started unchanged by the `Some(_)` arm, so the
        // guard must not depend on the container currently running.
        for state in [
            ContainerState::Running,
            ContainerState::Exited,
            ContainerState::Created,
            ContainerState::Paused,
            ContainerState::Dead,
        ] {
            let inspect = managed_inspect(state, "other-profile");
            assert!(
                existing_container_blocks_start(
                    &inspect,
                    "active-profile",
                    "https://api.atomicstrata.ai",
                    "https://api.atomicstrata.ai/.well-known/jwks.json",
                    false,
                ),
                "state {state:?} must not bypass the profile mismatch guard"
            );
        }
    }

    #[test]
    fn matching_container_does_not_block_start() {
        let inspect = managed_inspect(ContainerState::Exited, "active-profile");
        assert!(!existing_container_blocks_start(
            &inspect,
            "active-profile",
            "https://api.atomicstrata.ai",
            "https://api.atomicstrata.ai/.well-known/jwks.json",
            false,
        ));
    }

    #[test]
    fn replace_flag_and_foreign_containers_do_not_block_start() {
        let inspect = managed_inspect(ContainerState::Exited, "other-profile");
        assert!(!existing_container_blocks_start(
            &inspect,
            "active-profile",
            "https://api.atomicstrata.ai",
            "https://api.atomicstrata.ai/.well-known/jwks.json",
            true,
        ));

        let mut foreign = managed_inspect(ContainerState::Exited, "other-profile");
        foreign.managed_by_cli = false;
        assert!(!existing_container_blocks_start(
            &foreign,
            "active-profile",
            "https://api.atomicstrata.ai",
            "https://api.atomicstrata.ai/.well-known/jwks.json",
            false,
        ));
    }

    #[test]
    fn cloud_env_drift_blocks_start_even_when_profile_matches() {
        let mut inspect = managed_inspect(ContainerState::Exited, "active-profile");
        inspect.atomicmemory_api_url = Some("https://api.staging.example.com".into());
        assert!(existing_container_blocks_start(
            &inspect,
            "active-profile",
            "https://api.atomicstrata.ai",
            "https://api.atomicstrata.ai/.well-known/jwks.json",
            false,
        ));
    }

    struct RecordingReporter {
        steps: Vec<String>,
        ticks: Vec<String>,
        outcomes: Vec<String>,
        input_events: Vec<&'static str>,
    }

    impl ProgressReporter for RecordingReporter {
        fn start_step(&mut self, id: &str, label: &str) {
            self.steps.push(format!("{id}:{label}"));
        }
        fn tick(&mut self, id: &str, detail: &str) {
            self.ticks.push(format!("{id}:{detail}"));
        }
        fn pause_for_input(&mut self) {
            self.input_events.push("pause");
        }
        fn resume_after_input(&mut self) {
            self.input_events.push("resume");
        }
        fn succeed(&mut self, id: &str, detail: Option<&str>) {
            self.outcomes
                .push(format!("ok:{id}:{}", detail.unwrap_or("")));
        }
        fn warn(&mut self, _id: &str, _detail: Option<&str>) {}
        fn fail(&mut self, _id: &str, _detail: Option<&str>) {}
        fn finish(&mut self) {}
    }

    #[test]
    fn brief_instance_progress_ticks_parent_step() {
        let mut reporter = RecordingReporter {
            steps: Vec::new(),
            ticks: Vec::new(),
            outcomes: Vec::new(),
            input_events: Vec::new(),
        };
        let mut progress: Option<&mut dyn ProgressReporter> = Some(&mut reporter);
        progress_step(
            &mut progress,
            Some("runtime"),
            "credentials",
            "Resolve instance credentials",
            "resolve credentials",
        );
        progress_tick(
            &mut progress,
            Some("runtime"),
            "credentials",
            "validating OpenAI key",
        );
        progress_succeed(&mut progress, Some("runtime"), "credentials", Some("ready"));
        progress_step(
            &mut progress,
            Some("runtime"),
            "container",
            "Create or start container",
            "create or start container",
        );
        assert!(
            reporter.steps.is_empty(),
            "brief mode must not open nested steps"
        );
        assert_eq!(
            reporter.ticks,
            vec![
                "runtime:resolve credentials".to_string(),
                "runtime:validating OpenAI key".to_string(),
                "runtime:ready".to_string(),
                "runtime:create or start container".to_string(),
            ]
        );
    }

    #[test]
    fn nested_instance_progress_uses_step_ids() {
        let mut reporter = RecordingReporter {
            steps: Vec::new(),
            ticks: Vec::new(),
            outcomes: Vec::new(),
            input_events: Vec::new(),
        };
        let mut progress: Option<&mut dyn ProgressReporter> = Some(&mut reporter);
        progress_step(
            &mut progress,
            None,
            "credentials",
            "Resolve instance credentials",
            "unused",
        );
        progress_succeed(&mut progress, None, "credentials", Some("ready"));
        assert_eq!(reporter.steps.len(), 1);
        assert_eq!(
            reporter.steps[0],
            "credentials:Resolve instance credentials"
        );
        assert_eq!(reporter.outcomes[0], "ok:credentials:ready");
        assert!(reporter.ticks.is_empty());
    }

    #[test]
    fn managed_recreate_confirmation_does_not_authorise_foreign_replace() {
        let plan = ReplacementPlan::resolve(false, false, true);
        assert!(
            plan.recreate_managed,
            "confirmed managed mismatch must recreate our container",
        );
        assert!(
            !plan.may_replace_foreign,
            "managed recreate consent must not grant foreign-container authority",
        );
    }

    #[test]
    fn mismatched_managed_recreate_fails_closed_when_noninteractive() {
        let err = confirm_recreate_mismatched_managed_container("atomic-memory", "tesdt", false)
            .unwrap_err()
            .to_string();
        assert!(err.contains("does not match active CLI profile 'tesdt'"));
        assert!(err.contains("am instance start --replace"));
    }

    #[test]
    fn progress_pause_resumes_even_when_paused_op_fails() {
        let mut reporter = RecordingReporter {
            steps: Vec::new(),
            ticks: Vec::new(),
            outcomes: Vec::new(),
            input_events: Vec::new(),
        };
        let mut progress: Option<&mut dyn ProgressReporter> = Some(&mut reporter);
        let result: Result<(), &str> =
            with_progress_paused_for_input(&mut progress, true, || Err("openai key rejected"));
        assert!(result.is_err());
        assert_eq!(reporter.input_events, vec!["pause", "resume"]);
    }

    #[test]
    fn progress_pause_resumes_around_foreign_confirm_gate() {
        let mut reporter = RecordingReporter {
            steps: Vec::new(),
            ticks: Vec::new(),
            outcomes: Vec::new(),
            input_events: Vec::new(),
        };
        let mut progress: Option<&mut dyn ProgressReporter> = Some(&mut reporter);
        let confirmed =
            with_progress_paused_for_input(&mut progress, true, || Ok::<bool, &str>(false));
        assert!(!confirmed.unwrap());
        assert_eq!(reporter.input_events, vec!["pause", "resume"]);
    }
}
