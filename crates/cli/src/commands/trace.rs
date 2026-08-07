//! `am trace` — list and inspect Cloud traces.

use anyhow::Result;
use clap::Subcommand;

use crate::cli::GlobalOptions;
use crate::commands::client::dashboard_client;
use crate::config::require_project_id;
use crate::output::emit;

#[derive(Debug, Subcommand)]
pub enum TraceCommand {
    List {
        #[arg(long)]
        project: Option<String>,
        #[arg(long)]
        limit: Option<i64>,
    },
    Get {
        #[arg(long)]
        project: Option<String>,
        trace_id: String,
    },
}

pub async fn run(cmd: TraceCommand, global: &GlobalOptions) -> Result<()> {
    let (profile, client) = dashboard_client(global).await?;
    match cmd {
        TraceCommand::List { project, limit } => {
            let project_id = require_project_id(&profile, project.as_deref())?;
            let traces = client.list_traces(&project_id, limit).await?;
            emit(global.output, &traces, global.quiet)
        }
        TraceCommand::Get { project, trace_id } => {
            let project_id = require_project_id(&profile, project.as_deref())?;
            let trace = client.get_trace(&project_id, &trace_id).await?;
            emit(global.output, &trace, global.quiet)
        }
    }
}
