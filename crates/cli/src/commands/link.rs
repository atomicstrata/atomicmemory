//! `am link` — bind a local Core URL to a Cloud project.

use anyhow::Result;
use clap::Subcommand;

use am_cloud_client::CloudClientError;
use am_cloud_types::{CreateProjectRequest, Project, ProjectType};

use crate::auth::ensure_org::{EnsureOrgOptions, ensure_org_context};
use crate::cli::GlobalOptions;
use crate::commands::client::dashboard_client;
use crate::commands::connect::next_step_after_link_local;
use crate::config::{
    ProfileConfig, ProfileKind, is_cloud_api_key, resolve_cloud_auth_profile, store_api_key,
    update_config,
};
use crate::output::{emit, message};

#[derive(Debug, Subcommand)]
pub enum LinkCommand {
    /// Bind a local Core URL to a Cloud project
    Local {
        #[arg(long)]
        org_id: Option<String>,
        #[arg(long)]
        name: String,
        #[arg(long)]
        local_url: String,
        #[arg(long, default_value = "dev")]
        environment: String,
        #[arg(long)]
        key: Option<String>,
        #[arg(long)]
        profile: Option<String>,
    },
}

pub async fn run(cmd: LinkCommand, global: &GlobalOptions) -> Result<()> {
    match cmd {
        LinkCommand::Local {
            org_id,
            name,
            local_url,
            environment,
            key,
            profile,
        } => {
            link_local(
                global,
                LinkLocalRequest {
                    org_id,
                    name,
                    local_url,
                    environment,
                    key,
                    profile_name: profile,
                },
                LinkLocalOptions::default(),
            )
            .await?;
            Ok(())
        }
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct LinkLocalOptions {
    /// Skip JSON project dump (used by `am init`).
    pub summary_only: bool,
}

#[derive(Debug, Clone)]
pub struct LinkLocalRequest {
    pub org_id: Option<String>,
    pub name: String,
    pub local_url: String,
    pub environment: String,
    pub key: Option<String>,
    pub profile_name: Option<String>,
}

pub(crate) async fn link_local(
    global: &GlobalOptions,
    request: LinkLocalRequest,
    options: LinkLocalOptions,
) -> Result<Project> {
    let slug = slugify(&request.name);
    let profile_name = request.profile_name.clone().unwrap_or_else(|| slug.clone());

    let org_id = if let Some(org) = request.org_id.clone() {
        org
    } else {
        let (profile, _) = dashboard_client(global).await?;
        let org = ensure_org_context(
            &profile.name,
            None,
            !global.quiet,
            global.base_url.as_deref(),
            EnsureOrgOptions::default(),
        )
        .await?;
        org.id
    };

    let (cloud_profile, client) = dashboard_client(global).await?;
    let (project, reused) = find_or_create_local_project(&client, &org_id, &request, &slug)
        .await
        .map_err(map_link_error)?;

    let cloud_oauth_ref = resolve_cloud_auth_profile()?;
    let local_url_display = request.local_url.clone();

    // Record the origin the requests above actually went to. Recomputing it
    // from `global.base_url` dropped the active profile's own base URL and fell
    // back to production, so a key minted against a custom origin was stamped
    // as production and could then be sent there.
    let base_url = cloud_profile.base_url.clone();
    let local_url = request.local_url;
    // Keep a copy before `base_url` moves into the closure below.
    let base_url_for_key = base_url.clone();
    update_config(|cfg| {
        cfg.profiles.insert(
            profile_name.clone(),
            ProfileConfig {
                base_url: Some(base_url),
                kind: ProfileKind::Local,
                project_id: Some(project.id.clone()),
                local_url: Some(local_url),
                oauth_ref: Some(cloud_oauth_ref),
                ..Default::default()
            },
        );
        cfg.default_profile = Some(profile_name.clone());
        Ok(())
    })?;

    if let Some(secret) = request.key {
        if is_cloud_api_key(&secret) {
            store_api_key(&profile_name, &secret, &base_url_for_key, &project.id)?;
        } else {
            message(
                !global.quiet,
                "warning: --key does not look like a Cloud API key (amc_…) — use CORE_API_KEY env for Core auth; run `am key create --save` for trace sync",
            );
        }
    }

    if options.summary_only {
        let verb = if reused {
            "Using existing cloud project"
        } else {
            "Linked local project"
        };
        message(
            !global.quiet,
            &format!("{verb} '{}' → {}", project.name, local_url_display),
        );
    } else {
        message(
            !global.quiet,
            &format!(
                "Linked local project '{}' as profile '{profile_name}'",
                project.id
            ),
        );
        message(!global.quiet, &next_step_after_link_local());
        emit(global.output, &project, global.quiet)?;
    }

    Ok(project)
}

async fn find_or_create_local_project(
    client: &am_cloud_client::DashboardClient,
    org_id: &str,
    request: &LinkLocalRequest,
    slug: &str,
) -> Result<(Project, bool), CloudClientError> {
    if let Some(existing) = find_local_project_by_slug(client, org_id, slug).await? {
        return Ok((existing, true));
    }

    let create = CreateProjectRequest {
        org_id: org_id.to_string(),
        name: request.name.clone(),
        slug: slug.to_string(),
        environment: request.environment.clone(),
        kind: ProjectType::Local,
        local_url: Some(request.local_url.clone()),
    };

    match client.create_project(&create).await {
        Ok(project) => Ok((project, false)),
        Err(CloudClientError::Status { code: 409, .. }) => {
            let existing = find_local_project_by_slug(client, org_id, slug).await?;
            match existing {
                Some(project) => Ok((project, true)),
                None => Err(CloudClientError::Status {
                    code: 409,
                    body: format!(
                        "project slug '{slug}' already exists but is not a local project — \
                         use `am init --name <other>` or delete it in the dashboard"
                    ),
                }),
            }
        }
        Err(err) => Err(err),
    }
}

async fn find_local_project_by_slug(
    client: &am_cloud_client::DashboardClient,
    org_id: &str,
    slug: &str,
) -> Result<Option<Project>, CloudClientError> {
    let projects = client.list_projects().await?;
    Ok(projects
        .into_iter()
        .find(|p| p.org_id == org_id && p.slug == slug && p.kind == ProjectType::Local))
}

fn map_link_error(err: CloudClientError) -> anyhow::Error {
    match err {
        CloudClientError::Status { code, body } => {
            anyhow::anyhow!("server returned {code}: {body}")
        }
        other => other.into(),
    }
}

fn slugify(name: &str) -> String {
    name.to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .chars()
        .take(60)
        .collect()
}
