//! Cold-start bootstrap: install → confirmed pull → serve (ATO-1936 follow-up).

use std::time::Duration;

use anyhow::{Context, Result, bail};

use super::cache::slm_hf_home;
use super::confirm_models_pull;
use super::install::install_or_update;
use super::manifest_url_from_env;
use super::models::{pull_models, status_models_json};
use super::models_cache_ready_with_disk;
use super::paths::SlmPaths;
use super::process::{StartOutcome, preflight_managed_start, start_runtime};

/// Confirmation policy for the ~1.7GB model download.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BootstrapConfirm {
    pub yes: bool,
    pub allow_prompt: bool,
}

/// Whether the managed `am-slm` binary is missing and must be installed.
pub fn runtime_missing(paths: &SlmPaths) -> bool {
    !paths.binary().is_file()
}

/// Disk cache is start-complete (Qwen + Nomic + `am-slm-core`).
pub async fn disk_cache_ready(paths: &SlmPaths) -> Result<bool> {
    if runtime_missing(paths) {
        return Ok(false);
    }
    Ok(models_cache_ready_with_disk(
        &status_models_json(paths).await?,
        &slm_hf_home(paths),
    ))
}

/// Install if needed, pull if cache is incomplete, then start the runtime.
///
/// Reuses a healthy managed listener and rejects a busy port before any
/// download confirmation or model pull.
pub async fn bootstrap_managed_slm(
    client: &reqwest::Client,
    paths: &SlmPaths,
    confirm: BootstrapConfirm,
    port: u16,
    wait: Duration,
    mut report: impl FnMut(&str),
) -> Result<StartOutcome> {
    ensure_runtime_installed(client, paths, &mut report).await?;
    if let Some(outcome) = preflight_managed_start(client, paths, port, wait).await? {
        return Ok(outcome);
    }
    ensure_models_for_start(paths, confirm, &mut report).await?;
    report("starting host Metal SLM");
    start_runtime(client, paths, port, wait).await
}

async fn ensure_runtime_installed(
    client: &reqwest::Client,
    paths: &SlmPaths,
    report: &mut impl FnMut(&str),
) -> Result<()> {
    if !runtime_missing(paths) {
        return Ok(());
    }
    report("installing am-slm");
    install_or_update(client, paths, &manifest_url_from_env())
        .await
        .context("install am-slm before start")?;
    Ok(())
}

async fn ensure_models_for_start(
    paths: &SlmPaths,
    confirm: BootstrapConfirm,
    report: &mut impl FnMut(&str),
) -> Result<()> {
    if disk_cache_ready(paths).await? {
        return Ok(());
    }
    if !confirm_models_pull(confirm.yes, confirm.allow_prompt)? {
        bail!("model download cancelled");
    }
    report("downloading models (~1.7GB)");
    pull_models(paths, None, report).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn missing_binary_needs_install() {
        let dir = tempdir().unwrap();
        let paths = SlmPaths::at(dir.path().to_path_buf());
        paths.ensure().unwrap();
        assert!(runtime_missing(&paths));
        fs::write(paths.binary(), b"x").unwrap();
        assert!(!runtime_missing(&paths));
    }

    #[test]
    fn confirm_yes_skips_prompt_for_bootstrap() {
        assert!(confirm_models_pull(true, false).unwrap());
        let err = confirm_models_pull(false, false).unwrap_err();
        assert!(err.to_string().contains("--yes"));
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn ready_cache_skips_pull() {
        let (paths, log, _dir) = fake_runtime(COMPLETE);
        let mut steps = Vec::new();
        ensure_models_for_start(
            &paths,
            BootstrapConfirm {
                yes: false,
                allow_prompt: false,
            },
            &mut |step| steps.push(step.to_string()),
        )
        .await
        .unwrap();
        assert!(steps.is_empty());
        assert!(!log.exists() || fs::read_to_string(&log).unwrap().is_empty());
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn incomplete_cache_without_yes_refuses() {
        let (paths, log, _dir) = fake_runtime(INCOMPLETE);
        let err = ensure_models_for_start(
            &paths,
            BootstrapConfirm {
                yes: false,
                allow_prompt: false,
            },
            &mut |_| {},
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("--yes"));
        assert!(!log.exists());
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn yes_pulls_when_cache_incomplete() {
        let (paths, log, _dir) = fake_runtime(INCOMPLETE_THEN_READY);
        let mut steps = Vec::new();
        ensure_models_for_start(
            &paths,
            BootstrapConfirm {
                yes: true,
                allow_prompt: false,
            },
            &mut |step| steps.push(step.to_string()),
        )
        .await
        .unwrap();
        assert_eq!(steps, ["downloading models (~1.7GB)"]);
        let recorded = fs::read_to_string(&log).unwrap();
        assert!(recorded.contains("models pull"));
        assert!(recorded.contains("--adapter am-slm-core"));
    }

    #[cfg(unix)]
    const COMPLETE: &str = include_str!("../../tests/fixtures/am-slm-models-status.json");
    #[cfg(unix)]
    const INCOMPLETE: &str =
        include_str!("../../tests/fixtures/am-slm-models-status-incomplete.json");
    #[cfg(unix)]
    const INCOMPLETE_THEN_READY: &str = "__toggle__";

    #[cfg(unix)]
    fn fake_runtime(mode: &str) -> (SlmPaths, std::path::PathBuf, tempfile::TempDir) {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let paths = SlmPaths::at(dir.path().to_path_buf());
        paths.ensure().unwrap();
        let log = dir.path().join("pull.log");
        let script = fake_runtime_script(mode, &log, dir.path().join("status-state"));
        fs::write(paths.binary(), script).unwrap();
        fs::set_permissions(paths.binary(), fs::Permissions::from_mode(0o755)).unwrap();
        (paths, log, dir)
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn reuses_healthy_listener_without_download_confirm() {
        use crate::slm::paths::SlmStateFile;
        use crate::slm::process_identity::capture_process_identity;
        use std::os::unix::fs::PermissionsExt;

        let (mut http, port) = spawn_ready_http();
        let pid = http.id();
        let identity = capture_process_identity(pid).expect("http identity");
        let (paths, log, _dir) = fake_runtime(INCOMPLETE);
        paths
            .write_state(&SlmStateFile {
                managed_process: true,
                json_schema_contract: true,
                pid: Some(pid),
                port: Some(port),
                process_start_stamp: Some(identity.start_stamp),
                ..SlmStateFile::default()
            })
            .unwrap();
        fs::write(paths.pid_path(), format!("{pid}\n")).unwrap();
        fs::set_permissions(paths.binary(), fs::Permissions::from_mode(0o755)).unwrap();

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(2))
            .build()
            .unwrap();
        let outcome = bootstrap_managed_slm(
            &client,
            &paths,
            BootstrapConfirm {
                yes: false,
                allow_prompt: false,
            },
            port,
            Duration::from_secs(2),
            |_| {},
        )
        .await
        .expect("reuse healthy listener");
        assert!(outcome.already_running);
        assert_eq!(outcome.pid, pid);
        assert!(!log.exists() || fs::read_to_string(&log).unwrap().is_empty());

        http.kill().ok();
        let _ = http.wait();
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn rejects_busy_port_before_model_pull() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (paths, log, _dir) = fake_runtime(INCOMPLETE);
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(2))
            .build()
            .unwrap();
        let err = bootstrap_managed_slm(
            &client,
            &paths,
            BootstrapConfirm {
                yes: true,
                allow_prompt: false,
            },
            port,
            Duration::from_secs(1),
            |_| {},
        )
        .await
        .expect_err("busy port must fail before pull");
        assert!(
            err.to_string().contains("already in use"),
            "expected port conflict, got: {err}"
        );
        assert!(!log.exists() || fs::read_to_string(&log).unwrap().is_empty());
        drop(listener);
    }

    #[cfg(unix)]
    fn spawn_ready_http() -> (std::process::Child, u16) {
        use std::io::{BufRead, BufReader};
        use std::process::{Command, Stdio};

        let dir = tempfile::tempdir().unwrap();
        let script_path = dir.path().join("ready.py");
        let script = r#"
from http.server import BaseHTTPRequestHandler, HTTPServer
import json

class H(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.endswith('/health'):
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'ok')
            return
        if self.path.endswith('/v1/models'):
            body = json.dumps({"data":[{"id":"__CHAT__"},{"id":"__EMBED__"}]}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_response(404)
        self.end_headers()
    def log_message(self, *args):
        pass

server = HTTPServer(('127.0.0.1', 0), H)
print(server.server_address[1], flush=True)
server.serve_forever()
"#
        .replace("__CHAT__", crate::slm::SLM_CHAT_MODEL)
        .replace("__EMBED__", crate::slm::SLM_EMBED_MODEL);
        fs::write(&script_path, script).unwrap();
        std::mem::forget(dir);
        let mut child = Command::new("python3")
            .arg(&script_path)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn python http");
        let stdout = child.stdout.take().expect("http stdout");
        let mut line = String::new();
        BufReader::new(stdout)
            .read_line(&mut line)
            .expect("read http port");
        let port: u16 = line.trim().parse().expect("http port");
        (child, port)
    }

    #[cfg(unix)]
    fn fake_runtime_script(mode: &str, log: &std::path::Path, state: std::path::PathBuf) -> String {
        let complete = COMPLETE.replace('\'', "'\\''");
        let incomplete = INCOMPLETE.replace('\'', "'\\''");
        if mode == INCOMPLETE_THEN_READY {
            format!(
                "#!/bin/sh\n\
                 if [ \"$1\" = models ] && [ \"$2\" = pull ]; then\n\
                   echo \"$*\" >> '{log}'\n\
                   echo pulled > '{state}'\n\
                   exit 0\n\
                 fi\n\
                 if [ \"$1\" = models ] && [ \"$2\" = status ]; then\n\
                   if [ -f '{state}' ]; then printf '%s\\n' '{complete}'; else printf '%s\\n' '{incomplete}'; fi\n\
                   exit 0\n\
                 fi\n\
                 exit 1\n",
                log = log.display(),
                state = state.display(),
            )
        } else {
            format!(
                "#!/bin/sh\n\
                 if [ \"$1\" = models ] && [ \"$2\" = pull ]; then\n\
                   echo \"$*\" >> '{log}'\n\
                   exit 0\n\
                 fi\n\
                 if [ \"$1\" = models ] && [ \"$2\" = status ]; then\n\
                   printf '%s\\n' '{status}'\n\
                   exit 0\n\
                 fi\n\
                 exit 1\n",
                log = log.display(),
                status = mode.replace('\'', "'\\''"),
            )
        }
    }
}
