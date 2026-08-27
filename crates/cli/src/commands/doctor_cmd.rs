//! Top-level `am doctor` — auth preflight, connect wiring, optional smoke verify.

use anyhow::Result;
use clap::Args;

use crate::auth::doctor::{DoctorOverrides, report_ok, run_doctor as run_auth_doctor};
use crate::cli::GlobalOptions;
use crate::commands::client::resolve_profile_and_warn;
use crate::commands::connect::{ConnectCommand, ConnectOptions, run as run_connect};
use crate::config::ProfileKind;
use crate::progress::progress_for;
use crate::telemetry::{
    ActivationContext, ActivationEvent, InitStep, capture_activation, capture_step_failure,
};
use crate::verification::smoke::{SmokeOptions, SmokeTelemetry, run_memory_smoke};

#[derive(Debug, Args)]
#[command(about = "Run onboarding health checks (auth, connect wiring, optional smoke)")]
pub struct DoctorOptions {
    /// Ephemeral ingest → search → delete round-trip
    #[arg(long)]
    pub smoke: bool,
}

pub async fn run(opts: DoctorOptions, global: &GlobalOptions) -> Result<()> {
    let mut progress = progress_for(global);
    let result = run_with_progress(opts, global, progress.as_mut()).await;
    progress.finish();
    result
}

async fn run_with_progress(
    opts: DoctorOptions,
    global: &GlobalOptions,
    progress: &mut dyn crate::progress::ProgressReporter,
) -> Result<()> {
    progress.start_step("auth", "Auth preflight");
    let auth_report =
        match run_auth_doctor(global.base_url.clone(), DoctorOverrides::default()).await {
            Ok(report) => report,
            Err(err) => {
                progress.fail("auth", Some(&err.to_string()));
                return Err(err);
            }
        };
    if !report_ok(&auth_report) {
        for hint in &auth_report.hints {
            if !global.quiet && global.output != crate::cli::OutputFormat::Json {
                eprintln!("{hint}");
            }
        }
        progress.fail("auth", Some("preflight failed"));
        anyhow::bail!("auth preflight failed — fix OAuth before continuing");
    }
    progress.succeed("auth", Some("ok"));

    let profile = resolve_profile_and_warn(global)?;
    if profile.kind == ProfileKind::Local {
        progress.start_step("connect", "Connect wiring checks");
        match run_connect(
            ConnectOptions {
                project: None,
                device: false,
                no_instance: false,
                skip_verify: false,
                replace: false,
                command: Some(ConnectCommand::Doctor),
            },
            global,
        )
        .await
        {
            Ok(()) => progress.succeed("connect", Some("ok")),
            Err(err) => {
                progress.fail("connect", Some(&err.to_string()));
                return Err(err);
            }
        }
    } else {
        progress.start_step("connect", "Connect wiring checks");
        progress.warn(
            "connect",
            Some("skipped (cloud profile — use a local profile for Core checks)"),
        );
    }

    if opts.smoke {
        progress.start_step("smoke", "Memory pipeline smoke");
        let mut actx = ActivationContext::local();
        actx.project_id = profile.project_id.clone();
        let smoke_telemetry = SmokeTelemetry {
            no_telemetry: global.no_telemetry,
            props: Some(actx.props()),
        };
        match run_memory_smoke(global, SmokeOptions::default(), Some(smoke_telemetry)).await {
            Ok(smoke) => {
                capture_activation(
                    ActivationEvent::FirstRetrievalCompleted,
                    Some(actx.props()),
                    global.no_telemetry,
                );
                progress.succeed(
                    "smoke",
                    Some(&format!(
                        "verified (marker {}, cleaned {} ids)",
                        smoke.marker,
                        smoke.memory_ids_cleaned.len()
                    )),
                );
            }
            Err(err) => {
                capture_step_failure(
                    InitStep::Smoke,
                    &err,
                    Some(actx.props()),
                    global.no_telemetry,
                );
                progress.fail("smoke", Some(&err.to_string()));
                return Err(err);
            }
        }
    }

    Ok(())
}
