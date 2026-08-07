//! `am org` — list, create, and select organizations.

use anyhow::Result;
use clap::Subcommand;

use am_cloud_types::CreateOrgRequest;

use crate::cli::GlobalOptions;
use crate::commands::client::dashboard_client;
use crate::output::emit;

#[derive(Debug, Subcommand)]
pub enum OrgCommand {
    List,
    Create {
        name: String,
        slug: String,
        clerk_org_id: String,
    },
    Get {
        org_id: String,
    },
}

pub async fn run(cmd: OrgCommand, global: &GlobalOptions) -> Result<()> {
    let (_profile, client) = dashboard_client(global).await?;
    match cmd {
        OrgCommand::List => {
            let orgs = client.list_orgs().await?;
            emit(global.output, &orgs, global.quiet)
        }
        OrgCommand::Create {
            name,
            slug,
            clerk_org_id,
        } => {
            let org = client
                .create_org(&CreateOrgRequest {
                    name,
                    slug,
                    clerk_org_id,
                    account_type: None,
                })
                .await?;
            emit(global.output, &org, global.quiet)
        }
        OrgCommand::Get { org_id } => {
            let org = client.get_org(&org_id).await?;
            emit(global.output, &org, global.quiet)
        }
    }
}
