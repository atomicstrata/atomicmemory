//! `am slm` — install/manage the host Metal SLM runtime (ATO-1936).

use std::io::{self, IsTerminal};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use clap::Subcommand;
use serde::Serialize;

use crate::cli::GlobalOptions;
use crate::output::{emit, message};
use crate::progress::progress_for;
use crate::slm::{
    BootstrapConfirm, DEFAULT_SLM_PORT, RequiredModels, bootstrap_managed_slm, check_ready,
    collect_status, confirm_models_pull, default_slm_paths, install_or_update,
    manifest_url_from_env, pull_models, read_log_tail, status_models_json, stop_runtime, uninstall,
};

const READY_WAIT: Duration = Duration::from_secs(90);

#[derive(Debug, Subcommand)]
pub enum SlmCommand {
    /// Download and install the managed `am-slm` binary from the public manifest
    Install,
    /// Update the managed binary when a newer manifest version is published
    Update,
    /// Show managed runtime / model / health status (stable JSON)
    Status,
    /// Start `am-slm serve` and wait until `/health` + required models are ready
    Start {
        /// Listen port (default 8080)
        #[arg(long, default_value_t = DEFAULT_SLM_PORT)]
        port: u16,
        /// Confirm SLM model download (~1.7GB) without prompting
        #[arg(long)]
        yes: bool,
    },
    /// Stop the CLI-managed `am-slm` process
    Stop,
    /// Tail the managed runtime log
    Logs {
        /// Max bytes to print from the end of the log
        #[arg(long, default_value_t = 16_384)]
        bytes: usize,
    },
    /// Remove the managed binary (and optionally model cache)
    Uninstall {
        /// Also delete the downloaded model cache (~1.7GB)
        #[arg(long)]
        purge_models: bool,
        /// Confirm destructive uninstall
        #[arg(long)]
        yes: bool,
    },
    /// Model cache lifecycle
    #[command(subcommand)]
    Models(SlmModelsCommand),
}

#[derive(Debug, Subcommand)]
pub enum SlmModelsCommand {
    /// Download model weights (~1.7GB; requires `--yes` or interactive confirmation)
    Pull {
        /// Pull a specific adapter (default: Qwen + Nomic + am-slm-core)
        #[arg(long)]
        adapter: Option<String>,
        /// Confirm the large download without prompting
        #[arg(long)]
        yes: bool,
    },
    /// Show model cache status (`am-slm models status --json`)
    Status,
}

pub async fn run(cmd: SlmCommand, global: &GlobalOptions) -> Result<()> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .context("build HTTP client")?;
    let paths = default_slm_paths()?;
    let manifest_url = manifest_url_from_env();

    match cmd {
        SlmCommand::Install | SlmCommand::Update => {
            let outcome = install_or_update(&client, &paths, &manifest_url).await?;
            emit(global.output, &outcome, global.quiet)?;
            if !global.quiet {
                message(
                    true,
                    &format!(
                        "am-slm {} installed at {}{}",
                        outcome.version,
                        outcome.binary_path.display(),
                        if outcome.replaced_existing {
                            " (replaced existing)"
                        } else {
                            ""
                        }
                    ),
                );
                message(
                    true,
                    "Next: am slm models pull --yes && am slm start  (or am init --local --slm)",
                );
            }
        }
        SlmCommand::Status => {
            let endpoint = format!(
                "http://127.0.0.1:{}",
                paths
                    .read_state()
                    .ok()
                    .and_then(|s| s.port)
                    .unwrap_or(DEFAULT_SLM_PORT)
            );
            let models = check_ready(&client, &endpoint).await.ok();
            let health_ok = models
                .as_ref()
                .map(|m: &RequiredModels| m.ready())
                .unwrap_or(false);
            let status = collect_status(&client, &paths, None, models, health_ok).await?;
            emit(global.output, &status, global.quiet)?;
        }
        SlmCommand::Start { port, yes } => {
            let allow_prompt = global.allow_prompts(yes) && io::stdin().is_terminal();
            let quiet = global.quiet || global.output == crate::cli::OutputFormat::Json;
            let outcome = bootstrap_managed_slm(
                &client,
                &paths,
                BootstrapConfirm { yes, allow_prompt },
                port,
                READY_WAIT,
                |step| {
                    if !quiet {
                        message(true, step);
                    }
                },
            )
            .await?;
            emit(global.output, &outcome, global.quiet)?;
            if !global.quiet {
                message(
                    true,
                    &format!(
                        "am-slm ready on {} (pid {}, already_running={})",
                        outcome.endpoint, outcome.pid, outcome.already_running
                    ),
                );
            }
        }
        SlmCommand::Stop => {
            let outcome = stop_runtime(&paths).await?;
            emit(global.output, &outcome, global.quiet)?;
            if !global.quiet {
                message(true, &outcome.message);
            }
        }
        SlmCommand::Logs { bytes } => {
            let tail = read_log_tail(&paths, bytes)?;
            if global.output == crate::cli::OutputFormat::Json {
                #[derive(Serialize)]
                struct LogsOut<'a> {
                    log: &'a str,
                }
                emit(global.output, &LogsOut { log: &tail }, global.quiet)?;
            } else {
                print!("{tail}");
            }
        }
        SlmCommand::Uninstall { purge_models, yes } => {
            if !yes {
                bail!("refusing to uninstall without `--yes`");
            }
            let _ = stop_runtime(&paths).await;
            uninstall(&paths, purge_models)?;
            #[derive(Serialize)]
            struct UninstallOut {
                uninstalled: bool,
                purged_models: bool,
            }
            emit(
                global.output,
                &UninstallOut {
                    uninstalled: true,
                    purged_models: purge_models,
                },
                global.quiet,
            )?;
            if !global.quiet {
                message(
                    true,
                    if purge_models {
                        "am-slm uninstalled (models purged)"
                    } else {
                        "am-slm uninstalled (model cache retained)"
                    },
                );
            }
        }
        SlmCommand::Models(models_cmd) => match models_cmd {
            SlmModelsCommand::Pull { adapter, yes } => {
                let allow_prompt = global.allow_prompts(yes) && io::stdin().is_terminal();
                if !confirm_models_pull(yes, allow_prompt)? {
                    bail!("model download cancelled");
                }
                let mut progress = progress_for(global);
                progress.start_step("models", "Download SLM models");
                let result = pull_models(&paths, adapter.as_deref(), |detail| {
                    progress.tick("models", detail)
                })
                .await;
                match &result {
                    Ok(_) => progress.succeed("models", Some("download complete")),
                    Err(_) => progress.fail(
                        "models",
                        Some("cache retained; retry with am slm models pull --yes"),
                    ),
                }
                progress.finish();
                let outcome = result?;
                emit(global.output, &outcome, global.quiet)?;
                if !global.quiet {
                    message(true, &outcome.message);
                }
            }
            SlmModelsCommand::Status => {
                let value = status_models_json(&paths).await?;
                emit(global.output, &value, global.quiet)?;
            }
        },
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    #[derive(Debug, Parser)]
    struct Probe {
        #[command(subcommand)]
        cmd: SlmCommand,
    }

    #[test]
    fn parses_install_and_models_pull_yes() {
        let p = Probe::try_parse_from(["slm", "install"]).unwrap();
        assert!(matches!(p.cmd, SlmCommand::Install));
        let p = Probe::try_parse_from(["slm", "models", "pull", "--yes"]).unwrap();
        match p.cmd {
            SlmCommand::Models(SlmModelsCommand::Pull { yes, .. }) => assert!(yes),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn parses_start_yes_and_adapter_pull() {
        let p = Probe::try_parse_from(["slm", "start", "--yes"]).unwrap();
        match p.cmd {
            SlmCommand::Start { yes, .. } => assert!(yes),
            other => panic!("unexpected {other:?}"),
        }
        let p =
            Probe::try_parse_from(["slm", "models", "pull", "--adapter", "am-slm-core"]).unwrap();
        match p.cmd {
            SlmCommand::Models(SlmModelsCommand::Pull { adapter, yes }) => {
                assert_eq!(adapter.as_deref(), Some("am-slm-core"));
                assert!(!yes);
            }
            other => panic!("unexpected {other:?}"),
        }
    }
}
