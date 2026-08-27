//! First-run wizard: login → org → project → local link → optional Core instance.

use std::io::{self, IsTerminal, Write as _};

use anyhow::{Context, Result, bail};
use clap::Args;

use crate::auth::claims::{decode_id_token, token_has_active_org};
use crate::auth::device_login::{DeviceLoginOptions, run_device_login};
use crate::auth::ensure_org::{EnsureOrgOptions, ensure_org_context};
use crate::auth::login::{LoginOptions, run_login};
use crate::auth::token::valid_bearer_token;
use crate::cli::GlobalOptions;
use crate::commands::client::{dashboard_client, resolve_profile_and_warn};
use crate::commands::connect_project::{
    ConnectProjectOptions, OnboardingContext, cloud_projects, connect_local_project,
    ensure_local_project_for_connect, pick_local_project,
};
use crate::commands::link::{LinkLocalOptions, LinkLocalRequest, link_local};
use crate::config::{
    ProfileConfig, ProfileKind, ensure_config_initialized, load_config, resolve_cloud_auth_target,
    update_config,
};
use crate::progress::{ProgressReporter, progress_for};
use crate::telemetry::{
    ActivationContext, ActivationEvent, InitStep, capture_activation, capture_email_hash,
    capture_step_failure,
};
use am_cloud_client::DashboardClient;
use am_cloud_types::{
    CANONICAL_DEFAULT_PROJECT_SLUG, Project, ProjectType, find_project_by_default_alias,
};

mod hosted_cloud;

#[cfg(test)]
use crate::commands::connect_project::{
    HostedCloudTarget, ensure_cloud_project_for_handoff, hosted_cloud_target_policy,
};
#[cfg(test)]
use hosted_cloud::{CloudProjectChoice, parse_cloud_project_choice};
use hosted_cloud::{HostedCloudHandoffInput, run_hosted_cloud_handoff};

const DEFAULT_LOCAL_PROFILE: &str = "local";
const DEFAULT_LOCAL_URL: &str = "http://127.0.0.1:17350";

#[derive(Debug, Args)]
#[command(about = "First-run setup: login, org, project, local link, and optional Core instance")]
pub struct InitOptions {
    /// Cloud project ID or slug; its type selects Hosted Cloud or Connected Local
    #[arg(long)]
    pub project: Option<String>,
    /// Use Hosted Cloud (no Docker / Local Core on this machine)
    #[arg(long, conflicts_with = "local")]
    pub cloud: bool,
    /// Use Connected Local (Docker + OpenAI on this machine)
    #[arg(long, conflicts_with = "cloud")]
    pub local: bool,
    /// Authenticate via OAuth device flow instead of browser login
    #[arg(long)]
    pub device: bool,
    /// Skip starting the local Core Docker instance
    #[arg(long)]
    pub no_instance: bool,
    /// Accept defaults without interactive prompts (non-TTY safe)
    #[arg(long)]
    pub yes: bool,
    /// Local Core bind URL when linking
    #[arg(long)]
    pub local_url: Option<String>,
    /// Profile / link name for the local project
    #[arg(long)]
    pub name: Option<String>,
    /// Replace an existing foreign `atomic-memory` container when starting Core
    #[arg(long)]
    pub replace: bool,
    /// Container image for Core (default: derived from environment; `ATOMICMEMORY_CORE_IMAGE` is read at instance start)
    #[arg(long)]
    pub image: Option<String>,
    /// Skip memory pipeline smoke verification at the end
    #[arg(long)]
    pub skip_verify: bool,
}

pub async fn run(opts: InitOptions, global: &GlobalOptions) -> Result<()> {
    let mut progress = progress_for(global);
    let result = run_with_progress(opts, global, progress.as_mut()).await;
    progress.finish();
    result
}

async fn run_with_progress(
    opts: InitOptions,
    global: &GlobalOptions,
    progress: &mut dyn ProgressReporter,
) -> Result<()> {
    ensure_config_initialized()?;
    let interactive = global.allow_prompts(opts.yes);

    if opts.project.is_none() && !opts.local {
        validate_local_only_options(&opts, InitActivationPath::HostedCloud)?;
    }

    // Surface Cloud URL / Local profile mismatch before the wizard runs.
    resolve_profile_and_warn(global)?;

    let mut actx = ActivationContext::default();
    capture_activation(
        ActivationEvent::InitStarted,
        Some(actx.props()),
        global.no_telemetry,
    );

    let (cloud_api_url, cloud_profile) = resolve_cloud_auth_target(
        global.profile.as_deref(),
        global.base_url.as_deref(),
        global.environment,
    )?;
    let cloud_api_url = cloud_api_url.as_str();

    progress.start_step("identity", "Sign in");
    if let Err(err) = ensure_init_authenticated(InitAuthInput {
        cloud_profile: &cloud_profile,
        cloud_api_url,
        use_device: opts.device,
        allow_prompts: interactive,
        global,
        progress,
        actx: &mut actx,
        no_telemetry: global.no_telemetry,
    })
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

    let signed_in_as = valid_bearer_token(&cloud_profile, cloud_api_url)
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
        interactive,
        Some(cloud_api_url),
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

    let connect_opts = ConnectProjectOptions {
        no_instance: opts.no_instance,
        skip_verify: opts.skip_verify,
        replace: opts.replace,
        instance_image: opts.image.clone(),
        interactive,
    };

    let mut onboarding_ctx = OnboardingContext {
        actx,
        org: org.clone(),
        cloud_profile: cloud_profile.clone(),
        cloud_api_url: cloud_api_url.to_string(),
        signed_in_as: signed_in_as.clone(),
    };

    let mut cloud_global = global.clone();
    cloud_global.profile = Some(cloud_profile.clone());
    cloud_global.base_url = Some(cloud_api_url.to_string());
    let (_profile, client) = dashboard_client(&cloud_global).await?;

    if let Some(project_ref) = opts.project.as_deref() {
        let project = resolve_init_project(&client, project_ref, cloud_api_url).await?;
        let mode = resolve_init_mode(opts.cloud, opts.local, Some(project.kind), None)?;
        validate_local_only_options(&opts, mode)?;
        match mode {
            InitActivationPath::HostedCloud => {
                onboarding_ctx.actx.mode = ActivationContext::cloud().mode;
                return run_hosted_cloud_handoff(HostedCloudHandoffInput {
                    client: &client,
                    cloud_api_url,
                    cloud_profile: &cloud_profile,
                    project: Some(project),
                    interactive,
                    actx: &mut onboarding_ctx.actx,
                    no_telemetry: global.no_telemetry,
                    global,
                    progress,
                })
                .await;
            }
            InitActivationPath::ConnectedLocal => {
                ensure_local_project_for_connect(&project)?;
                onboarding_ctx.actx.mode = ActivationContext::local().mode;
                if !opts.no_instance && !global.quiet {
                    announce_connected_local_prerequisites(interactive);
                }
                return connect_local_project(
                    project,
                    &connect_opts,
                    global,
                    onboarding_ctx,
                    progress,
                )
                .await;
            }
        }
    }

    let interactive_choice =
        if !opts.cloud && !opts.local && interactive && io::stdin().is_terminal() {
            Some(prompt_init_activation_path()?)
        } else {
            None
        };
    let mode = resolve_init_mode(opts.cloud, opts.local, None, interactive_choice)?;
    validate_local_only_options(&opts, mode)?;
    if mode == InitActivationPath::HostedCloud {
        onboarding_ctx.actx.mode = ActivationContext::cloud().mode;
        return run_hosted_cloud_handoff(HostedCloudHandoffInput {
            client: &client,
            cloud_api_url,
            cloud_profile: &cloud_profile,
            project: None,
            interactive,
            actx: &mut onboarding_ctx.actx,
            no_telemetry: global.no_telemetry,
            global,
            progress,
        })
        .await;
    }

    onboarding_ctx.actx.mode = ActivationContext::local().mode;
    let all_projects = client
        .list_projects()
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?;

    if !opts.no_instance && !global.quiet {
        announce_connected_local_prerequisites(interactive);
    }

    let cloud_siblings = cloud_projects(&all_projects);
    if !cloud_siblings.is_empty() && interactive {
        eprintln!(
            "\nNote: you have {} Hosted Cloud project(s) in the console — Connected Local is a separate Local project on this machine.\n",
            cloud_siblings.len()
        );
    }

    if let Some(existing) = pick_local_project(&all_projects, interactive)? {
        return connect_local_project(existing, &connect_opts, global, onboarding_ctx, progress)
            .await;
    }

    run_create_local_project(opts, global, onboarding_ctx, connect_opts, progress).await
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InitActivationPath {
    ConnectedLocal,
    HostedCloud,
}

fn resolve_init_mode(
    cloud: bool,
    local: bool,
    project_kind: Option<ProjectType>,
    interactive_choice: Option<InitActivationPath>,
) -> Result<InitActivationPath> {
    if cloud && local {
        bail!("--cloud and --local cannot be used together");
    }

    if cloud {
        if project_kind == Some(ProjectType::Local) {
            bail!("--cloud cannot be used with a Local project");
        }
        return Ok(InitActivationPath::HostedCloud);
    }
    if local {
        if project_kind == Some(ProjectType::Cloud) {
            bail!("--local cannot be used with a Hosted Cloud project");
        }
        return Ok(InitActivationPath::ConnectedLocal);
    }

    Ok(match project_kind {
        Some(ProjectType::Cloud) => InitActivationPath::HostedCloud,
        Some(ProjectType::Local) => InitActivationPath::ConnectedLocal,
        None => interactive_choice.unwrap_or(InitActivationPath::HostedCloud),
    })
}

fn validate_local_only_options(opts: &InitOptions, mode: InitActivationPath) -> Result<()> {
    if mode == InitActivationPath::ConnectedLocal {
        return Ok(());
    }

    let has_local_only_option = opts.no_instance
        || opts.skip_verify
        || opts.replace
        || opts.image.is_some()
        || opts.local_url.is_some()
        || opts.name.is_some();
    if has_local_only_option {
        bail!(
            "Local-only options require Connected Local; use `am init --local ...` or select a Local project with `--project <id-or-slug>`"
        );
    }
    Ok(())
}

fn unique_init_project_by_ref<'a>(
    projects: &'a [Project],
    id_or_slug: &str,
) -> Result<&'a Project> {
    if let Some(project) = projects.iter().find(|project| project.id == id_or_slug) {
        return Ok(project);
    }

    let matches = projects
        .iter()
        .filter(|project| project.slug.eq_ignore_ascii_case(id_or_slug))
        .collect::<Vec<_>>();
    match matches.as_slice() {
        [] if id_or_slug.eq_ignore_ascii_case(CANONICAL_DEFAULT_PROJECT_SLUG) => {
            find_project_by_default_alias(projects)
                .ok_or_else(|| anyhow::anyhow!("project not found: {id_or_slug}"))
        }
        [] => bail!("project not found: {id_or_slug}"),
        [project] => Ok(project),
        _ => {
            let ids = matches
                .iter()
                .map(|project| project.id.as_str())
                .collect::<Vec<_>>()
                .join(", ");
            bail!(
                "ambiguous project slug '{id_or_slug}' matches multiple projects ({ids}); rerun with the unique project ID"
            )
        }
    }
}

async fn resolve_init_project(
    client: &DashboardClient,
    id_or_slug: &str,
    cloud_api_url: &str,
) -> Result<Project> {
    if id_or_slug.starts_with("proj_") {
        return client.get_project(id_or_slug).await.map_err(|err| {
            anyhow::anyhow!(
                "{err}\nHint: verify the project exists on {cloud_api_url} with `am project list --base-url {cloud_api_url}`."
            )
        });
    }

    let projects = client
        .list_projects()
        .await
        .map_err(|err| anyhow::anyhow!("{err}"))?;
    unique_init_project_by_ref(&projects, id_or_slug)
        .cloned()
        .with_context(|| {
            format!(
                "dashboard API: {cloud_api_url}; run `am project list` on the same profile and --base-url"
            )
        })
}

/// Printed once before Docker / OpenAI work so operators know what to prepare.
fn announce_connected_local_prerequisites(interactive: bool) {
    if interactive {
        eprintln!(
            "\nConnected Local needs Docker running and an OpenAI API key.\n\
             • Docker: https://docs.docker.com/desktop/\n\
             • OpenAI: have your key ready — `am init` prompts with hidden input.\n"
        );
    } else {
        eprintln!(
            "\nConnected Local needs Docker running and OPENAI_API_KEY set in the environment.\n\
             • Docker: https://docs.docker.com/desktop/\n"
        );
    }
}

fn prompt_init_activation_path() -> Result<InitActivationPath> {
    eprintln!();
    eprintln!("How do you want to use AtomicMemory?");
    eprintln!("  1) Hosted Cloud — managed memory (no Docker)");
    eprintln!("  2) Connected Local — Core on this machine (Docker + OpenAI)");
    loop {
        eprint!("Choose [1/2] (default 1): ");
        io::stderr().flush().ok();
        let mut line = String::new();
        io::stdin()
            .read_line(&mut line)
            .context("read init path choice")?;
        match parse_init_activation_path_choice(line.trim()) {
            Ok(choice) => return Ok(choice),
            Err(err) => eprintln!("{err}"),
        }
    }
}

fn parse_init_activation_path_choice(choice: &str) -> Result<InitActivationPath> {
    match choice {
        "" | "1" => Ok(InitActivationPath::HostedCloud),
        "2" => Ok(InitActivationPath::ConnectedLocal),
        other => bail!("Enter 1 or 2, not '{other}'."),
    }
}

struct InitAuthInput<'a> {
    cloud_profile: &'a str,
    cloud_api_url: &'a str,
    use_device: bool,
    allow_prompts: bool,
    global: &'a GlobalOptions,
    progress: &'a mut dyn ProgressReporter,
    actx: &'a mut ActivationContext,
    no_telemetry: bool,
}

/// Whether `am init` can actually complete a sign-in, rather than stall.
///
/// Browser OAuth waits on a loopback callback for two minutes. With stdin not a
/// terminal there is nobody to approve it, so a piped or CI `am init` sat for
/// the full timeout and then failed. `--yes` was already fail-closed; the same
/// reasoning applies whenever there is no terminal. The device flow prints a
/// code to enter elsewhere, so it stays allowed on explicit opt-in.
fn may_run_init_login(allow_prompts: bool, use_device: bool, stdin_is_tty: bool) -> bool {
    allow_prompts && (use_device || stdin_is_tty)
}

async fn ensure_init_authenticated(input: InitAuthInput<'_>) -> Result<()> {
    let InitAuthInput {
        cloud_profile,
        cloud_api_url,
        use_device,
        allow_prompts,
        global,
        progress,
        actx,
        no_telemetry,
    } = input;
    let token_result = valid_bearer_token(cloud_profile, cloud_api_url).await;
    let needs_login = token_result.is_err();
    let needs_org_refresh = token_result
        .as_ref()
        .ok()
        .is_some_and(|t| !token_has_active_org(t));

    if !needs_login && !needs_org_refresh {
        progress.succeed("identity", Some("existing session"));
        return Ok(());
    }

    if !may_run_init_login(allow_prompts, use_device, io::stdin().is_terminal()) {
        bail!(
            "sign-in required — run `am auth login --token <dashboard-jwt>` first, \
             or `am init --device` to sign in with a device code. Browser sign-in \
             needs an interactive terminal, and --yes never opens one."
        );
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
        progress.tick(
            "identity",
            if needs_login {
                "browser OAuth"
            } else {
                "refreshing org scope"
            },
        );
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
                fresh_login: needs_org_refresh,
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

async fn run_create_local_project(
    opts: InitOptions,
    global: &GlobalOptions,
    mut onboarding_ctx: OnboardingContext,
    connect_opts: ConnectProjectOptions,
    progress: &mut dyn ProgressReporter,
) -> Result<()> {
    let org = onboarding_ctx.org.clone();
    let cloud_profile = onboarding_ctx.cloud_profile.clone();
    let cloud_api_url = onboarding_ctx.cloud_api_url.clone();
    let actx = &mut onboarding_ctx.actx;

    let local_profile = opts
        .name
        .clone()
        .unwrap_or_else(|| DEFAULT_LOCAL_PROFILE.to_string());
    let local_url = opts
        .local_url
        .clone()
        .unwrap_or_else(|| DEFAULT_LOCAL_URL.to_string());

    // Link/create first; connect_local_project owns the progressive "project" step.
    //
    // A profile can exist WITHOUT a project id — a prior `am init` that died
    // between profile write and project link leaves exactly that state. Reusing
    // it as-is would push an empty project id into `create_api_key` and fail
    // with a confusing API error, so a profile only short-circuits the link
    // when it actually carries a project id; otherwise re-running init heals it
    // through the same link path as a fresh run (link_local finds or creates
    // the cloud project and rewrites the profile).
    let existing_project_id = load_config()?
        .profiles
        .get(&local_profile)
        .and_then(|p| p.project_id.clone())
        .filter(|id| !id.is_empty());

    let project = if let Some(project_id) = existing_project_id {
        update_config(|cfg| {
            let entry = cfg
                .profiles
                .entry(local_profile.clone())
                .or_insert_with(|| ProfileConfig {
                    kind: ProfileKind::Local,
                    ..Default::default()
                });
            entry.kind = ProfileKind::Local;
            entry.local_url = Some(local_url.clone());
            if entry.oauth_ref.is_none() {
                entry.oauth_ref = Some(cloud_profile.clone());
            }
            cfg.default_profile = Some(local_profile.clone());
            Ok(())
        })?;
        Project {
            id: project_id,
            org_id: org.id.clone(),
            name: local_profile.clone(),
            slug: local_profile.clone(),
            environment: "dev".into(),
            kind: am_cloud_types::ProjectType::Local,
            local_url: Some(local_url.clone()),
            privacy_mode: am_cloud_types::PrivacyMode::Connect,
            created_at: chrono::Utc::now(),
            memory_count: None,
            last_activity_at: None,
        }
    } else {
        let mut link_global = global.clone();
        link_global.profile = Some(cloud_profile.clone());
        link_global.base_url = Some(cloud_api_url.clone());
        match link_local(
            &link_global,
            LinkLocalRequest {
                org_id: Some(org.id.clone()),
                name: local_profile.clone(),
                local_url: local_url.clone(),
                environment: "dev".into(),
                key: None,
                profile_name: Some(local_profile.clone()),
            },
            LinkLocalOptions { summary_only: true },
        )
        .await
        {
            Ok(project) => project,
            Err(err) => {
                capture_step_failure(
                    InitStep::ProjectLink,
                    &err,
                    Some(actx.props()),
                    global.no_telemetry,
                );
                return Err(err);
            }
        }
    };

    connect_local_project(project, &connect_opts, global, onboarding_ctx, progress).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::Cli;
    use am_cloud_types::{PrivacyMode, ProjectType};
    use chrono::Utc;
    use clap::Parser;

    fn project(id: &str, slug: &str, kind: ProjectType) -> Project {
        Project {
            id: id.into(),
            org_id: "org_a".into(),
            name: slug.into(),
            slug: slug.into(),
            environment: "dev".into(),
            kind,
            local_url: None,
            privacy_mode: PrivacyMode::Connect,
            created_at: Utc::now(),
            memory_count: None,
            last_activity_at: None,
        }
    }

    #[test]
    fn init_project_flag_parses() {
        let cli = Cli::try_parse_from(["am", "init", "--project", "my-local"]).unwrap();
        match cli.command {
            crate::cli::Command::Init(InitOptions { project, .. }) => {
                assert_eq!(project.as_deref(), Some("my-local"));
            }
            _ => panic!("expected init --project"),
        }
    }

    #[test]
    fn init_device_flag_parses() {
        let cli = Cli::try_parse_from(["am", "init", "--project", "my-local", "--device"]).unwrap();
        match cli.command {
            crate::cli::Command::Init(InitOptions {
                project, device, ..
            }) => {
                assert_eq!(project.as_deref(), Some("my-local"));
                assert!(device);
            }
            _ => panic!("expected init --device"),
        }
    }

    #[test]
    fn init_cloud_flag_parses() {
        let cli = Cli::try_parse_from(["am", "init", "--cloud"]).unwrap();
        match cli.command {
            crate::cli::Command::Init(InitOptions { cloud, .. }) => {
                assert!(cloud);
            }
            _ => panic!("expected init --cloud"),
        }
    }

    #[test]
    fn init_local_flag_parses_and_conflicts_with_cloud() {
        let cli = Cli::try_parse_from(["am", "init", "--local"]).unwrap();
        match cli.command {
            crate::cli::Command::Init(InitOptions { local, .. }) => assert!(local),
            _ => panic!("expected init --local"),
        }
        assert!(Cli::try_parse_from(["am", "init", "--cloud", "--local"]).is_err());
    }

    #[test]
    fn init_mode_defaults_cloud_and_infers_project_kind() {
        assert_eq!(
            resolve_init_mode(false, false, None, None).unwrap(),
            InitActivationPath::HostedCloud
        );
        assert_eq!(
            resolve_init_mode(false, false, Some(ProjectType::Local), None).unwrap(),
            InitActivationPath::ConnectedLocal
        );
        assert_eq!(
            resolve_init_mode(false, false, Some(ProjectType::Cloud), None).unwrap(),
            InitActivationPath::HostedCloud
        );
    }

    #[test]
    fn explicit_init_mode_rejects_project_type_mismatch() {
        let cloud_local =
            resolve_init_mode(true, false, Some(ProjectType::Local), None).unwrap_err();
        assert!(cloud_local.to_string().contains("Local project"));

        let local_cloud =
            resolve_init_mode(false, true, Some(ProjectType::Cloud), None).unwrap_err();
        assert!(local_cloud.to_string().contains("Hosted Cloud"));
    }

    #[test]
    fn blank_activation_choice_defaults_to_hosted_cloud() {
        assert_eq!(
            parse_init_activation_path_choice("").unwrap(),
            InitActivationPath::HostedCloud
        );
        assert_eq!(
            parse_init_activation_path_choice("2").unwrap(),
            InitActivationPath::ConnectedLocal
        );
    }

    #[test]
    fn project_slug_resolution_rejects_ambiguous_kinds() {
        let projects = vec![
            project("proj_cloud", "test", ProjectType::Cloud),
            project("proj_local", "test", ProjectType::Local),
        ];
        let err = unique_init_project_by_ref(&projects, "TEST")
            .unwrap_err()
            .to_string();
        assert!(err.contains("ambiguous project slug"));
        assert!(err.contains("project ID"));
    }

    #[test]
    fn project_id_resolution_remains_unambiguous() {
        let projects = vec![
            project("proj_cloud", "test", ProjectType::Cloud),
            project("proj_local", "test", ProjectType::Local),
        ];
        let selected = unique_init_project_by_ref(&projects, "proj_local").unwrap();
        assert_eq!(selected.kind, ProjectType::Local);
    }

    #[test]
    fn default_project_alias_keeps_legacy_slug_support() {
        let projects = vec![project(
            "proj_legacy",
            am_cloud_types::LEGACY_DEFAULT_PROJECT_SLUG,
            ProjectType::Local,
        )];
        let selected =
            unique_init_project_by_ref(&projects, am_cloud_types::CANONICAL_DEFAULT_PROJECT_SLUG)
                .unwrap();
        assert_eq!(selected.id, "proj_legacy");
    }

    #[test]
    fn local_only_flags_are_validated_after_project_type_resolution() {
        let cli = Cli::try_parse_from([
            "am",
            "init",
            "--project",
            "test",
            "--no-instance",
            "--name",
            "test-local",
        ])
        .unwrap();
        let crate::cli::Command::Init(opts) = cli.command else {
            panic!("expected init command");
        };

        assert!(
            validate_local_only_options(&opts, InitActivationPath::HostedCloud)
                .unwrap_err()
                .to_string()
                .contains("Connected Local")
        );
        validate_local_only_options(&opts, InitActivationPath::ConnectedLocal).unwrap();
    }

    #[test]
    fn local_string_defaults_are_applied_only_by_local_routing() {
        let cli = Cli::try_parse_from(["am", "init"]).unwrap();
        let crate::cli::Command::Init(opts) = cli.command else {
            panic!("expected init command");
        };
        assert!(opts.name.is_none());
        assert!(opts.local_url.is_none());
    }

    #[test]
    fn init_cloud_allows_core_image_env() {
        let exe = std::env::current_exe().expect("test binary path");
        let output = std::process::Command::new(&exe)
            .env("ATOMICMEMORY_CORE_IMAGE", "ghcr.io/example/core:1")
            .args(["init", "--cloud"])
            .output()
            .expect("spawn am init --cloud with core image env");
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            !stderr.contains("cannot be used with"),
            "ATOMICMEMORY_CORE_IMAGE must not bind to --image (clap conflict): {stderr}"
        );
        if let Some(2) = output.status.code() {
            panic!("clap rejected init --cloud with core image env set: {stderr}");
        }
    }

    #[test]
    fn browser_login_needs_a_terminal_but_device_login_does_not() {
        // Browser OAuth waits two minutes on a loopback callback; with no
        // terminal nobody can approve it, so bare `am init` in CI used to stall
        // for the full timeout instead of failing with guidance.
        assert!(!may_run_init_login(true, false, false));
        assert!(may_run_init_login(true, false, true));
        // --device prints a code to redeem elsewhere, so a pipe is fine.
        assert!(may_run_init_login(true, true, false));
        // --yes / --quiet / -o json stay fail-closed regardless of the terminal.
        assert!(!may_run_init_login(false, true, true));
        assert!(!may_run_init_login(false, false, true));
    }

    #[test]
    fn parse_cloud_project_choice_rejects_blank_and_eof() {
        assert_eq!(
            parse_cloud_project_choice("", 1, 3).unwrap(),
            CloudProjectChoice::Reprompt
        );
        assert_eq!(
            parse_cloud_project_choice("", 0, 3).unwrap(),
            CloudProjectChoice::Eof
        );
        assert_eq!(
            parse_cloud_project_choice("2", 2, 3).unwrap(),
            CloudProjectChoice::Selected(1)
        );
        assert_eq!(
            parse_cloud_project_choice("9", 2, 3).unwrap(),
            CloudProjectChoice::Reprompt
        );
    }

    #[test]
    fn hosted_cloud_target_policy_never_picks_first_api_row() {
        use am_cloud_types::{PrivacyMode, ProjectType};
        use chrono::Utc;

        let first = Project {
            id: "proj_a".into(),
            org_id: "org_a".into(),
            name: "first".into(),
            slug: "first".into(),
            environment: "dev".into(),
            kind: ProjectType::Cloud,
            local_url: None,
            privacy_mode: PrivacyMode::Connect,
            created_at: Utc::now(),
            memory_count: None,
            last_activity_at: None,
        };
        let second = Project {
            id: "proj_b".into(),
            org_id: "org_a".into(),
            name: "second".into(),
            slug: "second".into(),
            environment: "dev".into(),
            kind: ProjectType::Cloud,
            local_url: None,
            privacy_mode: PrivacyMode::Connect,
            created_at: Utc::now(),
            memory_count: None,
            last_activity_at: None,
        };
        let clouds = vec![&first, &second];
        assert!(matches!(
            hosted_cloud_target_policy(&clouds, false, true),
            HostedCloudTarget::ProjectsDashboard
        ));
        assert!(matches!(
            hosted_cloud_target_policy(&clouds, true, false),
            HostedCloudTarget::ProjectsDashboard
        ));
        assert!(matches!(
            hosted_cloud_target_policy(&clouds, true, true),
            HostedCloudTarget::Prompt
        ));
        assert!(matches!(
            hosted_cloud_target_policy(&[], false, false),
            HostedCloudTarget::OnboardingDashboard
        ));
    }

    #[test]
    fn activation_context_omits_mode_until_assigned() {
        let early = ActivationContext::default();
        assert!(!early.props().contains_key("mode"));
        let cloud = ActivationContext::cloud();
        assert_eq!(
            cloud.props().get("mode").and_then(|v| v.as_str()),
            Some("cloud")
        );
    }

    #[test]
    fn hosted_cloud_handoff_context_carries_cloud_mode_and_project() {
        let actx = ActivationContext {
            org_id: Some("org_a".into()),
            project_id: Some("proj_cloud".into()),
            mode: ActivationContext::cloud().mode,
            email_hash: None,
        };
        let props = actx.props();
        assert_eq!(props.get("mode").and_then(|v| v.as_str()), Some("cloud"));
        assert_eq!(
            props.get("project_id").and_then(|v| v.as_str()),
            Some("proj_cloud")
        );
    }

    #[test]
    fn ensure_cloud_project_for_handoff_rejects_local() {
        use am_cloud_types::{PrivacyMode, ProjectType};
        use chrono::Utc;

        let local = Project {
            id: "proj_local".into(),
            org_id: "org_a".into(),
            name: "local-dev".into(),
            slug: "local-dev".into(),
            environment: "dev".into(),
            kind: ProjectType::Local,
            local_url: Some("http://127.0.0.1:17350".into()),
            privacy_mode: PrivacyMode::Connect,
            created_at: Utc::now(),
            memory_count: None,
            last_activity_at: None,
        };
        let err = ensure_cloud_project_for_handoff(&local)
            .unwrap_err()
            .to_string();
        assert!(err.contains("Local project"));
    }

    #[test]
    fn ensure_local_project_for_connect_rejects_cloud() {
        use am_cloud_types::{PrivacyMode, ProjectType};
        use chrono::Utc;

        let cloud = Project {
            id: "proj_cloud".into(),
            org_id: "org_a".into(),
            name: "rapid-walrus".into(),
            slug: "rapid-walrus".into(),
            environment: "dev".into(),
            kind: ProjectType::Cloud,
            local_url: None,
            privacy_mode: PrivacyMode::Connect,
            created_at: Utc::now(),
            memory_count: None,
            last_activity_at: None,
        };
        let err = crate::commands::connect_project::ensure_local_project_for_connect(&cloud)
            .unwrap_err()
            .to_string();
        assert!(err.contains("Hosted Cloud"));
        assert!(err.contains("am init --cloud"));
    }
}
