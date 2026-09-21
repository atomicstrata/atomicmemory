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
use crate::verification::smoke::{SmokeTelemetry, run_memory_smoke};

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
                provider: None,
                slm: false,
                yes: false,
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

    // Soft SLM diagnostics (never fail the doctor solely for unsupported arch).
    progress.start_step("slm", "Connected Local SLM");
    match crate::slm::current_target() {
        None => progress.warn(
            "slm",
            Some(
                "unsupported platform — Apple Silicon macOS only until Linux/Intel artifacts exist",
            ),
        ),
        Some(_) => {
            let paths = match crate::slm::default_slm_paths() {
                Ok(p) => p,
                Err(err) => {
                    progress.fail("slm", Some(&err.to_string()));
                    return Err(err);
                }
            };
            if !paths.binary().is_file() {
                progress.warn(
                    "slm",
                    Some("runtime not installed — run `am slm install` for Connected Local SLM"),
                );
            } else {
                let port = paths
                    .read_state()
                    .ok()
                    .and_then(|s| s.port)
                    .unwrap_or(crate::slm::DEFAULT_SLM_PORT);
                let endpoint = format!("http://127.0.0.1:{port}");
                // Port collision soft check
                if std::net::TcpListener::bind(("127.0.0.1", port)).is_err() {
                    // Something is listening — probe health
                    let client = reqwest::Client::new();
                    match crate::slm::check_ready(&client, &endpoint).await {
                        Ok(models) if models.ready() => {
                            progress.succeed("slm", Some(&format!("runtime healthy on :{port}")));
                        }
                        Ok(_) => progress.warn(
                            "slm",
                            Some("listener on SLM port but required models not advertised"),
                        ),
                        Err(err) => progress
                            .warn("slm", Some(&format!("port {port} busy / unhealthy: {err}"))),
                    }
                } else {
                    let hint = slm_idle_hint(&paths).await;
                    progress.warn("slm", Some(&hint));
                }
            }
        }
    }

    if opts.smoke {
        progress.start_step("smoke", "Memory pipeline smoke");
        let mut actx = ActivationContext::local();
        actx.project_id = profile.project_id.clone();
        let smoke_telemetry = SmokeTelemetry {
            no_telemetry: global.no_telemetry,
            props: Some(actx.props()),
        };
        let smoke_options = crate::instance::smoke_options(&profile).await?;
        match run_memory_smoke(global, smoke_options, Some(smoke_telemetry)).await {
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

async fn slm_idle_hint(paths: &crate::slm::SlmPaths) -> String {
    match crate::slm::status_models_json(paths).await {
        Err(err) => format!(
            "am-slm models status failed: {err} — run `am slm install` (a pull cannot repair this)"
        ),
        Ok(status) => {
            if crate::slm::models_cache_ready_with_disk(&status, &crate::slm::slm_hf_home(paths)) {
                "installed but not running — `am slm start`".into()
            } else {
                "models not cached — run `am slm models pull --yes` then `am slm start`".into()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    #[cfg(unix)]
    async fn idle_hint_surfaces_status_probe_error() {
        use std::fs;
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let paths = crate::slm::SlmPaths::at(dir.path().to_path_buf());
        paths.ensure().unwrap();
        fs::write(paths.binary(), "#!/bin/sh\necho probe-failed >&2\nexit 7\n").unwrap();
        fs::set_permissions(paths.binary(), fs::Permissions::from_mode(0o755)).unwrap();
        let hint = slm_idle_hint(&paths).await;
        assert!(hint.contains("models status failed"), "{hint}");
        assert!(hint.contains("am slm install"), "{hint}");
        assert!(!hint.contains("models pull --yes"), "{hint}");
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn idle_hint_pull_only_after_successful_empty_inspection() {
        use std::fs;
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let paths = crate::slm::SlmPaths::at(dir.path().to_path_buf());
        paths.ensure().unwrap();
        let incomplete = include_str!("../../tests/fixtures/am-slm-models-status-incomplete.json");
        fs::write(
            paths.binary(),
            format!("#!/bin/sh\nprintf '%s\\n' '{incomplete}'\n"),
        )
        .unwrap();
        fs::set_permissions(paths.binary(), fs::Permissions::from_mode(0o755)).unwrap();
        let hint = slm_idle_hint(&paths).await;
        assert!(hint.contains("models pull --yes"), "{hint}");
        assert!(!hint.contains("am slm install"), "{hint}");
    }
}
