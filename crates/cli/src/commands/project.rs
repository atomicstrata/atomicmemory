//! `am project` — list, create, and inspect Cloud projects.

use anyhow::Result;
use clap::Subcommand;

use am_cloud_types::{CreateProjectRequest, ProjectType, UpdateProjectRequest};

use crate::auth::setup::setup_default_project;
use crate::cli::GlobalOptions;
use crate::commands::client::dashboard_client;
use crate::config::{resolve_profile, store_project_id};
use crate::output::{emit, message};

#[derive(Debug, Subcommand)]
pub enum ProjectCommand {
    List,
    Create {
        #[arg(long)]
        org_id: String,
        name: String,
        slug: String,
        #[arg(long, default_value = "dev")]
        environment: String,
        #[arg(long, value_enum, default_value = "cloud")]
        kind: ProjectKindArg,
        #[arg(long)]
        local_url: Option<String>,
    },
    Get {
        project_id: String,
    },
    Rename {
        project_id: String,
        name: String,
    },
    Delete {
        project_id: String,
    },
    /// Interactively pick the default project for the active profile
    Select,
    /// Set the default project for the active profile
    Use {
        project_id: String,
    },
}

#[derive(Debug, Clone, Copy, clap::ValueEnum, Default)]
pub enum ProjectKindArg {
    #[default]
    Cloud,
    Local,
}

impl From<ProjectKindArg> for ProjectType {
    fn from(v: ProjectKindArg) -> Self {
        match v {
            ProjectKindArg::Cloud => ProjectType::Cloud,
            ProjectKindArg::Local => ProjectType::Local,
        }
    }
}

pub async fn run(cmd: ProjectCommand, global: &GlobalOptions) -> Result<()> {
    match cmd {
        ProjectCommand::Select => {
            let profile_name = resolve_profile(
                global.profile.as_deref(),
                global.base_url.as_deref(),
                global.environment,
            )?
            .name;
            setup_default_project(&profile_name, true, global.base_url.as_deref()).await
        }
        ProjectCommand::Use { project_id } => {
            let profile_name = resolve_profile(
                global.profile.as_deref(),
                global.base_url.as_deref(),
                global.environment,
            )?
            .name;
            store_project_id(&profile_name, &project_id)?;
            message(
                !global.quiet,
                &format!("Default project set to '{project_id}' on profile '{profile_name}'"),
            );
            Ok(())
        }
        _ => {
            let (_profile, client) = dashboard_client(global).await?;
            run_with_client(cmd, global, &client).await
        }
    }
}

async fn run_with_client(
    cmd: ProjectCommand,
    global: &GlobalOptions,
    client: &am_cloud_client::DashboardClient,
) -> Result<()> {
    match cmd {
        ProjectCommand::List => {
            let projects = client.list_projects().await?;
            emit(global.output, &projects, global.quiet)
        }
        ProjectCommand::Create {
            org_id,
            name,
            slug,
            environment,
            kind,
            local_url,
        } => {
            let project = client
                .create_project(&CreateProjectRequest {
                    org_id,
                    name,
                    slug,
                    environment,
                    kind: kind.into(),
                    local_url,
                })
                .await?;
            emit(global.output, &project, global.quiet)
        }
        ProjectCommand::Get { project_id } => {
            let project = client.get_project(&project_id).await?;
            emit(global.output, &project, global.quiet)
        }
        ProjectCommand::Rename { project_id, name } => {
            let project = client
                .update_project(
                    &project_id,
                    &UpdateProjectRequest {
                        name: Some(name),
                        privacy_mode: None,
                    },
                )
                .await?;
            emit(global.output, &project, global.quiet)
        }
        ProjectCommand::Delete { project_id } => {
            // 204 No Content: there is no project body to echo back, and the
            // project no longer exists to describe.
            client.delete_project(&project_id).await?;
            emit(
                global.output,
                &serde_json::json!({ "deleted": true, "project_id": project_id }),
                global.quiet,
            )
        }
        ProjectCommand::Select | ProjectCommand::Use { .. } => unreachable!(),
    }
}
