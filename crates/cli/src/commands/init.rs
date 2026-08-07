//! First-run wizard: login → org → project → local link → optional Core instance.

use anyhow::Result;
use clap::Args;

use crate::auth::claims::{decode_id_token, token_has_active_org};
use crate::auth::device_login::{DeviceLoginOptions, run_device_login};
use crate::auth::ensure_org::{EnsureOrgOptions, ensure_org_context};
use crate::auth::login::{LoginOptions, run_login};
use crate::auth::token::valid_bearer_token;
use crate::cli::GlobalOptions;
use crate::commands::client::dashboard_client;
use crate::commands::connect_project::{
    ConnectProjectOptions, OnboardingContext, connect_local_project, pick_local_project,
    resolve_project,
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
use am_cloud_types::Project;

#[derive(Debug, Args)]
#[command(about = "First-run setup: login, org, project, local link, and optional Core instance")]
pub struct InitOptions {
    /// Cloud project id or slug — connect to an existing dashboard local project
    #[arg(long)]
    pub project: Option<String>,
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
    #[arg(long, default_value = "http://127.0.0.1:17350")]
    pub local_url: String,
    /// Profile / link name for the local project
    #[arg(long, default_value = "local")]
    pub name: String,
    /// Replace an existing foreign `atomic-memory` container when starting Core
    #[arg(long)]
    pub replace: bool,
    /// Container image for Core (default: derived from environment)
    #[arg(long, env = "ATOMICMEMORY_CORE_IMAGE")]
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
    let interactive = !global.quiet && !opts.yes;

    let mut actx = ActivationContext::local();
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
    if let Err(err) = ensure_init_authenticated(
        &cloud_profile,
        cloud_api_url,
        opts.device,
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
    };

    let onboarding_ctx = OnboardingContext {
        actx,
        org: org.clone(),
        cloud_profile: cloud_profile.clone(),
        cloud_api_url: cloud_api_url.to_string(),
        signed_in_as: signed_in_as.clone(),
    };

    if let Some(project_ref) = opts.project.as_deref() {
        let mut cloud_global = global.clone();
        cloud_global.profile = Some(cloud_profile.clone());
        cloud_global.base_url = Some(cloud_api_url.to_string());
        let (_profile, client) = dashboard_client(&cloud_global).await?;
        let project = resolve_project(&client, project_ref, cloud_api_url).await?;
        return connect_local_project(project, &connect_opts, global, onboarding_ctx, progress)
            .await;
    }

    let mut cloud_global = global.clone();
    cloud_global.profile = Some(cloud_profile.clone());
    cloud_global.base_url = Some(cloud_api_url.to_string());
    let (_profile, client) = dashboard_client(&cloud_global).await?;
    let all_projects = client
        .list_projects()
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?;

    if let Some(existing) = pick_local_project(&all_projects, interactive)? {
        return connect_local_project(existing, &connect_opts, global, onboarding_ctx, progress)
            .await;
    }

    run_create_local_project(opts, global, onboarding_ctx, connect_opts, progress).await
}

async fn ensure_init_authenticated(
    cloud_profile: &str,
    cloud_api_url: &str,
    use_device: bool,
    global: &GlobalOptions,
    progress: &mut dyn ProgressReporter,
    actx: &mut ActivationContext,
    no_telemetry: bool,
) -> Result<()> {
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

    let local_profile = opts.name.clone();
    let local_url = opts.local_url.clone();

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
                name: opts.name.clone(),
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
    use clap::Parser;

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
}
