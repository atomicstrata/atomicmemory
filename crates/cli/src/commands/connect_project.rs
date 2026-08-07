//! Shared Connected Local onboarding: project resolve/link, API key, Core, verify.

use std::io::{self, IsTerminal, Write as _};

use am_cloud_types::{
    CANONICAL_DEFAULT_PROJECT_SLUG, DefaultProjectSlugRank, Organization, Project, ProjectType,
    find_project_by_default_alias, is_default_project_slug,
};
use anyhow::{Context, Result, bail};

use crate::auth::claims::decode_id_token;
use crate::auth::device_login::{DeviceLoginOptions, run_device_login};
use crate::auth::ensure_org::{EnsureOrgOptions, ensure_org_context};
use crate::auth::login::{LoginOptions, run_login};
use crate::auth::token::valid_bearer_token;
use crate::cli::GlobalOptions;
use crate::commands::client::{dashboard_client, memory_client};
use crate::commands::cloud_api_key::ensure_connected_local_cloud_api_key_stored;
use crate::commands::instance::{InstanceCommand, run_start_brief};
use crate::config::{
    ProfileConfig, ProfileKind, ensure_config_initialized, jwks_url, require_api_key,
    resolve_dashboard_context, resolve_openai_api_key, resolve_profile, update_config,
};
use crate::instance::docker::{RealDockerRunner, ensure_docker_available};
use crate::instance::managed_core_needs_env_sync;
use crate::onboarding_runtime::{default_runtime_wait, wait_runtime_online_with_progress};
use crate::output::message;
use crate::progress::{ProgressReporter, progress_for};
use crate::telemetry::{
    ActivationContext, ActivationEvent, InitStep, capture_activation, capture_email_hash,
    capture_step_failure,
};
use crate::verification::receipt::{InitReceiptInput, build_init_receipt, print_init_receipt};
use crate::verification::smoke::{SmokeOptions, SmokeTelemetry, run_memory_smoke};

#[derive(Debug, Clone, Default)]
pub struct ConnectProjectOptions {
    pub no_instance: bool,
    pub skip_verify: bool,
    pub replace: bool,
    pub instance_image: Option<String>,
}

/// Full `am connect --project` / dashboard-first onboarding from a project ref.
pub async fn run(
    project_ref: &str,
    use_device: bool,
    opts: &ConnectProjectOptions,
    global: &GlobalOptions,
) -> Result<()> {
    let mut progress = progress_for(global);
    let result = run_with_progress(project_ref, use_device, opts, global, progress.as_mut()).await;
    progress.finish();
    result
}

async fn run_with_progress(
    project_ref: &str,
    use_device: bool,
    opts: &ConnectProjectOptions,
    global: &GlobalOptions,
    progress: &mut dyn ProgressReporter,
) -> Result<()> {
    let ctx = authenticate_and_bootstrap_org(use_device, global, progress).await?;
    let mut cloud_global = global.clone();
    cloud_global.profile = Some(ctx.cloud_profile.clone());
    cloud_global.base_url = Some(ctx.cloud_api_url.clone());

    let (_profile, client) = dashboard_client(&cloud_global).await?;
    let project = resolve_project(&client, project_ref, ctx.cloud_api_url.as_str()).await?;

    if project.kind != ProjectType::Local {
        bail!(
            "project '{}' is type={:?} — connect requires a local project",
            project.name,
            project.kind
        );
    }

    connect_local_project(project, opts, global, ctx, progress).await
}

/// Dashboard-first onboarding when the Cloud project is already known.
pub async fn connect_local_project(
    project: Project,
    opts: &ConnectProjectOptions,
    global: &GlobalOptions,
    ctx: OnboardingContext,
    progress: &mut dyn ProgressReporter,
) -> Result<()> {
    ensure_config_initialized()?;

    let mut actx = ctx.actx;
    let org = ctx.org;
    let cloud_profile = ctx.cloud_profile;
    let cloud_api_url = ctx.cloud_api_url;
    let signed_in_as = ctx.signed_in_as;

    if project.kind != ProjectType::Local {
        bail!(
            "project '{}' is type={:?} — local onboarding requires a local project",
            project.name,
            project.kind
        );
    }

    progress.start_step("project", "Link local project");
    let local_url = project
        .local_url
        .clone()
        .unwrap_or_else(|| "http://127.0.0.1:17350".to_string());
    let (profile_name, profile_relinked) =
        match ensure_local_profile(&project, &cloud_profile, cloud_api_url.as_str(), &local_url) {
            Ok(v) => v,
            Err(err) => {
                progress.fail("project", Some(&err.to_string()));
                capture_step_failure(
                    InitStep::ProjectLink,
                    &err,
                    Some(actx.props()),
                    global.no_telemetry,
                );
                return Err(err);
            }
        };
    actx.project_id = Some(project.id.clone());
    capture_activation(
        ActivationEvent::ProjectLinked,
        Some(actx.props()),
        global.no_telemetry,
    );
    progress.succeed(
        "project",
        Some(&format!("{} ({})", project.name, project.id)),
    );

    let mut local_global = global.clone();
    local_global.profile = Some(profile_name.clone());
    local_global.base_url = Some(cloud_api_url.clone());

    progress.start_step("credential", "Cloud API key");
    let cloud_key_outcome = match ensure_connected_local_cloud_api_key_stored(
        &local_global,
        &profile_name,
        &project.id,
    )
    .await
    {
        Ok(outcome) => {
            progress.succeed("credential", Some(outcome.progress_detail()));
            outcome
        }
        Err(err) => {
            progress.fail("credential", Some(&err.to_string()));
            return Err(err);
        }
    };

    let credential_ready = resolve_profile(
        Some(&profile_name),
        Some(cloud_api_url.as_str()),
        global.environment,
    )
    .ok()
    .and_then(|p| require_api_key(&p).ok())
    .is_some();

    let core_healthy = start_core_with_env_sync(
        &local_global,
        &profile_name,
        CoreEnvSync {
            profile_relinked,
            cloud_key_changed: cloud_key_outcome.requires_container_sync(),
        },
        opts,
        progress,
        &mut actx,
        global.no_telemetry,
    )
    .await?;

    finish_onboarding(FinishOnboardingInput {
        local_global: &local_global,
        project: &project,
        org: &org,
        local_url: &local_url,
        cloud_api_url: cloud_api_url.as_str(),
        signed_in_as: signed_in_as.as_deref(),
        core_healthy,
        credential_ready,
        opts,
        actx: &mut actx,
        global,
        progress,
    })
    .await
}

struct FinishOnboardingInput<'a> {
    local_global: &'a GlobalOptions,
    project: &'a Project,
    org: &'a Organization,
    local_url: &'a str,
    cloud_api_url: &'a str,
    signed_in_as: Option<&'a str>,
    core_healthy: bool,
    credential_ready: bool,
    opts: &'a ConnectProjectOptions,
    actx: &'a mut ActivationContext,
    global: &'a GlobalOptions,
    progress: &'a mut dyn ProgressReporter,
}

pub struct OnboardingContext {
    pub actx: ActivationContext,
    pub org: Organization,
    pub cloud_profile: String,
    pub cloud_api_url: String,
    pub signed_in_as: Option<String>,
}

pub async fn authenticate_and_bootstrap_org(
    use_device: bool,
    global: &GlobalOptions,
    progress: &mut dyn ProgressReporter,
) -> Result<OnboardingContext> {
    ensure_config_initialized()?;

    let mut actx = ActivationContext::local();
    capture_activation(
        ActivationEvent::InitStarted,
        Some(actx.props()),
        global.no_telemetry,
    );

    let dashboard = resolve_dashboard_context(
        global.profile.as_deref(),
        global.base_url.as_deref(),
        global.environment,
    )?;
    let cloud_profile = dashboard.oauth_profile;
    let cloud_api_url = dashboard.base_url;

    progress.start_step("identity", "Sign in");
    if let Err(err) = ensure_authenticated(
        &cloud_profile,
        cloud_api_url.as_str(),
        use_device,
        global,
        progress,
        &mut actx,
        global.no_telemetry,
    )
    .await
    {
        progress.fail("identity", Some(&err.to_string()));
        capture_step_failure(
            InitStep::Login,
            &err,
            Some(actx.props()),
            global.no_telemetry,
        );
        return Err(err);
    }

    let signed_in_as = valid_bearer_token(&cloud_profile, cloud_api_url.as_str())
        .await
        .ok()
        .and_then(|token| decode_id_token(&token).ok())
        .and_then(|claims| claims.email.clone());

    actx.email_hash = signed_in_as
        .as_deref()
        .and_then(|email| capture_email_hash(email, global.no_telemetry));

    progress.start_step("workspace", "Organization ready");
    let org = match ensure_org_context(
        &cloud_profile,
        None,
        !global.quiet,
        Some(cloud_api_url.as_str()),
        EnsureOrgOptions {
            skip_default_project: true,
        },
    )
    .await
    {
        Ok(org) => org,
        Err(err) => {
            progress.fail("workspace", Some(&err.to_string()));
            capture_step_failure(
                InitStep::Workspace,
                &err,
                Some(actx.props()),
                global.no_telemetry,
            );
            return Err(err);
        }
    };
    actx.org_id = Some(org.id.clone());
    capture_activation(
        ActivationEvent::WorkspaceCreated,
        Some(actx.props()),
        global.no_telemetry,
    );
    progress.succeed("workspace", Some(&format!("{} ({})", org.name, org.id)));

    Ok(OnboardingContext {
        actx,
        org,
        cloud_profile,
        cloud_api_url,
        signed_in_as,
    })
}

pub fn local_projects(projects: &[Project]) -> Vec<&Project> {
    projects
        .iter()
        .filter(|p| p.kind == ProjectType::Local)
        .collect()
}

pub fn pick_local_project(projects: &[Project], interactive: bool) -> Result<Option<Project>> {
    let locals = local_projects(projects);
    match locals.len() {
        0 => Ok(None),
        1 if !interactive || !io::stdin().is_terminal() => {
            message(
                interactive,
                &format!(
                    "Using local project '{}' ({}) — only local project in your org.",
                    locals[0].name, locals[0].id
                ),
            );
            Ok(Some(locals[0].clone()))
        }
        1 => prompt_single_local_project(locals[0]).map(|p| p.cloned()),
        _ if interactive && io::stdin().is_terminal() => {
            prompt_local_project(&locals).map(|p| p.cloned())
        }
        _ => Ok(preferred_local_project(&locals).cloned()),
    }
}

fn preferred_local_project<'a>(locals: &[&'a Project]) -> Option<&'a Project> {
    locals
        .iter()
        .copied()
        .filter(|p| is_default_project_slug(&p.slug))
        .min_by_key(|p| DefaultProjectSlugRank::for_slug(&p.slug))
        .or_else(|| locals.first().copied())
}

fn default_local_project_index(locals: &[&Project]) -> usize {
    preferred_local_project(locals)
        .and_then(|preferred| locals.iter().position(|p| p.id == preferred.id))
        .unwrap_or(0)
}

fn prompt_single_local_project(project: &Project) -> Result<Option<&Project>> {
    eprintln!();
    eprintln!(
        "Found local project '{}' ({}) — use it for this setup?",
        project.name, project.slug
    );
    eprint!("Use this project? [Y/n]: ");
    io::stderr().flush().ok();
    let mut line = String::new();
    io::stdin()
        .read_line(&mut line)
        .context("read confirmation")?;
    let choice = line.trim().to_ascii_lowercase();
    if choice.is_empty() || choice == "y" || choice == "yes" {
        Ok(Some(project))
    } else {
        Ok(None)
    }
}

fn prompt_local_project<'a>(projects: &'a [&Project]) -> Result<Option<&'a Project>> {
    let default_idx = default_local_project_index(projects);

    eprintln!();
    eprintln!("Select a local project to connect:");
    for (i, project) in projects.iter().enumerate() {
        let marker = if i == default_idx { " (default)" } else { "" };
        eprintln!("  {}. {} — {}{}", i + 1, project.name, project.slug, marker);
    }
    eprintln!();

    let stdin = io::stdin();
    loop {
        eprint!(
            "Enter choice [1-{}] (default {}): ",
            projects.len(),
            default_idx + 1
        );
        io::stderr().flush().ok();
        let mut line = String::new();
        stdin.read_line(&mut line).context("read project choice")?;
        let choice = line.trim();
        if choice.is_empty() {
            return Ok(Some(projects[default_idx]));
        }
        let Ok(num) = choice.parse::<usize>() else {
            eprintln!("Enter a number between 1 and {}.", projects.len());
            continue;
        };
        if (1..=projects.len()).contains(&num) {
            return Ok(Some(projects[num - 1]));
        }
        eprintln!("Enter a number between 1 and {}.", projects.len());
    }
}

pub async fn resolve_project(
    client: &am_cloud_client::DashboardClient,
    id_or_slug: &str,
    api_base_url: &str,
) -> Result<Project> {
    if id_or_slug.starts_with("proj_") {
        return client.get_project(id_or_slug).await.map_err(|e| {
            anyhow::anyhow!(
                "{e}\n\
                 Hint: verify the project exists on {api_base_url} (`am project list --base-url {api_base_url}`)."
            )
        });
    }

    let projects = client
        .list_projects()
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    find_project_by_ref(&projects, id_or_slug)
        .cloned()
        .ok_or_else(|| {
            anyhow::anyhow!(
                "project not found: {id_or_slug} (dashboard API: {api_base_url}). \
                 Run `am project list` on the same profile/`--base-url` where the project was created."
            )
        })
}

pub fn find_project_by_ref<'a>(projects: &'a [Project], id_or_slug: &str) -> Option<&'a Project> {
    if id_or_slug.eq_ignore_ascii_case(CANONICAL_DEFAULT_PROJECT_SLUG) {
        return find_project_by_default_alias(projects);
    }
    projects
        .iter()
        .find(|p| p.id == id_or_slug || p.slug.eq_ignore_ascii_case(id_or_slug))
}

pub fn ensure_local_profile(
    project: &Project,
    cloud_profile: &str,
    cloud_api_url: &str,
    local_url: &str,
) -> Result<(String, bool)> {
    let profile_name = project.slug.clone();

    // The relink decision reads the same config it then rewrites, so it has to
    // happen inside the lock or a concurrent write can be lost.
    let profile_relinked = update_config(|cfg| {
        let profile_relinked = cfg
            .profiles
            .get(&profile_name)
            .map(|p| {
                p.project_id.as_deref() != Some(project.id.as_str())
                    || p.base_url.as_deref() != Some(cloud_api_url)
            })
            .unwrap_or(true);

        if profile_relinked {
            cfg.profiles.insert(
                profile_name.clone(),
                ProfileConfig {
                    base_url: Some(cloud_api_url.to_string()),
                    kind: ProfileKind::Local,
                    project_id: Some(project.id.clone()),
                    local_url: Some(local_url.to_string()),
                    oauth_ref: Some(cloud_profile.to_string()),
                    ..Default::default()
                },
            );
        }

        cfg.default_profile = Some(profile_name.clone());
        Ok(profile_relinked)
    })?;
    Ok((profile_name, profile_relinked))
}

struct CoreEnvSync {
    profile_relinked: bool,
    cloud_key_changed: bool,
}

async fn start_core_with_env_sync(
    local_global: &GlobalOptions,
    profile_name: &str,
    env_sync: CoreEnvSync,
    opts: &ConnectProjectOptions,
    progress: &mut dyn ProgressReporter,
    actx: &mut ActivationContext,
    no_telemetry: bool,
) -> Result<bool> {
    if opts.no_instance {
        progress.start_step("runtime", "Start local Core");
        let reachable = core_reachable(local_global).await;
        if reachable {
            progress.warn(
                "runtime",
                Some("skipped (--no-instance); Core already reachable"),
            );
        } else {
            progress.warn("runtime", Some("skipped (--no-instance)"));
        }
        return Ok(reachable);
    }

    progress.start_step("runtime", "Start local Core (Docker)");
    progress.tick("runtime", "checking Docker");
    let docker = RealDockerRunner::new();
    if let Err(err) = ensure_docker_available(&docker).await {
        progress.fail("runtime", Some(&err.to_string()));
        capture_step_failure(InitStep::Docker, &err, Some(actx.props()), no_telemetry);
        return Err(err);
    }

    let cloud_api_url = local_global.base_url.clone().unwrap_or_else(|| {
        resolve_profile(Some(profile_name), None, local_global.environment)
            .map(|p| p.base_url)
            .unwrap_or_default()
    });
    let needs_env_sync = managed_core_needs_env_sync(
        &docker,
        profile_name,
        env_sync.profile_relinked,
        cloud_api_url.as_str(),
        &jwks_url(cloud_api_url.as_str())?,
    )
    .await?;
    let running = core_reachable(local_global).await;
    if running && !needs_env_sync && !env_sync.cloud_key_changed {
        progress.succeed("runtime", Some("already running"));
        return Ok(true);
    }

    if (needs_env_sync || env_sync.cloud_key_changed) && running {
        progress.tick("runtime", "recreating with Cloud trace sync");
    } else if !running {
        progress.tick("runtime", "starting container");
    }

    // Pause for possible OpenAI stdin prompts (missing key or rejected key re-prompt).
    let may_prompt_openai = !local_global.quiet && io::stdin().is_terminal();
    let missing_openai = may_prompt_openai
        && std::env::var("OPENAI_API_KEY").is_err()
        && resolve_openai_api_key(profile_name).is_none();
    if may_prompt_openai {
        progress.pause_for_input();
        if missing_openai {
            progress.tick("runtime", "OpenAI API key required below");
        }
    }

    let start_result = run_start_brief(
        local_global,
        InstanceCommand::Start {
            image: opts.instance_image.clone(),
            openai_api_key: None,
            // Operator authority ONLY. The internal recreate requirement is
            // passed separately below: `replace` is read downstream as consent
            // to force-remove a container this CLI does not manage, so a
            // first-run or relinked profile with an unrelated container named
            // `atomic-memory` would have it destroyed without being asked.
            replace: opts.replace,
            wait_secs: crate::instance::DEFAULT_WAIT_SECS,
            show_secrets: false,
        },
        // The internal requirement, kept out of `replace`.
        needs_env_sync || env_sync.cloud_key_changed,
    )
    .await;

    if may_prompt_openai {
        progress.resume_after_input();
    }

    match start_result {
        Ok(started) => {
            if started {
                capture_activation(
                    ActivationEvent::CoreStarted,
                    Some(actx.props()),
                    no_telemetry,
                );
                progress.succeed("runtime", Some("healthy"));
            } else {
                capture_step_failure(
                    InitStep::CoreStart,
                    anyhow::anyhow!("core start returned unhealthy"),
                    Some(actx.props()),
                    no_telemetry,
                );
                progress.warn("runtime", Some("unhealthy"));
            }
            Ok(started)
        }
        Err(err) => {
            progress.fail("runtime", Some(&err.to_string()));
            capture_step_failure(InitStep::CoreStart, &err, Some(actx.props()), no_telemetry);
            Err(err)
        }
    }
}

async fn finish_onboarding(input: FinishOnboardingInput<'_>) -> Result<()> {
    let FinishOnboardingInput {
        local_global,
        project,
        org,
        local_url,
        cloud_api_url,
        signed_in_as,
        core_healthy,
        credential_ready,
        opts,
        actx,
        global,
        progress,
    } = input;
    let cloud_connection_online = if !opts.no_instance && core_healthy {
        progress.start_step("heartbeat", "Wait for Cloud runtime online");
        let online = wait_runtime_online_with_progress(
            local_global,
            &project.id,
            default_runtime_wait(),
            Some(progress),
        )
        .await;
        if online {
            capture_activation(
                ActivationEvent::HeartbeatReceived,
                Some(actx.props()),
                global.no_telemetry,
            );
            progress.succeed("heartbeat", Some("online"));
        } else {
            capture_step_failure(
                InitStep::Heartbeat,
                anyhow::anyhow!("runtime did not come online within wait window"),
                Some(actx.props()),
                global.no_telemetry,
            );
            progress.warn("heartbeat", Some("timed out"));
        }
        online
    } else {
        false
    };

    let smoke_telemetry = SmokeTelemetry {
        no_telemetry: global.no_telemetry,
        props: Some(actx.props()),
    };

    let smoke = if !opts.no_instance && !opts.skip_verify && core_healthy {
        progress.start_step("smoke", "Memory pipeline smoke");
        match run_memory_smoke(local_global, SmokeOptions::default(), Some(smoke_telemetry)).await {
            Ok(result) => {
                if result.verified {
                    capture_activation(
                        ActivationEvent::FirstRetrievalCompleted,
                        Some(actx.props()),
                        global.no_telemetry,
                    );
                    progress.succeed("smoke", Some("verified"));
                } else {
                    progress.warn("smoke", Some("not verified"));
                }
                Some(result)
            }
            Err(err) => {
                capture_step_failure(
                    InitStep::Smoke,
                    &err,
                    Some(actx.props()),
                    global.no_telemetry,
                );
                progress.warn("smoke", Some(&format!("skipped: {err:#}")));
                None
            }
        }
    } else {
        if opts.skip_verify || opts.no_instance {
            progress.start_step("smoke", "Memory pipeline smoke");
            progress.warn(
                "smoke",
                Some(if opts.skip_verify {
                    "skipped (--skip-verify)"
                } else {
                    "skipped (--no-instance)"
                }),
            );
        }
        None
    };

    progress.start_step("receipt", "Init receipt");
    let receipt = build_init_receipt(InitReceiptInput {
        signed_in_as,
        org_name: &org.name,
        org_id: &org.id,
        project_name: &project.name,
        project_id: &project.id,
        local_url,
        api_base_url: cloud_api_url,
        core_healthy,
        no_instance: opts.no_instance,
        cloud_connection_online,
        credential_ready,
        smoke,
    });
    progress.succeed(
        "receipt",
        Some(if receipt.activated {
            "activated"
        } else {
            "partial"
        }),
    );

    print_init_receipt(&receipt, global);
    Ok(())
}

async fn ensure_authenticated(
    cloud_profile: &str,
    cloud_api_url: &str,
    use_device: bool,
    global: &GlobalOptions,
    progress: &mut dyn ProgressReporter,
    actx: &mut ActivationContext,
    no_telemetry: bool,
) -> Result<()> {
    if valid_bearer_token(cloud_profile, cloud_api_url)
        .await
        .is_ok()
    {
        progress.succeed("identity", Some("existing session"));
        return Ok(());
    }

    if use_device {
        progress.tick("identity", "device login");
        run_device_login(
            DeviceLoginOptions {
                profile: cloud_profile.to_string(),
                base_url: cloud_api_url.to_string(),
                client_id: None,
                quiet: global.quiet,
                verbose: global.verbose > 0,
            },
            Some(progress),
            Some("identity"),
        )
        .await?;
    } else {
        progress.tick("identity", "browser OAuth");
        run_login(
            LoginOptions {
                profile: cloud_profile.to_string(),
                port: None,
                no_browser: false,
                issuer: None,
                client_id: None,
                skip_project_select: true,
                base_url: Some(cloud_api_url.to_string()),
                org_scope: true,
                fresh_login: false,
                verbose: global.verbose > 0,
                quiet: global.quiet,
            },
            Some(progress),
            Some("identity"),
        )
        .await?;
    }

    capture_activation(
        ActivationEvent::LoginCompleted,
        Some(actx.props()),
        no_telemetry,
    );
    progress.succeed("identity", Some("signed in"));
    Ok(())
}

async fn core_reachable(global: &GlobalOptions) -> bool {
    if let Ok((_p, client)) = memory_client(global).await {
        return client.health().await.is_ok();
    }
    false
}

#[cfg(test)]
mod tests {
    use am_cloud_types::{
        CANONICAL_DEFAULT_PROJECT_SLUG, LEGACY_DEFAULT_PROJECT_SLUG, PrivacyMode, ProjectType,
    };
    use chrono::Utc;

    use super::*;

    fn sample_project(org_id: &str, slug: &str) -> Project {
        Project {
            id: format!("proj_{slug}"),
            org_id: org_id.into(),
            name: slug.into(),
            slug: slug.into(),
            environment: "dev".into(),
            kind: ProjectType::Local,
            local_url: Some("http://127.0.0.1:17350".into()),
            privacy_mode: PrivacyMode::Connect,
            created_at: Utc::now(),
            memory_count: None,
            last_activity_at: None,
        }
    }

    fn sample_cloud_project(org_id: &str, slug: &str) -> Project {
        Project {
            kind: ProjectType::Cloud,
            local_url: None,
            ..sample_project(org_id, slug)
        }
    }

    #[test]
    fn project_id_prefix_detects_proj_ids() {
        assert!("proj_abc".starts_with("proj_"));
        assert!(!"my-slug".starts_with("proj_"));
    }

    #[test]
    fn find_project_by_ref_matches_slug_case_insensitively() {
        let projects = vec![sample_project("org_a", "atomic-strata-project")];
        let found = find_project_by_ref(&projects, "Atomic-Strata-Project");
        assert_eq!(found.unwrap().slug, "atomic-strata-project");
    }

    #[test]
    fn find_project_by_ref_does_not_filter_by_org() {
        let projects = vec![sample_project("org_a", "personal")];
        assert_eq!(
            find_project_by_ref(&projects, "personal").unwrap().org_id,
            "org_a"
        );
    }

    #[test]
    fn local_projects_filters_to_local_kind() {
        let projects = vec![
            sample_cloud_project("org_a", "hosted"),
            sample_project("org_a", "personal"),
        ];
        let locals = local_projects(&projects);
        assert_eq!(locals.len(), 1);
        assert_eq!(locals[0].slug, "personal");
    }

    #[test]
    fn pick_local_project_auto_selects_single_non_interactive() {
        let projects = vec![sample_project("org_a", "only-one")];
        let picked = pick_local_project(&projects, false).unwrap().unwrap();
        assert_eq!(picked.slug, "only-one");
    }

    #[test]
    fn pick_local_project_returns_none_when_no_locals() {
        let projects = vec![sample_cloud_project("org_a", "hosted")];
        assert!(pick_local_project(&projects, false).unwrap().is_none());
    }

    #[test]
    fn pick_local_project_non_interactive_prefers_canonical_default() {
        let projects = vec![
            sample_cloud_project("org_a", "hosted"),
            sample_project("org_a", LEGACY_DEFAULT_PROJECT_SLUG),
            sample_project("org_a", CANONICAL_DEFAULT_PROJECT_SLUG),
        ];
        let picked = pick_local_project(&projects, false).unwrap().unwrap();
        assert_eq!(picked.slug, CANONICAL_DEFAULT_PROJECT_SLUG);
    }

    #[test]
    fn pick_local_project_non_interactive_falls_back_to_legacy_default() {
        let projects = vec![
            sample_cloud_project("org_a", "hosted"),
            sample_project("org_a", "personal"),
            sample_project("org_a", LEGACY_DEFAULT_PROJECT_SLUG),
        ];
        let picked = pick_local_project(&projects, false).unwrap().unwrap();
        assert_eq!(picked.slug, LEGACY_DEFAULT_PROJECT_SLUG);
    }

    #[test]
    fn find_project_by_ref_resolves_default_alias_canonical_first() {
        let projects = vec![
            sample_project("org_a", LEGACY_DEFAULT_PROJECT_SLUG),
            sample_project("org_a", CANONICAL_DEFAULT_PROJECT_SLUG),
        ];
        let found = find_project_by_ref(&projects, "default").unwrap();
        assert_eq!(found.slug, CANONICAL_DEFAULT_PROJECT_SLUG);
    }

    #[test]
    fn find_project_by_ref_resolves_default_alias_to_legacy_only() {
        let projects = vec![sample_project("org_a", LEGACY_DEFAULT_PROJECT_SLUG)];
        let found = find_project_by_ref(&projects, "default").unwrap();
        assert_eq!(found.slug, LEGACY_DEFAULT_PROJECT_SLUG);
    }

    #[test]
    fn find_project_by_ref_still_matches_explicit_legacy_slug() {
        let projects = vec![
            sample_project("org_a", CANONICAL_DEFAULT_PROJECT_SLUG),
            sample_project("org_a", LEGACY_DEFAULT_PROJECT_SLUG),
        ];
        let found = find_project_by_ref(&projects, LEGACY_DEFAULT_PROJECT_SLUG).unwrap();
        assert_eq!(found.slug, LEGACY_DEFAULT_PROJECT_SLUG);
    }

    #[test]
    fn default_local_project_index_prefers_canonical() {
        let legacy = sample_project("org_a", LEGACY_DEFAULT_PROJECT_SLUG);
        let canonical = sample_project("org_a", CANONICAL_DEFAULT_PROJECT_SLUG);
        let locals = vec![&legacy, &canonical];
        assert_eq!(default_local_project_index(&locals), 1);
    }
}
