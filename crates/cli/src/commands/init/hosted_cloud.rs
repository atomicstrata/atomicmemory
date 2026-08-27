//! Hosted Cloud project selection, credential provisioning, and profile activation.

use std::io::{self, IsTerminal, Write as _};
use std::time::Duration;

use am_cloud_client::{CloudClientError, DashboardClient, MemoryClient};
use am_cloud_types::{ApiKey, ApiKeyWithSecret, CreateApiKeyRequest, Project};
use anyhow::{Context, Result, bail};
use url::Url;

use crate::auth::origin::same_origin;
use crate::cli::GlobalOptions;
use crate::commands::cloud_api_key::{is_api_key_quota_exceeded, select_named_key_for_rotate};
use crate::commands::connect_project::{
    HostedCloudTarget, cloud_projects, ensure_cloud_project_for_handoff, hosted_cloud_target_policy,
};
use crate::config::{
    ENV_API_KEY, ENV_API_KEY_FORCE, activate_hosted_cloud_profile,
    ensure_hosted_cloud_profile_available, load_config, load_credentials, machine_scoped_key_name,
    store_hosted_cloud_api_key,
};
use crate::environment::{
    dashboard_onboarding_url, dashboard_project_url, dashboard_projects_url,
    is_remote_cloud_api_url,
};
use crate::progress::{ProgressReporter, with_progress_paused_for_input};
use crate::telemetry::{ActivationContext, ActivationEvent, capture_activation};

const HOSTED_PROJECT_POLL_INTERVAL: Duration = Duration::from_secs(2);
const HOSTED_PROJECT_POLL_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const HOSTED_CLI_KEY_NAME: &str = "am-cli";

#[async_trait::async_trait]
trait HostedCloudBackend: Send + Sync {
    async fn list_projects(&self) -> Result<Vec<Project>, CloudClientError>;
}

#[async_trait::async_trait]
impl HostedCloudBackend for DashboardClient {
    async fn list_projects(&self) -> Result<Vec<Project>, CloudClientError> {
        DashboardClient::list_projects(self).await
    }
}

#[async_trait::async_trait]
trait HostedCredentialBackend: Send + Sync {
    async fn list_api_keys(&self, project_id: &str) -> Result<Vec<ApiKey>, CloudClientError>;

    async fn rotate_api_key(
        &self,
        project_id: &str,
        key_id: &str,
    ) -> Result<ApiKeyWithSecret, CloudClientError>;

    async fn create_api_key(
        &self,
        project_id: &str,
        request: &CreateApiKeyRequest,
    ) -> Result<ApiKeyWithSecret, CloudClientError>;

    async fn revoke_api_key(&self, project_id: &str, key_id: &str) -> Result<(), CloudClientError>;
}

#[async_trait::async_trait]
impl HostedCredentialBackend for DashboardClient {
    async fn list_api_keys(&self, project_id: &str) -> Result<Vec<ApiKey>, CloudClientError> {
        DashboardClient::list_api_keys(self, project_id).await
    }

    async fn rotate_api_key(
        &self,
        project_id: &str,
        key_id: &str,
    ) -> Result<ApiKeyWithSecret, CloudClientError> {
        DashboardClient::rotate_api_key(self, project_id, key_id).await
    }

    async fn create_api_key(
        &self,
        project_id: &str,
        request: &CreateApiKeyRequest,
    ) -> Result<ApiKeyWithSecret, CloudClientError> {
        DashboardClient::create_api_key(self, project_id, request).await
    }

    async fn revoke_api_key(&self, project_id: &str, key_id: &str) -> Result<(), CloudClientError> {
        DashboardClient::revoke_api_key(self, project_id, key_id).await
    }
}

#[async_trait::async_trait]
trait HostedCredentialProbe: Send + Sync {
    async fn health(&self, api_origin: &str, secret: &str) -> Result<(), CloudClientError>;
}

struct MemoryHealthProbe;

#[async_trait::async_trait]
impl HostedCredentialProbe for MemoryHealthProbe {
    async fn health(&self, api_origin: &str, secret: &str) -> Result<(), CloudClientError> {
        let base_url = Url::parse(api_origin)?;
        MemoryClient::new(base_url, secret)?
            .health()
            .await
            .map(|_| ())
    }
}

enum HostedCredentialOutcome {
    Reused,
    Rotated { key_id: String, secret: String },
    Created { key_id: String, secret: String },
}

#[derive(Debug, thiserror::Error)]
enum HostedCredentialError {
    #[error("Hosted Cloud API key quota exceeded: {0}")]
    Quota(CloudClientError),
    #[error(transparent)]
    Other(#[from] anyhow::Error),
}

fn hosted_cloud_credential_ref(project_id: &str) -> String {
    format!("hosted-cloud-{project_id}")
}

async fn provision_hosted_cloud_key(
    backend: &dyn HostedCredentialBackend,
    probe: &dyn HostedCredentialProbe,
    api_origin: &str,
    project_id: &str,
    stored: Option<&crate::config::ApiKeySecret>,
    // Resolved by the caller so this stays free of config I/O.
    key_name: &str,
) -> std::result::Result<HostedCredentialOutcome, HostedCredentialError> {
    if let Some(stored) = stored.filter(|stored| {
        stored
            .api_origin
            .as_deref()
            .is_some_and(|origin| same_origin(origin, api_origin))
            && stored.project_id.as_deref() == Some(project_id)
    }) {
        match probe.health(api_origin, &stored.secret).await {
            Ok(()) => return Ok(HostedCredentialOutcome::Reused),
            Err(CloudClientError::Auth) => {}
            Err(err) => {
                return Err(anyhow::anyhow!(
                    "could not verify the stored Hosted Cloud credential: {err}"
                )
                .into());
            }
        }
    }

    let keys = backend
        .list_api_keys(project_id)
        .await
        .context("list Hosted Cloud API keys")?;
    let (provisioned, was_created) =
        if let Some(existing) = select_named_key_for_rotate(&keys, key_name) {
            let rotated = backend
                .rotate_api_key(project_id, &existing.id)
                .await
                .with_context(|| {
                    format!("rotate Hosted Cloud API key '{key_name}' ({})", existing.id)
                })?;
            (rotated, false)
        } else {
            let created = backend
                .create_api_key(
                    project_id,
                    &CreateApiKeyRequest {
                        name: key_name.to_string(),
                        environment: None,
                    },
                )
                .await
                .map_err(|err| {
                    if is_api_key_quota_exceeded(&err) {
                        HostedCredentialError::Quota(err)
                    } else {
                        HostedCredentialError::Other(anyhow::anyhow!(
                            "create Hosted Cloud API key '{key_name}': {err}"
                        ))
                    }
                })?;
            (created, true)
        };

    if provisioned.key.project_id != project_id {
        return Err(if was_created {
            rollback_invalid_hosted_key(
                backend,
                project_id,
                &provisioned.key.id,
                "project mismatch",
            )
            .await
        } else {
            anyhow::anyhow!(
                "rotated Hosted Cloud API key failed validation (project mismatch); no key was revoked"
            )
            .into()
        });
    }
    if let Err(err) = probe.health(api_origin, &provisioned.secret).await {
        return Err(if was_created {
            rollback_invalid_hosted_key(backend, project_id, &provisioned.key.id, &err.to_string())
                .await
        } else {
            anyhow::anyhow!(
                "rotated Hosted Cloud API key failed validation ({}); no key was revoked",
                redact_secret(&err.to_string(), &provisioned.secret)
            )
            .into()
        });
    }

    if was_created {
        Ok(HostedCredentialOutcome::Created {
            key_id: provisioned.key.id,
            secret: provisioned.secret,
        })
    } else {
        Ok(HostedCredentialOutcome::Rotated {
            key_id: provisioned.key.id,
            secret: provisioned.secret,
        })
    }
}

async fn rollback_invalid_hosted_key(
    backend: &dyn HostedCredentialBackend,
    project_id: &str,
    key_id: &str,
    validation_error: &str,
) -> HostedCredentialError {
    match backend.revoke_api_key(project_id, key_id).await {
        Ok(()) => anyhow::anyhow!(
            "new Hosted Cloud API key failed validation ({validation_error}); revoked newly created key {key_id}"
        )
        .into(),
        Err(rollback_error) => anyhow::anyhow!(
            "new Hosted Cloud API key failed validation ({validation_error}); cleanup of newly created key {key_id} also failed: {rollback_error}"
        )
        .into(),
    }
}

/// Persist a freshly created key, giving it back to the server if the write fails.
///
/// The secret returned by `create_api_key` is never retrievable again, so a
/// failed write leaves a live key on the project that nothing can use and
/// nothing will clean up. Every retry mints another one until the project hits
/// its key quota. `store` is a closure so this decision stays testable without
/// touching the real credentials file.
async fn persist_hosted_key_or_rollback<F>(
    backend: &dyn HostedCredentialBackend,
    project_id: &str,
    key_id: &str,
    secret: &str,
    store: F,
) -> std::result::Result<(), HostedCredentialError>
where
    F: FnOnce() -> Result<()>,
{
    match store() {
        Ok(()) => Ok(()),
        Err(err) => Err(rollback_unpersisted_hosted_key(
            backend,
            project_id,
            key_id,
            // The writer quotes what it was given; never let that reach a message.
            &redact_secret(&err.to_string(), secret),
        )
        .await),
    }
}

/// Persist a rotated singleton without revoking it if the local write fails.
///
/// Rotation has already invalidated the previous secret. Revoking the rotated
/// key would remove the singleton entirely, so recovery is another targeted
/// init after the local write problem is fixed.
fn persist_rotated_hosted_key<F>(
    project_id: &str,
    key_id: &str,
    secret: &str,
    store: F,
) -> Result<()>
where
    F: FnOnce() -> Result<()>,
{
    store().map_err(|err| {
        anyhow::anyhow!(
            "rotated Hosted Cloud API key {key_id}, but could not save its credential ({}); run `am init --project {project_id}` again",
            redact_secret(&err.to_string(), secret)
        )
    })
}

async fn rollback_unpersisted_hosted_key(
    backend: &dyn HostedCredentialBackend,
    project_id: &str,
    key_id: &str,
    store_error: &str,
) -> HostedCredentialError {
    match backend.revoke_api_key(project_id, key_id).await {
        Ok(()) => anyhow::anyhow!(
            "could not save the new Hosted Cloud API key ({store_error}); revoked newly created key {key_id}"
        )
        .into(),
        Err(rollback_error) => anyhow::anyhow!(
            "could not save the new Hosted Cloud API key ({store_error}); cleanup of newly created key {key_id} also failed: {rollback_error} — revoke it in the dashboard"
        )
        .into(),
    }
}

/// Replace any occurrence of a secret in text that is about to be shown.
///
/// Errors from the credential writer quote paths and, depending on the backend,
/// can quote the value being serialized. Nothing downstream should have to
/// reason about which ones do.
fn redact_secret(text: &str, secret: &str) -> String {
    if secret.is_empty() {
        return text.to_string();
    }
    text.replace(secret, "«redacted»")
}

pub(super) struct HostedCloudHandoffInput<'a> {
    pub(super) client: &'a DashboardClient,
    pub(super) cloud_api_url: &'a str,
    pub(super) cloud_profile: &'a str,
    pub(super) project: Option<Project>,
    pub(super) interactive: bool,
    pub(super) actx: &'a mut ActivationContext,
    pub(super) no_telemetry: bool,
    pub(super) global: &'a GlobalOptions,
    pub(super) progress: &'a mut dyn ProgressReporter,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HostedHandoffUrl {
    Project,
    Onboarding,
    ProjectsList,
}

pub(super) async fn run_hosted_cloud_handoff(input: HostedCloudHandoffInput<'_>) -> Result<()> {
    let HostedCloudHandoffInput {
        client,
        cloud_api_url,
        cloud_profile,
        project,
        interactive,
        actx,
        no_telemetry,
        global,
        progress,
    } = input;
    progress.start_step("project", "Hosted Cloud");

    let project_explicit = project.is_some();
    let (mut target, handoff_url) = if let Some(project) = project {
        ensure_cloud_project_for_handoff(&project)?;
        (Some(project), HostedHandoffUrl::Project)
    } else {
        select_hosted_cloud_target(client, interactive, progress).await?
    };

    let dashboard_url = hosted_cloud_url(cloud_api_url, target.as_ref(), handoff_url)?;
    actx.mode = ActivationContext::cloud().mode;
    if let Some(project) = target.as_ref() {
        actx.project_id = Some(project.id.clone());
    }
    capture_activation(
        ActivationEvent::HostedCloudHandoff,
        Some(actx.props()),
        no_telemetry,
    );

    if !global.quiet && handoff_url != HostedHandoffUrl::Project {
        eprintln!("\nHosted Cloud runs in the browser — no Docker required on this path.");
        eprintln!("Dashboard: {dashboard_url}");
    }
    let stdin_is_tty = io::stdin().is_terminal();
    let may_wait = may_wait_for_onboarding(interactive, stdin_is_tty);
    if should_open_handoff_browser(handoff_url, interactive, stdin_is_tty, global.quiet) {
        if let Err(err) = open::that(&dashboard_url) {
            eprintln!("Could not open a browser ({err}). Open the URL above manually.");
        } else {
            eprintln!("Opened the dashboard in your browser.");
        }
    }

    if target.is_none() {
        match handoff_url {
            HostedHandoffUrl::Onboarding if may_wait => {
                progress.tick("project", "waiting for project creation");
                let projects = poll_for_cloud_projects(
                    client,
                    HOSTED_PROJECT_POLL_INTERVAL,
                    HOSTED_PROJECT_POLL_TIMEOUT,
                )
                .await
                .inspect_err(|err| progress.fail("project", Some(&err.to_string())))?;
                let project = select_polled_cloud_project(&projects, progress)?;
                actx.project_id = Some(project.id.clone());
                target = Some(project);
            }
            HostedHandoffUrl::Onboarding => {
                let error = unattended_onboarding_error(&dashboard_url);
                progress.fail("project", Some(&error.to_string()));
                return Err(error);
            }
            HostedHandoffUrl::ProjectsList => {
                let error = unattended_project_selection_error(&dashboard_url);
                progress.fail("project", Some(&error.to_string()));
                return Err(error);
            }
            HostedHandoffUrl::Project => unreachable!("project handoff always has a target"),
        }
    }

    let project = target.ok_or_else(|| anyhow::anyhow!("Hosted Cloud project is required"))?;
    progress.succeed(
        "project",
        Some(&format!("{} ({})", project.name, project.slug)),
    );
    configure_hosted_cloud(ConfigureHostedCloudInput {
        backend: client,
        probe: &MemoryHealthProbe,
        cloud_api_url,
        cloud_profile,
        project: &project,
        interactive,
        project_explicit,
        actx,
        no_telemetry,
        global,
        progress,
    })
    .await
}

fn may_wait_for_onboarding(interactive: bool, stdin_is_tty: bool) -> bool {
    interactive && stdin_is_tty
}

fn should_open_handoff_browser(
    handoff_url: HostedHandoffUrl,
    interactive: bool,
    stdin_is_tty: bool,
    quiet: bool,
) -> bool {
    handoff_url != HostedHandoffUrl::Project && interactive && stdin_is_tty && !quiet
}

struct ConfigureHostedCloudInput<'a> {
    backend: &'a dyn HostedCredentialBackend,
    probe: &'a dyn HostedCredentialProbe,
    cloud_api_url: &'a str,
    cloud_profile: &'a str,
    project: &'a Project,
    interactive: bool,
    project_explicit: bool,
    actx: &'a mut ActivationContext,
    no_telemetry: bool,
    global: &'a GlobalOptions,
    progress: &'a mut dyn ProgressReporter,
}

async fn configure_hosted_cloud(input: ConfigureHostedCloudInput<'_>) -> Result<()> {
    let ConfigureHostedCloudInput {
        backend,
        probe,
        cloud_api_url,
        cloud_profile,
        project,
        interactive,
        project_explicit,
        actx,
        no_telemetry,
        global,
        progress,
    } = input;
    ensure_hosted_cloud_profile_available(cloud_profile)?;
    if let Some(previous_project_id) =
        hosted_profile_project_change(&load_config()?, cloud_profile, &project.id)
    {
        if !global.quiet {
            eprintln!(
                "Profile '{cloud_profile}' will switch from project '{previous_project_id}' to '{}' and become the default profile.",
                project.id
            );
        }
        let stdin_is_tty = io::stdin().is_terminal();
        if requires_project_switch_confirmation(true, interactive, stdin_is_tty, project_explicit)
            && !with_progress_paused_for_input(progress, true, || {
                confirm_hosted_project_switch(cloud_profile, &previous_project_id, &project.id)
            })?
        {
            bail!(
                "Hosted Cloud project switch cancelled before credentials or profile configuration changed"
            );
        }
    }
    let credential_ref = hosted_cloud_credential_ref(&project.id);
    let stored = load_credentials()?.api_keys.get(&credential_ref).cloned();

    // Scoped to this install: rotation invalidates the old secret, so a
    // project-wide name would let this machine rotate a key another machine is
    // actively using.
    let key_name = machine_scoped_key_name(HOSTED_CLI_KEY_NAME)?;

    progress.start_step("credential", "Hosted Cloud API key");
    let outcome = match provision_hosted_cloud_key(
        backend,
        probe,
        cloud_api_url,
        &project.id,
        stored.as_ref(),
        &key_name,
    )
    .await
    {
        Ok(outcome) => outcome,
        Err(HostedCredentialError::Quota(err)) => {
            progress.fail("credential", Some("API key quota exceeded"));
            return Err(hosted_quota_error(
                cloud_api_url,
                &project.id,
                interactive,
                global,
                err,
            ));
        }
        Err(err) => {
            progress.fail("credential", Some(&err.to_string()));
            return Err(anyhow::anyhow!("{err}"));
        }
    };

    let detail = match outcome {
        HostedCredentialOutcome::Reused => "reused stored am-cli key".to_string(),
        HostedCredentialOutcome::Rotated { key_id, secret } => {
            if let Err(err) = persist_rotated_hosted_key(&project.id, &key_id, &secret, || {
                store_hosted_cloud_api_key(&credential_ref, &secret, cloud_api_url, &project.id)
            }) {
                progress.fail("credential", Some(&err.to_string()));
                return Err(err);
            }
            format!("rotated existing am-cli key ({key_id})")
        }
        HostedCredentialOutcome::Created { key_id, secret } => {
            if let Err(err) =
                persist_hosted_key_or_rollback(backend, &project.id, &key_id, &secret, || {
                    store_hosted_cloud_api_key(&credential_ref, &secret, cloud_api_url, &project.id)
                })
                .await
            {
                progress.fail("credential", Some(&err.to_string()));
                return Err(err.into());
            }
            format!("created am-cli key ({key_id})")
        }
    };
    if let Err(err) = activate_hosted_cloud_profile(
        cloud_profile,
        cloud_api_url,
        &project.id,
        cloud_profile,
        &credential_ref,
    ) {
        let error =
            hosted_profile_activation_error(err, cloud_profile, &project.id, &credential_ref);
        progress.fail("credential", Some(&error.to_string()));
        return Err(error);
    }

    actx.project_id = Some(project.id.clone());
    capture_activation(
        ActivationEvent::HostedCloudConfigured,
        Some(actx.props()),
        no_telemetry,
    );
    progress.succeed("credential", Some(&detail));
    maybe_warn_shell_cloud_env_exports(!global.quiet);
    if !global.quiet {
        eprintln!(
            "\nHosted Cloud is ready on profile '{cloud_profile}'. You can now run `am memory …` or `am integrate`."
        );
    }
    Ok(())
}

fn maybe_warn_shell_cloud_env_exports(verbose: bool) {
    if !verbose {
        return;
    }
    const ENV_API_URL: &str = "ATOMICMEMORY_API_URL";
    let has_api_key = std::env::var(ENV_API_KEY)
        .ok()
        .is_some_and(|value| !value.is_empty());
    let has_cloud_url = std::env::var(ENV_API_URL)
        .ok()
        .filter(|value| !value.is_empty())
        .is_some_and(|url| is_remote_cloud_api_url(&url));
    if has_api_key || has_cloud_url {
        eprintln!(
            "note: shell still has ATOMICMEMORY_API_* set; Hosted Cloud will use the saved profile key unless {ENV_API_KEY_FORCE}=1 — unset the vars to avoid confusion"
        );
    }
}

fn hosted_profile_project_change(
    config: &crate::config::ConfigFile,
    profile_name: &str,
    project_id: &str,
) -> Option<String> {
    config
        .profiles
        .get(profile_name)
        .filter(|profile| profile.kind == crate::config::ProfileKind::Cloud)
        .and_then(|profile| profile.project_id.as_deref())
        .filter(|previous| *previous != project_id)
        .map(str::to_string)
}

fn requires_project_switch_confirmation(
    has_change: bool,
    interactive: bool,
    stdin_is_tty: bool,
    project_explicit: bool,
) -> bool {
    has_change && interactive && stdin_is_tty && !project_explicit
}

fn confirm_hosted_project_switch(
    profile_name: &str,
    previous_project_id: &str,
    project_id: &str,
) -> Result<bool> {
    eprint!(
        "Switch profile '{profile_name}' from project '{previous_project_id}' to '{project_id}'? [y/N]: "
    );
    io::stderr().flush().ok();
    let mut line = String::new();
    io::stdin()
        .read_line(&mut line)
        .context("read Hosted Cloud project switch confirmation")?;
    Ok(matches!(
        line.trim().to_ascii_lowercase().as_str(),
        "y" | "yes"
    ))
}

fn hosted_profile_activation_error(
    source: anyhow::Error,
    profile_name: &str,
    project_id: &str,
    credential_ref: &str,
) -> anyhow::Error {
    anyhow::anyhow!(
        "Hosted Cloud credential is already saved as '{credential_ref}', but profile '{profile_name}' could not be activated: {source}. Fix the configuration write problem, then run `am init --project {project_id}` again"
    )
}

fn hosted_quota_error(
    cloud_api_url: &str,
    project_id: &str,
    interactive: bool,
    global: &GlobalOptions,
    source: CloudClientError,
) -> anyhow::Error {
    let dashboard_url = dashboard_project_url(cloud_api_url, project_id)
        .or_else(|| dashboard_onboarding_url(cloud_api_url))
        .unwrap_or_else(|| cloud_api_url.to_string());
    if interactive && io::stdin().is_terminal() && !global.quiet {
        if let Err(err) = open::that(&dashboard_url) {
            eprintln!("Could not open a browser ({err}). Open the URL below manually.");
        }
    }
    anyhow::anyhow!(
        "{source}\n{}\nThe previous default profile was preserved; no existing key was rotated or revoked.",
        quota_recovery_message(project_id, &dashboard_url)
    )
}

fn quota_recovery_message(project_id: &str, dashboard_url: &str) -> String {
    format!(
        "Manage this project's API keys at {dashboard_url}, then run:\n\
         am key list --project {project_id}\n\
         am key revoke --project {project_id} <key-id>\n\
         am init --project {project_id}"
    )
}

async fn select_hosted_cloud_target(
    client: &DashboardClient,
    interactive: bool,
    progress: &mut dyn ProgressReporter,
) -> Result<(Option<Project>, HostedHandoffUrl)> {
    let projects = client
        .list_projects()
        .await
        .map_err(|err| anyhow::anyhow!("{err}"))?;
    let clouds = cloud_projects(&projects);
    let policy = hosted_cloud_target_policy(&clouds, interactive, io::stdin().is_terminal());
    match policy {
        HostedCloudTarget::Project(project) => {
            Ok((Some((*project).clone()), HostedHandoffUrl::Project))
        }
        HostedCloudTarget::Prompt => {
            let may_prompt = interactive && io::stdin().is_terminal();
            let picked = with_progress_paused_for_input(progress, may_prompt, || {
                prompt_cloud_project(&clouds)
            })?;
            Ok((Some(picked.clone()), HostedHandoffUrl::Project))
        }
        HostedCloudTarget::OnboardingDashboard => Ok((None, HostedHandoffUrl::Onboarding)),
        HostedCloudTarget::ProjectsDashboard => Ok((None, HostedHandoffUrl::ProjectsList)),
    }
}

fn hosted_cloud_url(
    cloud_api_url: &str,
    project: Option<&Project>,
    handoff_url: HostedHandoffUrl,
) -> Result<String> {
    let url = if let Some(project) = project {
        dashboard_project_url(cloud_api_url, &project.id)
            .or_else(|| dashboard_onboarding_url(cloud_api_url))
    } else {
        match handoff_url {
            HostedHandoffUrl::ProjectsList => dashboard_projects_url(cloud_api_url),
            HostedHandoffUrl::Onboarding | HostedHandoffUrl::Project => {
                dashboard_onboarding_url(cloud_api_url)
            }
        }
    };
    url.ok_or_else(|| {
        anyhow::anyhow!(
            "could not build dashboard URL for {cloud_api_url} — open the console in your browser manually"
        )
    })
}

fn select_polled_cloud_project(
    projects: &[Project],
    progress: &mut dyn ProgressReporter,
) -> Result<Project> {
    match projects {
        [project] => Ok(project.clone()),
        [] => bail!("Hosted Cloud project polling completed without a project"),
        _ => {
            let clouds = projects.iter().collect::<Vec<_>>();
            let picked =
                with_progress_paused_for_input(progress, true, || prompt_cloud_project(&clouds))?;
            Ok(picked.clone())
        }
    }
}

fn prompt_cloud_project<'a>(clouds: &[&'a Project]) -> Result<&'a Project> {
    eprintln!();
    eprintln!("Select a Hosted Cloud project:");
    for (index, project) in clouds.iter().enumerate() {
        eprintln!("  {}) {} ({})", index + 1, project.name, project.slug);
    }
    loop {
        eprint!("Choose [1-{}]: ", clouds.len());
        io::stderr().flush().ok();
        let mut line = String::new();
        let bytes_read = io::stdin()
            .read_line(&mut line)
            .context("read cloud project choice")?;
        match parse_cloud_project_choice(line.trim(), bytes_read, clouds.len())? {
            CloudProjectChoice::Reprompt => {
                eprintln!("Enter a number between 1 and {}.", clouds.len());
            }
            CloudProjectChoice::Eof => {
                bail!(
                    "Hosted Cloud project selection required — choose a number or rerun with --cloud --project <slug>"
                );
            }
            CloudProjectChoice::Selected(index) => return Ok(clouds[index]),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum CloudProjectChoice {
    Reprompt,
    Eof,
    Selected(usize),
}

pub(super) fn parse_cloud_project_choice(
    choice: &str,
    bytes_read: usize,
    count: usize,
) -> Result<CloudProjectChoice> {
    if bytes_read == 0 {
        return Ok(CloudProjectChoice::Eof);
    }
    if choice.is_empty() {
        return Ok(CloudProjectChoice::Reprompt);
    }
    let Ok(num) = choice.parse::<usize>() else {
        return Ok(CloudProjectChoice::Reprompt);
    };
    if !(1..=count).contains(&num) {
        return Ok(CloudProjectChoice::Reprompt);
    }
    Ok(CloudProjectChoice::Selected(num - 1))
}

async fn poll_for_cloud_projects(
    backend: &dyn HostedCloudBackend,
    interval: Duration,
    timeout: Duration,
) -> Result<Vec<Project>> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let next_poll = (tokio::time::Instant::now() + interval).min(deadline);
        tokio::time::sleep_until(next_poll).await;

        match backend.list_projects().await {
            Ok(projects) => {
                let clouds = projects
                    .into_iter()
                    .filter(|project| project.kind == am_cloud_types::ProjectType::Cloud)
                    .collect::<Vec<_>>();
                if !clouds.is_empty() {
                    return Ok(clouds);
                }
            }
            Err(err) if is_transient_poll_error(&err) => {}
            Err(err) => return Err(anyhow::anyhow!("{err}")),
        }

        if tokio::time::Instant::now() >= deadline {
            bail!(
                "timed out after 10 minutes waiting for a Hosted Cloud project; finish onboarding, then rerun `am init`"
            );
        }
    }
}

fn is_transient_poll_error(error: &CloudClientError) -> bool {
    matches!(
        error,
        CloudClientError::Timeout | CloudClientError::Network(_)
    ) || matches!(error, CloudClientError::Status { code, .. } if *code >= 500 || *code == 429)
}

fn unattended_onboarding_error(onboarding_url: &str) -> anyhow::Error {
    anyhow::anyhow!(
        "Hosted Cloud has no project yet. Complete onboarding at {onboarding_url}, then run `am init` again."
    )
}

fn unattended_project_selection_error(projects_url: &str) -> anyhow::Error {
    anyhow::anyhow!(
        "multiple Hosted Cloud projects are available. Choose one at {projects_url}, then run `am init --project <project-id>`."
    )
}

#[cfg(test)]
mod tests {
    /// Stands in for this install's scoped key name.
    const TEST_KEY_NAME: &str = "am-cli-testmachine";

    use std::collections::VecDeque;
    use std::sync::Mutex;

    use am_cloud_client::CloudClientError;
    use am_cloud_types::{ApiKey, ApiKeyWithSecret, PrivacyMode, ProjectType};
    use chrono::Utc;

    use super::*;

    struct FakeHostedCloudBackend {
        responses: Mutex<VecDeque<Result<Vec<Project>, CloudClientError>>>,
    }

    struct FakeCredentialBackend {
        lists: Mutex<VecDeque<Result<Vec<ApiKey>, CloudClientError>>>,
        list_projects: Mutex<Vec<String>>,
        rotates: Mutex<VecDeque<Result<ApiKeyWithSecret, CloudClientError>>>,
        rotate_calls: Mutex<Vec<(String, String)>>,
        creates: Mutex<VecDeque<Result<ApiKeyWithSecret, CloudClientError>>>,
        create_projects: Mutex<Vec<String>>,
        create_names: Mutex<Vec<String>>,
        revokes: Mutex<Vec<(String, String)>>,
        revoke_error: Mutex<Option<CloudClientError>>,
    }

    struct FakeCredentialProbe {
        responses: Mutex<VecDeque<Result<(), CloudClientError>>>,
        calls: Mutex<usize>,
    }

    #[async_trait::async_trait]
    impl HostedCloudBackend for FakeHostedCloudBackend {
        async fn list_projects(&self) -> Result<Vec<Project>, CloudClientError> {
            self.responses
                .lock()
                .expect("fake backend lock")
                .pop_front()
                .unwrap_or_else(|| Ok(Vec::new()))
        }
    }

    #[async_trait::async_trait]
    impl HostedCredentialBackend for FakeCredentialBackend {
        async fn list_api_keys(&self, project_id: &str) -> Result<Vec<ApiKey>, CloudClientError> {
            self.list_projects
                .lock()
                .expect("list projects lock")
                .push(project_id.to_string());
            self.lists
                .lock()
                .expect("list responses lock")
                .pop_front()
                .unwrap_or_else(|| Ok(Vec::new()))
        }

        async fn rotate_api_key(
            &self,
            project_id: &str,
            key_id: &str,
        ) -> Result<ApiKeyWithSecret, CloudClientError> {
            self.rotate_calls
                .lock()
                .expect("rotate calls lock")
                .push((project_id.to_string(), key_id.to_string()));
            self.rotates
                .lock()
                .expect("rotate responses lock")
                .pop_front()
                .unwrap_or_else(|| panic!("missing rotate response"))
        }

        async fn create_api_key(
            &self,
            project_id: &str,
            request: &am_cloud_types::CreateApiKeyRequest,
        ) -> Result<ApiKeyWithSecret, CloudClientError> {
            self.create_projects
                .lock()
                .expect("create projects lock")
                .push(project_id.to_string());
            self.create_names
                .lock()
                .expect("create names lock")
                .push(request.name.clone());
            self.creates
                .lock()
                .expect("create responses lock")
                .pop_front()
                .unwrap_or_else(|| panic!("missing create response"))
        }

        async fn revoke_api_key(
            &self,
            project_id: &str,
            key_id: &str,
        ) -> Result<(), CloudClientError> {
            self.revokes
                .lock()
                .expect("revoke calls lock")
                .push((project_id.to_string(), key_id.to_string()));
            self.revoke_error
                .lock()
                .expect("revoke error lock")
                .take()
                .map_or(Ok(()), Err)
        }
    }

    #[async_trait::async_trait]
    impl HostedCredentialProbe for FakeCredentialProbe {
        async fn health(&self, _api_origin: &str, _secret: &str) -> Result<(), CloudClientError> {
            *self.calls.lock().expect("probe calls lock") += 1;
            self.responses
                .lock()
                .expect("probe responses lock")
                .pop_front()
                .unwrap_or_else(|| panic!("missing probe response"))
        }
    }

    fn project(id: &str, kind: ProjectType) -> Project {
        Project {
            id: id.into(),
            org_id: "org_a".into(),
            name: id.into(),
            slug: id.into(),
            environment: "dev".into(),
            kind,
            local_url: None,
            privacy_mode: PrivacyMode::Connect,
            created_at: Utc::now(),
            memory_count: None,
            last_activity_at: None,
        }
    }

    fn backend(responses: Vec<Result<Vec<Project>, CloudClientError>>) -> FakeHostedCloudBackend {
        FakeHostedCloudBackend {
            responses: Mutex::new(responses.into()),
        }
    }

    fn credential_backend(
        creates: Vec<Result<ApiKeyWithSecret, CloudClientError>>,
    ) -> FakeCredentialBackend {
        FakeCredentialBackend {
            lists: Mutex::new(VecDeque::new()),
            list_projects: Mutex::new(Vec::new()),
            rotates: Mutex::new(VecDeque::new()),
            rotate_calls: Mutex::new(Vec::new()),
            creates: Mutex::new(creates.into()),
            create_projects: Mutex::new(Vec::new()),
            create_names: Mutex::new(Vec::new()),
            revokes: Mutex::new(Vec::new()),
            revoke_error: Mutex::new(None),
        }
    }

    fn credential_probe(responses: Vec<Result<(), CloudClientError>>) -> FakeCredentialProbe {
        FakeCredentialProbe {
            responses: Mutex::new(responses.into()),
            calls: Mutex::new(0),
        }
    }

    /// A listed key owned by someone else, identified purely by its name.
    fn named_key(project_id: &str, key_id: &str, name: &str) -> ApiKey {
        ApiKey {
            id: key_id.into(),
            project_id: project_id.into(),
            name: name.into(),
            prefix: "amc_test".into(),
            status: "active".into(),
            created_at: Utc::now(),
            last_used_at: None,
        }
    }

    fn created_key(project_id: &str, key_id: &str, secret: &str) -> ApiKeyWithSecret {
        ApiKeyWithSecret {
            key: ApiKey {
                id: key_id.into(),
                project_id: project_id.into(),
                name: TEST_KEY_NAME.into(),
                prefix: "amc_test".into(),
                status: "active".into(),
                created_at: Utc::now(),
                last_used_at: None,
            },
            secret: secret.into(),
        }
    }

    fn stored_key(origin: &str, project_id: &str) -> crate::config::ApiKeySecret {
        crate::config::ApiKeySecret {
            secret: "amc_stored_secret".into(),
            api_origin: Some(origin.into()),
            project_id: Some(project_id.into()),
        }
    }

    #[tokio::test(start_paused = true)]
    async fn onboarding_poll_retries_transient_failures_until_cloud_exists() {
        let backend = backend(vec![
            Err(CloudClientError::Timeout),
            Err(CloudClientError::Network("offline".into())),
            Err(CloudClientError::Status {
                code: 503,
                body: "unavailable".into(),
            }),
            Ok(vec![project("proj_local", ProjectType::Local)]),
            Ok(vec![project("proj_cloud", ProjectType::Cloud)]),
        ]);

        let projects = poll_for_cloud_projects(
            &backend,
            HOSTED_PROJECT_POLL_INTERVAL,
            HOSTED_PROJECT_POLL_TIMEOUT,
        )
        .await
        .unwrap();
        assert_eq!(projects[0].id, "proj_cloud");
    }

    #[tokio::test(start_paused = true)]
    async fn onboarding_poll_fails_immediately_on_authentication_error() {
        let backend = backend(vec![Err(CloudClientError::Auth)]);
        let started = tokio::time::Instant::now();

        let error = poll_for_cloud_projects(
            &backend,
            HOSTED_PROJECT_POLL_INTERVAL,
            HOSTED_PROJECT_POLL_TIMEOUT,
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("authentication failed"));
        assert_eq!(started.elapsed(), HOSTED_PROJECT_POLL_INTERVAL);
    }

    #[tokio::test(start_paused = true)]
    async fn onboarding_poll_fails_immediately_without_an_organization() {
        let backend = backend(vec![Err(CloudClientError::NoActiveOrganization)]);
        let started = tokio::time::Instant::now();

        let error = poll_for_cloud_projects(
            &backend,
            HOSTED_PROJECT_POLL_INTERVAL,
            HOSTED_PROJECT_POLL_TIMEOUT,
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("no active organization"));
        assert_eq!(started.elapsed(), HOSTED_PROJECT_POLL_INTERVAL);
    }

    #[tokio::test(start_paused = true)]
    async fn onboarding_poll_stops_at_ten_minute_deadline() {
        let backend = backend(Vec::new());
        let started = tokio::time::Instant::now();

        let error = poll_for_cloud_projects(
            &backend,
            HOSTED_PROJECT_POLL_INTERVAL,
            HOSTED_PROJECT_POLL_TIMEOUT,
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("10 minutes"));
        assert_eq!(started.elapsed(), HOSTED_PROJECT_POLL_TIMEOUT);
    }

    #[test]
    fn unattended_zero_project_recovery_is_actionable() {
        let error = unattended_onboarding_error("https://app.atomicmemory.test/onboarding");
        let message = error.to_string();
        assert!(message.contains("https://app.atomicmemory.test/onboarding"));
        assert!(message.contains("am init"));
    }

    #[test]
    fn browser_onboarding_wait_requires_prompts_and_a_tty() {
        assert!(may_wait_for_onboarding(true, true));
        assert!(!may_wait_for_onboarding(false, true));
        assert!(!may_wait_for_onboarding(true, false));
    }

    #[test]
    fn browser_opens_only_for_unresolved_project_handoffs() {
        assert!(should_open_handoff_browser(
            HostedHandoffUrl::Onboarding,
            true,
            true,
            false
        ));
        assert!(should_open_handoff_browser(
            HostedHandoffUrl::ProjectsList,
            true,
            true,
            false
        ));
        assert!(!should_open_handoff_browser(
            HostedHandoffUrl::Project,
            true,
            true,
            false
        ));
        assert!(!should_open_handoff_browser(
            HostedHandoffUrl::Onboarding,
            false,
            true,
            false
        ));
        assert!(!should_open_handoff_browser(
            HostedHandoffUrl::Onboarding,
            true,
            false,
            false
        ));
        assert!(!should_open_handoff_browser(
            HostedHandoffUrl::Onboarding,
            true,
            true,
            true
        ));
    }

    #[test]
    fn project_switch_policy_detects_cloud_project_changes_only() {
        let mut config = crate::config::ConfigFile::default();
        config.profiles.insert(
            "cloud".into(),
            crate::config::ProfileConfig {
                kind: crate::config::ProfileKind::Cloud,
                project_id: Some("proj_old".into()),
                ..Default::default()
            },
        );

        assert_eq!(
            hosted_profile_project_change(&config, "cloud", "proj_new").as_deref(),
            Some("proj_old")
        );
        assert_eq!(
            hosted_profile_project_change(&config, "cloud", "proj_old"),
            None
        );
        assert!(requires_project_switch_confirmation(
            true, true, true, false
        ));
        assert!(!requires_project_switch_confirmation(
            true, true, true, true
        ));
        assert!(!requires_project_switch_confirmation(
            true, false, true, false
        ));
    }

    #[test]
    fn activation_failure_reports_that_the_credential_is_already_saved() {
        let error = hosted_profile_activation_error(
            anyhow::anyhow!("permission denied"),
            "cloud",
            "proj_a",
            "hosted-cloud-proj_a",
        );
        let message = error.to_string();
        assert!(message.contains("credential is already saved"));
        assert!(message.contains("hosted-cloud-proj_a"));
        assert!(message.contains("am init --project proj_a"));
        assert!(!message.contains("secret"));
    }

    #[test]
    fn hosted_credentials_use_a_project_specific_reference() {
        assert_eq!(hosted_cloud_credential_ref("proj_a"), "hosted-cloud-proj_a");
        assert_ne!(
            hosted_cloud_credential_ref("proj_a"),
            hosted_cloud_credential_ref("proj_b")
        );
    }

    #[tokio::test]
    async fn valid_bound_hosted_key_is_reused_without_creation() {
        let backend = credential_backend(Vec::new());
        let probe = credential_probe(vec![Ok(())]);
        let stored = stored_key("https://api.atomicstrata.ai", "proj_a");

        let outcome = provision_hosted_cloud_key(
            &backend,
            &probe,
            "https://api.atomicstrata.ai",
            "proj_a",
            Some(&stored),
            TEST_KEY_NAME,
        )
        .await
        .expect("reuse bound key");

        assert!(matches!(outcome, HostedCredentialOutcome::Reused));
        assert!(
            backend
                .create_projects
                .lock()
                .expect("create projects lock")
                .is_empty()
        );
    }

    #[tokio::test]
    async fn wrong_binding_skips_probe_and_creates_project_key() {
        let backend =
            credential_backend(vec![Ok(created_key("proj_b", "key_b", "amc_new_secret"))]);
        let probe = credential_probe(vec![Ok(())]);
        let stored = stored_key("https://api.atomicstrata.ai", "proj_a");

        let outcome = provision_hosted_cloud_key(
            &backend,
            &probe,
            "https://api.atomicstrata.ai",
            "proj_b",
            Some(&stored),
            TEST_KEY_NAME,
        )
        .await
        .expect("create project-bound key");

        assert!(matches!(outcome, HostedCredentialOutcome::Created { .. }));
        assert_eq!(*probe.calls.lock().expect("probe calls lock"), 1);
        assert_eq!(
            backend
                .create_projects
                .lock()
                .expect("create projects lock")
                .as_slice(),
            ["proj_b"]
        );
        assert_eq!(
            backend
                .create_names
                .lock()
                .expect("create names lock")
                .as_slice(),
            [TEST_KEY_NAME]
        );
    }

    #[tokio::test]
    async fn foreign_origin_skips_probe_and_creates_origin_bound_key() {
        let backend =
            credential_backend(vec![Ok(created_key("proj_a", "key_a", "amc_new_secret"))]);
        let probe = credential_probe(vec![Ok(())]);
        let stored = stored_key("https://api.other.example", "proj_a");

        let outcome = provision_hosted_cloud_key(
            &backend,
            &probe,
            "https://api.atomicstrata.ai",
            "proj_a",
            Some(&stored),
            TEST_KEY_NAME,
        )
        .await
        .expect("replace foreign-origin key");

        assert!(matches!(outcome, HostedCredentialOutcome::Created { .. }));
        assert_eq!(*probe.calls.lock().expect("probe calls lock"), 1);
    }

    #[tokio::test]
    async fn auth_rejection_creates_only_without_a_singleton_and_transport_failure_stops() {
        let stored = stored_key("https://api.atomicstrata.ai", "proj_a");
        let auth_backend =
            credential_backend(vec![Ok(created_key("proj_a", "key_new", "amc_new_secret"))]);
        let auth_probe = credential_probe(vec![Err(CloudClientError::Auth), Ok(())]);
        let outcome = provision_hosted_cloud_key(
            &auth_backend,
            &auth_probe,
            "https://api.atomicstrata.ai",
            "proj_a",
            Some(&stored),
            TEST_KEY_NAME,
        )
        .await
        .expect("replace rejected key");
        assert!(matches!(outcome, HostedCredentialOutcome::Created { .. }));
        assert_eq!(
            auth_backend
                .list_projects
                .lock()
                .expect("list projects lock")
                .as_slice(),
            ["proj_a"]
        );

        let network_backend = credential_backend(Vec::new());
        let network_probe =
            credential_probe(vec![Err(CloudClientError::Network("offline".into()))]);
        let error = provision_hosted_cloud_key(
            &network_backend,
            &network_probe,
            "https://api.atomicstrata.ai",
            "proj_a",
            Some(&stored),
            TEST_KEY_NAME,
        )
        .await
        .err()
        .expect("transport probe must fail");
        assert!(error.to_string().contains("offline"));
        assert!(
            network_backend
                .create_projects
                .lock()
                .expect("create projects lock")
                .is_empty()
        );
    }

    #[tokio::test]
    async fn rejected_stored_key_rotates_the_existing_hosted_singleton() {
        let backend = credential_backend(Vec::new());
        backend
            .lists
            .lock()
            .expect("list responses lock")
            .push_back(Ok(vec![
                created_key("proj_a", "key_existing", "unused").key,
            ]));
        backend
            .rotates
            .lock()
            .expect("rotate responses lock")
            .push_back(Ok(created_key(
                "proj_a",
                "key_existing",
                "amc_rotated_secret",
            )));
        let stored = stored_key("https://api.atomicstrata.ai", "proj_a");
        let probe = credential_probe(vec![Err(CloudClientError::Auth), Ok(())]);

        let outcome = provision_hosted_cloud_key(
            &backend,
            &probe,
            "https://api.atomicstrata.ai",
            "proj_a",
            Some(&stored),
            TEST_KEY_NAME,
        )
        .await
        .expect("rotate rejected singleton key");

        assert!(matches!(outcome, HostedCredentialOutcome::Rotated { .. }));
        assert_eq!(
            backend
                .rotate_calls
                .lock()
                .expect("rotate calls lock")
                .as_slice(),
            [("proj_a".into(), "key_existing".into())]
        );
        assert!(
            backend
                .create_projects
                .lock()
                .expect("create projects lock")
                .is_empty()
        );
    }

    #[tokio::test]
    async fn a_foreign_machines_key_is_never_rotated() {
        // The regression: rotation invalidates the old secret, so rotating a key
        // this machine does not own silently breaks whichever machine is using
        // it. A fresh install must mint its own key instead.
        let backend = credential_backend(vec![Ok(created_key(
            "proj_a",
            "key_mine",
            "amc_new_secret",
        ))]);
        backend
            .lists
            .lock()
            .expect("list responses lock")
            .push_back(Ok(vec![
                // Another machine's key, and the legacy project-wide name.
                named_key("proj_a", "key_other", "am-cli-othermachine"),
                named_key("proj_a", "key_legacy", "am-cli"),
            ]));
        let probe = credential_probe(vec![Ok(())]);

        let outcome = provision_hosted_cloud_key(
            &backend,
            &probe,
            "https://api.atomicstrata.ai",
            "proj_a",
            None,
            TEST_KEY_NAME,
        )
        .await
        .expect("fresh install provisions a key");

        assert!(matches!(outcome, HostedCredentialOutcome::Created { .. }));
        // Nothing belonging to another machine was touched.
        assert!(
            backend
                .rotate_calls
                .lock()
                .expect("rotate calls lock")
                .is_empty()
        );
        // And the new key carries this machine's scoped name.
        assert_eq!(
            backend
                .create_names
                .lock()
                .expect("create names lock")
                .as_slice(),
            [TEST_KEY_NAME]
        );
    }

    #[tokio::test]
    async fn missing_stored_key_rotates_only_this_machines_key() {
        let backend = credential_backend(Vec::new());
        backend
            .lists
            .lock()
            .expect("list responses lock")
            .push_back(Ok(vec![
                created_key("proj_a", "key_existing", "unused").key,
            ]));
        backend
            .rotates
            .lock()
            .expect("rotate responses lock")
            .push_back(Ok(created_key(
                "proj_a",
                "key_existing",
                "amc_rotated_secret",
            )));
        let probe = credential_probe(vec![Ok(())]);

        let outcome = provision_hosted_cloud_key(
            &backend,
            &probe,
            "https://api.atomicstrata.ai",
            "proj_a",
            None,
            TEST_KEY_NAME,
        )
        .await
        .expect("rotate project singleton");

        assert!(matches!(outcome, HostedCredentialOutcome::Rotated { .. }));
        assert!(
            backend
                .create_projects
                .lock()
                .expect("create projects lock")
                .is_empty()
        );
    }

    #[tokio::test]
    async fn api_key_listing_failure_stops_before_rotation_or_creation() {
        let backend = credential_backend(Vec::new());
        backend
            .lists
            .lock()
            .expect("list responses lock")
            .push_back(Err(CloudClientError::Network("offline".into())));
        let probe = credential_probe(Vec::new());

        let error = provision_hosted_cloud_key(
            &backend,
            &probe,
            "https://api.atomicstrata.ai",
            "proj_a",
            None,
            TEST_KEY_NAME,
        )
        .await
        .err()
        .expect("listing failure must fail closed");

        assert!(error.to_string().contains("list Hosted Cloud API keys"));
        assert!(
            backend
                .rotate_calls
                .lock()
                .expect("rotate calls lock")
                .is_empty()
        );
        assert!(
            backend
                .create_projects
                .lock()
                .expect("create projects lock")
                .is_empty()
        );
    }

    #[tokio::test]
    async fn failed_rotated_key_validation_never_revokes_or_creates() {
        let backend = credential_backend(Vec::new());
        backend
            .lists
            .lock()
            .expect("list responses lock")
            .push_back(Ok(vec![
                created_key("proj_a", "key_existing", "unused").key,
            ]));
        backend
            .rotates
            .lock()
            .expect("rotate responses lock")
            .push_back(Ok(created_key(
                "proj_a",
                "key_existing",
                "amc_do_not_print_me",
            )));
        let probe = credential_probe(vec![Err(CloudClientError::Auth)]);

        let error = provision_hosted_cloud_key(
            &backend,
            &probe,
            "https://api.atomicstrata.ai",
            "proj_a",
            None,
            TEST_KEY_NAME,
        )
        .await
        .err()
        .expect("invalid rotated key must fail");

        assert!(!error.to_string().contains("amc_do_not_print_me"));
        assert!(error.to_string().contains("no key was revoked"));
        assert!(
            backend
                .revokes
                .lock()
                .expect("revoke calls lock")
                .is_empty()
        );
        assert!(
            backend
                .create_projects
                .lock()
                .expect("create projects lock")
                .is_empty()
        );
    }

    #[tokio::test]
    async fn failed_persistence_revokes_the_new_key_and_redacts_the_secret() {
        // The secret is unrecoverable after creation, so a failed local write
        // must hand the key back rather than stranding it on the project.
        let backend = credential_backend(vec![]);
        let err = persist_hosted_key_or_rollback(
            &backend,
            "proj_a",
            "key_new",
            "amc_do_not_print_me",
            || {
                Err(anyhow::anyhow!(
                    "permission denied writing amc_do_not_print_me"
                ))
            },
        )
        .await
        .expect_err("failed persistence must surface an error");

        assert!(!err.to_string().contains("amc_do_not_print_me"));
        assert!(
            err.to_string()
                .contains("revoked newly created key key_new")
        );
        assert_eq!(
            backend
                .revokes
                .lock()
                .expect("revoke calls lock")
                .as_slice(),
            [("proj_a".into(), "key_new".into())]
        );
    }

    #[tokio::test]
    async fn successful_persistence_keeps_the_key() {
        // The rollback must not fire on the happy path.
        let backend = credential_backend(vec![]);
        persist_hosted_key_or_rollback(&backend, "proj_a", "key_new", "amc_secret", || Ok(()))
            .await
            .expect("successful persistence must succeed");
        assert!(
            backend
                .revokes
                .lock()
                .expect("revoke calls lock")
                .is_empty()
        );
    }

    #[test]
    fn failed_rotated_key_persistence_is_redacted_and_never_requests_revocation() {
        let error =
            persist_rotated_hosted_key("proj_a", "key_existing", "amc_do_not_print_me", || {
                Err(anyhow::anyhow!(
                    "permission denied writing amc_do_not_print_me"
                ))
            })
            .expect_err("failed rotated-key persistence must surface an error");

        assert!(!error.to_string().contains("amc_do_not_print_me"));
        assert!(error.to_string().contains("key_existing"));
        assert!(error.to_string().contains("am init --project proj_a"));
        assert!(!error.to_string().contains("revoke"));
    }

    #[tokio::test]
    async fn failed_persistence_reports_when_cleanup_also_fails() {
        // A key we could neither save nor revoke must say so; it needs manual
        // cleanup in the dashboard.
        let backend = credential_backend(vec![]);
        *backend.revoke_error.lock().expect("revoke error lock") = Some(CloudClientError::Auth);
        let err =
            persist_hosted_key_or_rollback(&backend, "proj_a", "key_new", "amc_secret", || {
                Err(anyhow::anyhow!("disk full"))
            })
            .await
            .expect_err("failed persistence must surface an error");
        assert!(
            err.to_string()
                .contains("cleanup of newly created key key_new also failed")
        );
        assert!(err.to_string().contains("revoke it in the dashboard"));
    }

    #[test]
    fn redact_secret_removes_every_occurrence() {
        let text = redact_secret("wrote sk_live_1 then sk_live_1 again", "sk_live_1");
        assert!(!text.contains("sk_live_1"));
        assert_eq!(text, "wrote «redacted» then «redacted» again");
        // An empty secret must not turn the message into confetti.
        assert_eq!(redact_secret("unchanged", ""), "unchanged");
    }

    #[test]
    fn rate_limited_polling_is_transient() {
        // A 2s poll over 10 minutes is ~300 requests; 429 is expected, not fatal.
        assert!(is_transient_poll_error(&CloudClientError::Status {
            code: 429,
            body: "too many requests".into(),
        }));
        assert!(is_transient_poll_error(&CloudClientError::Status {
            code: 503,
            body: "unavailable".into(),
        }));
        // Client errors that will never resolve on retry must still abort.
        assert!(!is_transient_poll_error(&CloudClientError::Status {
            code: 403,
            body: "forbidden".into(),
        }));
    }

    #[tokio::test]
    async fn failed_new_key_validation_revokes_only_that_key_and_redacts_secret() {
        let backend = credential_backend(vec![Ok(created_key(
            "proj_a",
            "key_new",
            "amc_do_not_print_me",
        ))]);
        let probe = credential_probe(vec![Err(CloudClientError::Auth)]);

        let error = provision_hosted_cloud_key(
            &backend,
            &probe,
            "https://api.atomicstrata.ai",
            "proj_a",
            None,
            TEST_KEY_NAME,
        )
        .await
        .err()
        .expect("invalid new key must fail");

        assert!(!error.to_string().contains("amc_do_not_print_me"));
        assert_eq!(
            backend
                .revokes
                .lock()
                .expect("revoke calls lock")
                .as_slice(),
            [("proj_a".into(), "key_new".into())]
        );
    }

    #[tokio::test]
    async fn failed_new_key_validation_reports_rollback_failure() {
        let backend = credential_backend(vec![Ok(created_key(
            "proj_a",
            "key_new",
            "amc_do_not_print_me",
        ))]);
        *backend.revoke_error.lock().expect("revoke error lock") =
            Some(CloudClientError::Network("cleanup offline".into()));
        let probe = credential_probe(vec![Err(CloudClientError::Auth)]);

        let error = provision_hosted_cloud_key(
            &backend,
            &probe,
            "https://api.atomicstrata.ai",
            "proj_a",
            None,
            TEST_KEY_NAME,
        )
        .await
        .err()
        .expect("rollback failure must be reported");

        assert!(error.to_string().contains("cleanup offline"));
        assert!(!error.to_string().contains("amc_do_not_print_me"));
    }

    #[tokio::test]
    async fn quota_never_revokes_and_a_later_rerun_can_succeed() {
        let backend = credential_backend(vec![
            Err(CloudClientError::Status {
                code: 429,
                body: "quota_exceeded: max_api_keys".into(),
            }),
            Ok(created_key("proj_a", "key_new", "amc_new_secret")),
        ]);
        let probe = credential_probe(vec![Ok(())]);

        let first = provision_hosted_cloud_key(
            &backend,
            &probe,
            "https://api.atomicstrata.ai",
            "proj_a",
            None,
            TEST_KEY_NAME,
        )
        .await
        .err()
        .expect("quota must fail");
        assert!(matches!(first, HostedCredentialError::Quota(_)));
        assert!(
            backend
                .revokes
                .lock()
                .expect("revoke calls lock")
                .is_empty()
        );

        let second = provision_hosted_cloud_key(
            &backend,
            &probe,
            "https://api.atomicstrata.ai",
            "proj_a",
            None,
            TEST_KEY_NAME,
        )
        .await
        .expect("rerun after capacity");
        assert!(matches!(second, HostedCredentialOutcome::Created { .. }));
    }

    #[test]
    fn quota_recovery_names_dashboard_and_exact_cli_commands() {
        let message =
            quota_recovery_message("proj_a", "https://app.atomicmemory.test/projects/proj_a");
        assert!(message.contains("https://app.atomicmemory.test/projects/proj_a"));
        assert!(message.contains("am key list --project proj_a"));
        assert!(message.contains("am key revoke --project proj_a <key-id>"));
        assert!(message.contains("am init --project proj_a"));
    }
}
