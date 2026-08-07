//! `am hooks` — lifecycle hook install, run, doctor, and uninstall.

use anyhow::Result;
use clap::Subcommand;

use crate::cli::GlobalOptions;
use crate::envelope::EmitContext;
use crate::hooks::{
    HookEvent, HookHost, doctor_host, install_host, print_hook_stdout, run_event, uninstall_host,
};
use crate::output::emit_command;

#[derive(Debug, Subcommand)]
pub enum HooksCommand {
    /// Write lifecycle hook entries for a host
    Install {
        #[arg(long)]
        host: String,
        #[arg(long)]
        dry_run: bool,
    },
    /// Validate installed lifecycle hooks
    Doctor {
        #[arg(long)]
        host: String,
    },
    /// Remove lifecycle hooks written by this CLI
    Uninstall {
        #[arg(long)]
        host: String,
        #[arg(long)]
        dry_run: bool,
    },
    /// Run a hook event (invoked by host config)
    Run {
        event: String,
        #[arg(long)]
        host: String,
        #[arg(long)]
        limit: Option<i64>,
    },
}

pub async fn run(cmd: HooksCommand, global: &GlobalOptions) -> Result<()> {
    match cmd {
        HooksCommand::Install { host, dry_run } => {
            let host = HookHost::parse(&host)?;
            let report = install_host(host, dry_run)?;
            let ctx = EmitContext::new("hooks install", global);
            emit_command(global, &ctx, &report, Some(1))
        }
        HooksCommand::Doctor { host } => {
            let host = HookHost::parse(&host)?;
            let report = doctor_host(host)?;
            let ctx = EmitContext::new("hooks doctor", global);
            emit_command(global, &ctx, &report, Some(1))
        }
        HooksCommand::Uninstall { host, dry_run } => {
            let host = HookHost::parse(&host)?;
            let report = uninstall_host(host, dry_run)?;
            let ctx = EmitContext::new("hooks uninstall", global);
            emit_command(global, &ctx, &report, Some(1))
        }
        HooksCommand::Run { event, host, limit } => {
            let event = HookEvent::parse(&event)?;
            let host = HookHost::parse(&host)?;
            let report = run_event(global, event, host, limit).await?;
            if global.agent_output() || global.output == crate::cli::OutputFormat::Json {
                let ctx = EmitContext::new("hooks run", global);
                emit_command(
                    global,
                    &ctx,
                    &report,
                    Some(if report.skipped { 0 } else { 1 }),
                )?;
            } else {
                print_hook_stdout(&report)?;
            }
            Ok(())
        }
    }
}

pub fn command_label(cmd: &HooksCommand) -> &'static str {
    match cmd {
        HooksCommand::Install { .. } => "install",
        HooksCommand::Doctor { .. } => "doctor",
        HooksCommand::Uninstall { .. } => "uninstall",
        HooksCommand::Run { .. } => "run",
    }
}
