//! `am key` — create, list, and store Cloud API keys.

use anyhow::Result;
use clap::Subcommand;

use am_cloud_types::CreateApiKeyRequest;

use crate::cli::GlobalOptions;
use crate::commands::client::dashboard_client;
use crate::commands::connect::next_step_after_key_create;
use crate::config::{ProfileKind, require_project_id, store_api_key};
use crate::output::{emit, message};

#[derive(Debug, Subcommand)]
pub enum KeyCommand {
    List {
        #[arg(long)]
        project: Option<String>,
    },
    Create {
        #[arg(long)]
        project: Option<String>,
        name: String,
        #[arg(long)]
        environment: Option<String>,
        #[arg(long)]
        save: bool,
    },
    Rotate {
        #[arg(long)]
        project: Option<String>,
        key_id: String,
        #[arg(long)]
        save: bool,
    },
    Revoke {
        #[arg(long)]
        project: Option<String>,
        key_id: String,
    },
}

pub async fn run(cmd: KeyCommand, global: &GlobalOptions) -> Result<()> {
    let (profile, client) = dashboard_client(global).await?;
    match cmd {
        KeyCommand::List { project } => {
            let project_id = require_project_id(&profile, project.as_deref())?;
            let keys = client.list_api_keys(&project_id).await?;
            emit(global.output, &keys, global.quiet)
        }
        KeyCommand::Create {
            project,
            name,
            environment,
            save,
        } => {
            let project_id = require_project_id(&profile, project.as_deref())?;
            let key = client
                .create_api_key(&project_id, &CreateApiKeyRequest { name, environment })
                .await?;
            eprintln!("API key secret (shown once): {}", key.secret);
            eprintln!("Store securely — this value cannot be retrieved again.");
            if save {
                store_api_key(&profile.name, &key.secret, &profile.base_url, &project_id)?;
                message(!global.quiet, "Secret saved to credentials file.");
                if profile.kind == ProfileKind::Local {
                    message(!global.quiet, &next_step_after_key_create());
                }
            }
            emit(global.output, &key, global.quiet)
        }
        KeyCommand::Rotate {
            project,
            key_id,
            save,
        } => {
            let project_id = require_project_id(&profile, project.as_deref())?;
            let key = client.rotate_api_key(&project_id, &key_id).await?;
            eprintln!("Rotated API key secret (shown once): {}", key.secret);
            if save {
                store_api_key(&profile.name, &key.secret, &profile.base_url, &project_id)?;
            }
            emit(global.output, &key, global.quiet)
        }
        KeyCommand::Revoke { project, key_id } => {
            let project_id = require_project_id(&profile, project.as_deref())?;
            // 204 No Content: the key is gone, so there is no key body to echo.
            client.revoke_api_key(&project_id, &key_id).await?;
            emit(
                global.output,
                &serde_json::json!({ "revoked": true, "key_id": key_id, "project_id": project_id }),
                global.quiet,
            )
        }
    }
}
