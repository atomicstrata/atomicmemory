//! `am usage` and `am overview` — account usage reporting.

use anyhow::Result;
use clap::Args;

use crate::cli::GlobalOptions;
use crate::commands::client::dashboard_client;
use crate::config::require_project_id;
use crate::output::emit;

#[derive(Debug, Args)]
pub struct UsageCommand {
    #[arg(long)]
    pub project: Option<String>,
}

#[derive(Debug, Args)]
pub struct OverviewCommand {
    #[arg(long)]
    pub project: Option<String>,
}

pub async fn run(cmd: UsageCommand, global: &GlobalOptions) -> Result<()> {
    let (profile, client) = dashboard_client(global).await?;
    let project_id = require_project_id(&profile, cmd.project.as_deref())?;
    let usage = client.usage(&project_id).await?;
    emit(global.output, &usage, global.quiet)
}

pub async fn run_overview(cmd: OverviewCommand, global: &GlobalOptions) -> Result<()> {
    let (profile, client) = dashboard_client(global).await?;
    let project_id = require_project_id(&profile, cmd.project.as_deref())?;
    let overview = client.overview(&project_id).await?;
    emit(global.output, &overview, global.quiet)
}
