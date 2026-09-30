//! `am update` — replace this production binary from the public install mirror.

use std::path::PathBuf;

use anyhow::{Context, Result};
use clap::Args;

use crate::cli::GlobalOptions;
use crate::output::emit;
use crate::update::{GH_PROGRAM, UpdateRequest, parse_attestation_mode, run_update};
use crate::version::{self, CRATE_VERSION, DEFAULT_LATEST_VERSION_BASE_URL};

#[derive(Debug, Args)]
#[command(about = "Replace this production install with the latest published binary")]
pub struct UpdateOptions {
    /// Compare versions and do not download or replace the binary
    #[arg(long)]
    pub check: bool,
}

/// Resolve the running binary and update or check it against the public mirror.
pub async fn run(opts: UpdateOptions, global: &GlobalOptions) -> Result<()> {
    let dest = installed_binary()?;
    let attestation =
        parse_attestation_mode(std::env::var("AM_VERIFY_ATTESTATION").ok().as_deref())?;
    let report = run_update(UpdateRequest {
        base_url: DEFAULT_LATEST_VERSION_BASE_URL,
        build_env: version::compile_time_build_env(),
        current_version: CRATE_VERSION,
        dest: &dest,
        check_only: opts.check,
        quiet: global.quiet,
        attestation,
        gh: std::ffi::OsStr::new(GH_PROGRAM),
    })
    .await?;
    emit(global.output, &report, global.quiet)
}

fn installed_binary() -> Result<PathBuf> {
    let exe = std::env::current_exe().context("locate the running am binary")?;
    exe.canonicalize().context("resolve the installed am path")
}

#[cfg(test)]
mod tests {
    use clap::Parser;

    use crate::cli::{Cli, Command, command_path};

    #[test]
    fn check_flag_parses_as_the_update_command() {
        let cli = Cli::try_parse_from(["am", "update", "--check"]).expect("parse");
        assert_eq!(command_path(&cli.command), "update");
        match cli.command {
            Command::Update(opts) => assert!(opts.check),
            other => panic!("expected update, got {other:?}"),
        }
    }
}
