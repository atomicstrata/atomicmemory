//! Process supervision for managed `am-slm serve` (pidfile, start/stop, stale PID).

use std::fs;
use std::net::TcpListener;
use std::process::{Command, Stdio};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use serde::Serialize;

use super::SLM_CHAT_MODEL;
use super::cache::{apply_slm_cache_env, ensure_cache_roots};
use super::health::{RequiredModels, wait_until_ready};
use super::models::ensure_models_cached;
use super::paths::{SlmPaths, SlmStateFile};
use super::process_identity::{
    ProcessIdentity, capture_process_identity, port_owned_by_pid, process_identity_matches,
};

/// Outcome of a managed start attempt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StartOutcome {
    pub pid: u32,
    pub port: u16,
    pub endpoint: String,
    pub already_running: bool,
}

/// Outcome of a managed stop attempt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StopOutcome {
    pub stopped: bool,
    pub message: String,
}

/// Host env required for Core Full ingest against `am-slm-core` (json_object).
///
/// `AM_SLM_CORE_JSON_SCHEMA=1` installs an llguidance grammar on OpenAI
/// `response_format: json_object` matching Core's default (full) extraction
/// prompt. Do **not** set `AM_SLM_CORE_COMPACT_SCHEMA` until the published
/// Core image honors `EXTRACTION_PROMPT_VARIANT=compact` — compact grammar
/// + full prompt yields `compact_prompt_contract_mismatch` and empty memories.
///
/// TODO(ATO-1936): when Core image ships compact prompt support, restore
/// `AM_SLM_CORE_COMPACT_SCHEMA=1` here and `EXTRACTION_PROMPT_VARIANT=compact`
/// in `core_env` (and optionally fail loud on compact-schema + full-prompt).
pub const SLM_CORE_JSON_SCHEMA_ENV: &str = "AM_SLM_CORE_JSON_SCHEMA";

/// Env entries applied to every managed `am-slm serve` spawn.
pub fn slm_serve_env_entries() -> Vec<(String, String)> {
    vec![(SLM_CORE_JSON_SCHEMA_ENV.into(), "1".into())]
}

/// Published am-slm 0.1.1 honors these; leftover manual-setup values must not
/// leak into a managed child (wrong adapter, or `/v1/*` auth that `check_ready` lacks).
const FORBIDDEN_MANAGED_SERVE_ENV: &[&str] = &["AM_SLM_ADAPTER_PATH", "AM_SLM_API_TOKENS"];

fn external_slm_missing_contract_message(port: u16) -> String {
    format!(
        "am-slm is already listening on port {port} but is not CLI-managed with the Connected Local JSON-schema contract.\nManaged starts export {SLM_CORE_JSON_SCHEMA_ENV}=1 so Core Full ingest (`json_object`) returns a memories array (full extraction grammar; compact deferred until Core image supports EXTRACTION_PROMPT_VARIANT).\nStop the external process, then re-run `am slm start` or `am instance start --slm`, or restart it yourself with that env var set."
    )
}

/// Env entries and cache contract applied to every managed `am-slm serve` spawn.
pub fn configure_serve_command(cmd: &mut Command, paths: &SlmPaths) -> Result<()> {
    configure_serve_command_with_inherited(cmd, paths, &inherited_forbidden_serve_env())
}

fn configure_serve_command_with_inherited(
    cmd: &mut Command,
    paths: &SlmPaths,
    inherited_conflicts: &[&str],
) -> Result<()> {
    refuse_inherited_serve_overrides(inherited_conflicts)?;
    for (key, value) in slm_serve_env_entries() {
        cmd.env(key, value);
    }
    cmd.env_remove("AM_SLM_CORE_COMPACT_SCHEMA");
    for key in FORBIDDEN_MANAGED_SERVE_ENV {
        cmd.env_remove(*key);
    }
    ensure_cache_roots(paths)?;
    apply_slm_cache_env(cmd, paths);
    Ok(())
}

fn inherited_forbidden_serve_env() -> Vec<&'static str> {
    inherited_forbidden_serve_env_from(|key| std::env::var_os(key))
}

fn inherited_forbidden_serve_env_from<F>(lookup: F) -> Vec<&'static str>
where
    F: Fn(&str) -> Option<std::ffi::OsString>,
{
    FORBIDDEN_MANAGED_SERVE_ENV
        .iter()
        .copied()
        .filter(|key| lookup(key).is_some_and(|value| !value.is_empty()))
        .collect()
}

fn refuse_inherited_serve_overrides(conflicts: &[&str]) -> Result<()> {
    if conflicts.is_empty() {
        return Ok(());
    }
    let listed = conflicts.join(" and ");
    bail!(
        "refusing managed am-slm start: inherited {listed} override the locked Connected Local runtime.\n\
         Unset {listed} and re-run `am slm start` or `am instance start --slm`."
    )
}

/// Ownership-aware reuse / port conflict check. Does not inspect the disk cache.
pub async fn preflight_managed_start(
    client: &reqwest::Client,
    paths: &SlmPaths,
    port: u16,
    wait: Duration,
) -> Result<Option<StartOutcome>> {
    let binary = paths.binary();
    if !binary.is_file() {
        bail!(
            "am-slm binary not installed at {} — run `am slm install` first",
            binary.display()
        );
    }

    let endpoint = format!("http://127.0.0.1:{port}");
    let state = paths.read_state().unwrap_or_default();
    let has_json_schema_contract = state.json_schema_contract;

    if let Ok(models) = probe_models(client, &endpoint).await
        && models.chat
        && models.embed
    {
        if !state.managed_process {
            bail!("{}", external_slm_missing_contract_message(port));
        }
        if has_json_schema_contract {
            if let Some(pid) = managed_pid(&state, paths)
                && trusted_managed_listener(&state, pid, port)
            {
                return Ok(Some(StartOutcome {
                    pid,
                    port,
                    endpoint,
                    already_running: true,
                }));
            }
            clear_stale_managed_state(paths).await?;
            bail!("{}", external_slm_missing_contract_message(port));
        }
        if let Some(pid) = managed_pid(&state, paths) {
            if recorded_identity_matches(&state, pid) {
                let _ = stop_runtime(paths).await;
            } else {
                clear_stale_managed_state(paths).await?;
            }
        }
    } else if let Some(pid) = managed_pid(&state, paths)
        && process_alive(pid)
    {
        if !state.managed_process {
            bail!("{}", external_slm_missing_contract_message(port));
        }
        if has_json_schema_contract && recorded_identity_matches(&state, pid) {
            wait_until_ready(client, &endpoint, wait).await?;
            if !trusted_managed_listener(&state, pid, port) {
                bail!("{}", external_slm_missing_contract_message(port));
            }
            return Ok(Some(StartOutcome {
                pid,
                port,
                endpoint,
                already_running: true,
            }));
        }
        if recorded_identity_matches(&state, pid) {
            let _ = stop_runtime(paths).await;
        } else {
            clear_stale_managed_state(paths).await?;
        }
    }

    if port_in_use(port) {
        bail!(
            "port {port} is already in use by a non-ready process — stop it or choose another port"
        );
    }
    Ok(None)
}

/// Start managed `am-slm serve` (idempotent when healthy on the same port).
pub async fn start_runtime(
    client: &reqwest::Client,
    paths: &SlmPaths,
    port: u16,
    wait: Duration,
) -> Result<StartOutcome> {
    if let Some(outcome) = preflight_managed_start(client, paths, port, wait).await? {
        return Ok(outcome);
    }
    ensure_models_cached(paths).await?;
    spawn_managed_serve(client, paths, port, wait).await
}

async fn spawn_managed_serve(
    client: &reqwest::Client,
    paths: &SlmPaths,
    port: u16,
    wait: Duration,
) -> Result<StartOutcome> {
    let binary = paths.binary();
    let endpoint = format!("http://127.0.0.1:{port}");
    paths.ensure()?;
    let log_file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(paths.log_path())
        .context("open am-slm.log")?;
    let log_err = log_file.try_clone().context("clone am-slm.log handle")?;

    let mut cmd = Command::new(&binary);
    cmd.args([
        "serve",
        "--host",
        "127.0.0.1",
        "--port",
        &port.to_string(),
        "--model",
        SLM_CHAT_MODEL,
    ])
    .stdin(Stdio::null())
    .stdout(Stdio::from(log_file))
    .stderr(Stdio::from(log_err));
    configure_serve_command(&mut cmd, paths)?;
    let mut child = cmd
        .spawn()
        .with_context(|| format!("spawn {}", binary.display()))?;

    let pid = child.id();
    write_pidfile(paths, pid)?;

    let mut state = paths.read_state()?;
    state.managed_process = true;
    state.json_schema_contract = true;
    state.pid = Some(pid);
    state.port = Some(port);
    state.process_start_stamp = capture_process_identity(pid).map(|id| id.start_stamp);
    state.binary_path = Some(binary.display().to_string());
    state.log_path = Some(paths.log_path().display().to_string());
    paths.write_state(&state)?;

    match wait_until_ready(client, &endpoint, wait).await {
        Ok(()) => {
            let state = paths.read_state().unwrap_or_default();
            if !trusted_managed_listener(&state, pid, port) {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stop_runtime(paths).await;
                bail!("{}", external_slm_missing_contract_message(port));
            }
            Ok(StartOutcome {
                pid,
                port,
                endpoint,
                already_running: false,
            })
        }
        Err(err) => {
            let _ = child.kill();
            let _ = child.wait();
            let _ = stop_runtime(paths).await;
            Err(err).context("am-slm serve started but failed readiness (/health + /v1/models)")
        }
    }
}

/// Stop only a CLI-managed process (never kill an external listener blindly).
pub async fn stop_runtime(paths: &SlmPaths) -> Result<StopOutcome> {
    let mut state = paths.read_state()?;
    let Some(pid) = state.pid.or_else(|| read_pidfile(paths)) else {
        clear_managed_process_files(paths, &mut state);
        paths.write_state(&state)?;
        return Ok(StopOutcome {
            stopped: false,
            message: "no managed am-slm process recorded".into(),
        });
    };

    if !state.managed_process {
        return Ok(StopOutcome {
            stopped: false,
            message: "am-slm process is not CLI-managed — refusing to stop".into(),
        });
    }

    if !process_alive(pid) {
        clear_managed_process_files(paths, &mut state);
        paths.write_state(&state)?;
        return Ok(StopOutcome {
            stopped: false,
            message: format!("managed pid {pid} already exited (cleared stale pidfile)"),
        });
    }

    if !recorded_identity_matches(&state, pid) {
        clear_managed_process_files(paths, &mut state);
        paths.write_state(&state)?;
        return Ok(StopOutcome {
            stopped: false,
            message: format!(
                "refusing to signal pid {pid}: recorded am-slm start identity is missing or no longer matches (cleared stale ownership). Stop any leftover listener yourself, then re-run `am slm start`"
            ),
        });
    }

    terminate_pid(pid)?;
    tokio::time::sleep(Duration::from_millis(400)).await;
    // Recheck start identity before SIGKILL: the PID can be recycled in the
    // wait window. Existence alone is not ownership.
    if should_force_kill(&state, pid) {
        force_kill_pid(pid)?;
    }

    clear_managed_process_files(paths, &mut state);
    paths.write_state(&state)?;

    Ok(StopOutcome {
        stopped: true,
        message: format!("stopped managed am-slm pid {pid}"),
    })
}

fn managed_pid(state: &SlmStateFile, paths: &SlmPaths) -> Option<u32> {
    state.pid.or_else(|| read_pidfile(paths))
}

fn recorded_identity(state: &SlmStateFile, pid: u32) -> Option<ProcessIdentity> {
    state
        .process_start_stamp
        .as_ref()
        .map(|start_stamp| ProcessIdentity {
            pid,
            start_stamp: start_stamp.clone(),
        })
}

fn recorded_identity_matches(state: &SlmStateFile, pid: u32) -> bool {
    match recorded_identity(state, pid) {
        Some(expected) => process_identity_matches(pid, &expected),
        None => false,
    }
}

fn should_force_kill(state: &SlmStateFile, pid: u32) -> bool {
    process_alive(pid) && recorded_identity_matches(state, pid)
}

fn trusted_managed_listener(state: &SlmStateFile, pid: u32, port: u16) -> bool {
    recorded_identity_matches(state, pid) && port > 0 && port_owned_by_pid(port, pid)
}

async fn clear_stale_managed_state(paths: &SlmPaths) -> Result<()> {
    let mut state = paths.read_state()?;
    clear_managed_process_files(paths, &mut state);
    paths.write_state(&state)
}

fn clear_managed_process_files(paths: &SlmPaths, state: &mut SlmStateFile) {
    clear_pidfile(paths);
    state.managed_process = false;
    state.json_schema_contract = false;
    state.pid = None;
    state.process_start_stamp = None;
}

async fn probe_models(client: &reqwest::Client, endpoint: &str) -> Result<RequiredModels> {
    super::health::check_ready(client, endpoint).await
}

fn port_in_use(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_err()
}

fn read_pidfile(paths: &SlmPaths) -> Option<u32> {
    let raw = fs::read_to_string(paths.pid_path()).ok()?;
    raw.trim().parse().ok()
}

fn write_pidfile(paths: &SlmPaths, pid: u32) -> Result<()> {
    paths.ensure()?;
    fs::write(paths.pid_path(), format!("{pid}\n")).context("write am-slm pidfile")
}

fn clear_pidfile(paths: &SlmPaths) {
    let _ = fs::remove_file(paths.pid_path());
}

pub fn pid_alive(pid: u32) -> bool {
    process_alive(pid)
}

#[cfg(unix)]
fn process_alive(pid: u32) -> bool {
    // `/bin/kill -0` — existence check without linking libc.
    Command::new("/bin/kill")
        .args(["-0", &pid.to_string()])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn process_alive(_pid: u32) -> bool {
    // Managed SLM process control is Apple Silicon / Unix-only.
    false
}

#[cfg(unix)]
fn terminate_pid(pid: u32) -> Result<()> {
    let status = Command::new("/bin/kill")
        .args(["-TERM", &pid.to_string()])
        .status()
        .with_context(|| format!("send SIGTERM to am-slm pid {pid}"))?;
    if !status.success() && process_alive(pid) {
        bail!("failed to SIGTERM am-slm pid {pid}");
    }
    Ok(())
}

#[cfg(not(unix))]
fn terminate_pid(_pid: u32) -> Result<()> {
    bail!("managed am-slm process control is Apple Silicon only")
}

#[cfg(unix)]
fn force_kill_pid(pid: u32) -> Result<()> {
    let _ = Command::new("/bin/kill")
        .args(["-KILL", &pid.to_string()])
        .status();
    Ok(())
}

#[cfg(not(unix))]
fn force_kill_pid(_pid: u32) -> Result<()> {
    bail!("managed am-slm process control is Apple Silicon only")
}

/// Tail the managed log file (best-effort).
pub fn read_log_tail(paths: &SlmPaths, max_bytes: usize) -> Result<String> {
    let path = paths.log_path();
    if !path.exists() {
        return Ok(String::new());
    }
    let data = fs::read(&path).context("read am-slm.log")?;
    if data.len() <= max_bytes {
        return Ok(String::from_utf8_lossy(&data).into_owned());
    }
    Ok(String::from_utf8_lossy(&data[data.len() - max_bytes..]).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn pidfile_round_trip() {
        let dir = tempdir().unwrap();
        let paths = SlmPaths::at(dir.path().to_path_buf());
        write_pidfile(&paths, 12345).unwrap();
        assert_eq!(read_pidfile(&paths), Some(12345));
        clear_pidfile(&paths);
        assert_eq!(read_pidfile(&paths), None);
    }

    #[test]
    fn port_free_on_ephemeral() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(port_in_use(port));
        drop(listener);
        // Another process can briefly race the freed ephemeral port in CI.
        let free = (0..20).any(|_| {
            if !port_in_use(port) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(10));
            false
        });
        assert!(
            free,
            "ephemeral port {port} stayed busy after listener drop"
        );
    }

    #[test]
    #[cfg(unix)]
    fn process_alive_current_pid() {
        let pid = std::process::id();
        assert!(process_alive(pid));
        assert!(!process_alive(1_000_000_001));
    }

    #[test]
    #[cfg(unix)]
    fn force_kill_requires_live_recorded_identity() {
        let pid = std::process::id();
        let identity = capture_process_identity(pid).expect("current process identity");
        let matching = SlmStateFile {
            process_start_stamp: Some(identity.start_stamp),
            ..SlmStateFile::default()
        };
        assert!(should_force_kill(&matching, pid));
        let stale = SlmStateFile {
            process_start_stamp: Some("stale-start-stamp".into()),
            ..SlmStateFile::default()
        };
        assert!(!should_force_kill(&stale, pid));
        assert!(!should_force_kill(&SlmStateFile::default(), pid));
        assert!(!should_force_kill(&matching, 1_000_000_001));
    }

    #[test]
    #[cfg(not(unix))]
    fn process_alive_is_false_on_non_unix() {
        assert!(!process_alive(std::process::id()));
        assert!(terminate_pid(1).is_err());
        assert!(force_kill_pid(1).is_err());
    }

    #[test]
    fn serve_env_includes_json_schema_only() {
        let entries = slm_serve_env_entries();
        assert!(
            entries
                .iter()
                .any(|(k, v)| k == SLM_CORE_JSON_SCHEMA_ENV && v == "1")
        );
        assert!(
            entries
                .iter()
                .all(|(k, _)| k != "AM_SLM_CORE_COMPACT_SCHEMA"),
            "compact schema deferred until Core image ships EXTRACTION_PROMPT_VARIANT"
        );
        assert_eq!(entries.len(), 1);
    }

    #[test]
    fn external_missing_contract_message_names_json_schema() {
        let msg = external_slm_missing_contract_message(8080);
        assert!(msg.contains(SLM_CORE_JSON_SCHEMA_ENV));
        assert!(!msg.contains("AM_SLM_CORE_COMPACT_SCHEMA"));
        assert!(msg.contains("8080"));
    }

    #[test]
    #[cfg(unix)]
    fn serve_command_clears_inherited_compact_schema() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempdir().unwrap();
        let slm_root = dir.path().join("slm");
        let paths = SlmPaths::at(slm_root);
        paths.ensure().unwrap();
        fs::write(
            paths.binary(),
            "#!/bin/sh\nprintf '%s\\n' \"compact=${AM_SLM_CORE_COMPACT_SCHEMA-}\" \"json=${AM_SLM_CORE_JSON_SCHEMA-}\"\n",
        )
        .unwrap();
        fs::set_permissions(paths.binary(), fs::Permissions::from_mode(0o755)).unwrap();

        let mut probe = Command::new(paths.binary());
        probe.env("AM_SLM_CORE_COMPACT_SCHEMA", "1");
        configure_serve_command(&mut probe, &paths).unwrap();
        let serve_output = probe.output().unwrap();
        let serve_stdout = String::from_utf8_lossy(&serve_output.stdout);
        assert!(serve_stdout.contains("json=1"), "got: {serve_stdout}");
        assert!(
            !serve_stdout.contains("compact=1"),
            "configure_serve_command must strip compact schema, got: {serve_stdout}"
        );
    }

    #[test]
    fn inherited_lookup_detects_adapter_and_tokens() {
        let found = inherited_forbidden_serve_env_from(|key| match key {
            "AM_SLM_ADAPTER_PATH" => Some("/tmp/unrelated-adapter".into()),
            "AM_SLM_API_TOKENS" => Some("tok_leftover".into()),
            _ => None,
        });
        assert_eq!(found, vec!["AM_SLM_ADAPTER_PATH", "AM_SLM_API_TOKENS"]);
    }

    #[test]
    fn inherited_lookup_ignores_empty_overrides() {
        let found = inherited_forbidden_serve_env_from(|key| match key {
            "AM_SLM_ADAPTER_PATH" => Some(String::new().into()),
            "AM_SLM_API_TOKENS" => None,
            _ => None,
        });
        assert!(found.is_empty());
        refuse_inherited_serve_overrides(&[]).unwrap();
    }

    #[test]
    fn inherited_adapter_and_tokens_are_refused() {
        let adapter = refuse_inherited_serve_overrides(&["AM_SLM_ADAPTER_PATH"]).unwrap_err();
        assert!(adapter.to_string().contains("AM_SLM_ADAPTER_PATH"));
        assert!(adapter.to_string().contains("Unset"));
        let tokens = refuse_inherited_serve_overrides(&["AM_SLM_API_TOKENS"]).unwrap_err();
        assert!(tokens.to_string().contains("AM_SLM_API_TOKENS"));
        let both = refuse_inherited_serve_overrides(&["AM_SLM_ADAPTER_PATH", "AM_SLM_API_TOKENS"])
            .unwrap_err();
        assert!(
            both.to_string()
                .contains("AM_SLM_ADAPTER_PATH and AM_SLM_API_TOKENS")
        );
    }

    #[test]
    fn configure_serve_rejects_inherited_parent_overrides() {
        let dir = tempdir().unwrap();
        let paths = SlmPaths::at(dir.path().to_path_buf());
        paths.ensure().unwrap();
        let err = configure_serve_command_with_inherited(
            &mut Command::new(paths.binary()),
            &paths,
            &["AM_SLM_ADAPTER_PATH"],
        )
        .expect_err("parent adapter path must fail closed");
        assert!(err.to_string().contains("AM_SLM_ADAPTER_PATH"));
        let err = configure_serve_command_with_inherited(
            &mut Command::new(paths.binary()),
            &paths,
            &["AM_SLM_API_TOKENS"],
        )
        .expect_err("parent API tokens must fail closed");
        assert!(err.to_string().contains("AM_SLM_API_TOKENS"));
    }

    #[test]
    #[cfg(unix)]
    fn serve_command_strips_adapter_and_tokens_from_child() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempdir().unwrap();
        let paths = SlmPaths::at(dir.path().join("slm"));
        paths.ensure().unwrap();
        fs::write(
            paths.binary(),
            "#!/bin/sh\nprintf '%s\\n' \"adapter=${AM_SLM_ADAPTER_PATH-}\" \"tokens=${AM_SLM_API_TOKENS-}\"\n",
        )
        .unwrap();
        fs::set_permissions(paths.binary(), fs::Permissions::from_mode(0o755)).unwrap();

        let mut probe = Command::new(paths.binary());
        probe.env("AM_SLM_ADAPTER_PATH", "/tmp/unrelated-adapter");
        probe.env("AM_SLM_API_TOKENS", "tok_leftover");
        configure_serve_command_with_inherited(&mut probe, &paths, &[]).unwrap();
        let output = probe.output().unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(
            !stdout.contains("adapter=/tmp/unrelated-adapter"),
            "child must not inherit adapter path, got: {stdout}"
        );
        assert!(
            !stdout.contains("tokens=tok_leftover"),
            "child must not inherit API tokens, got: {stdout}"
        );
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn stop_refuses_unrelated_process_for_stale_identity() {
        let mut child = Command::new("sleep")
            .arg("120")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn sleep");
        let pid = child.id();

        let dir = tempdir().unwrap();
        let paths = SlmPaths::at(dir.path().to_path_buf());
        paths
            .write_state(&SlmStateFile {
                managed_process: true,
                json_schema_contract: true,
                pid: Some(pid),
                port: Some(8080),
                process_start_stamp: Some("stale-start-stamp".into()),
                ..SlmStateFile::default()
            })
            .unwrap();
        write_pidfile(&paths, pid).unwrap();

        let outcome = stop_runtime(&paths).await.unwrap();
        assert!(!outcome.stopped);
        assert!(outcome.message.contains("refusing to signal"));
        assert!(super::pid_alive(pid));

        child.kill().ok();
        let _ = child.wait();
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn stop_refuses_missing_start_stamp_even_when_pid_owns_port() {
        let (mut child, port) = spawn_python_listener();
        let pid = child.id();

        let dir = tempdir().unwrap();
        let paths = SlmPaths::at(dir.path().to_path_buf());
        paths
            .write_state(&SlmStateFile {
                managed_process: true,
                json_schema_contract: true,
                pid: Some(pid),
                port: Some(port),
                process_start_stamp: None,
                ..SlmStateFile::default()
            })
            .unwrap();
        write_pidfile(&paths, pid).unwrap();

        let outcome = stop_runtime(&paths).await.unwrap();
        assert!(!outcome.stopped);
        assert!(outcome.message.contains("refusing to signal"));
        assert!(
            super::pid_alive(pid),
            "legacy state must not kill the listener"
        );

        child.kill().ok();
        let _ = child.wait();
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn stop_terminates_identified_child_before_listener() {
        let mut child = Command::new("sleep")
            .arg("120")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn sleep");
        let pid = child.id();
        let identity = capture_process_identity(pid).expect("sleep identity");

        let dir = tempdir().unwrap();
        let paths = SlmPaths::at(dir.path().to_path_buf());
        paths
            .write_state(&SlmStateFile {
                managed_process: true,
                json_schema_contract: true,
                pid: Some(pid),
                port: Some(8080),
                process_start_stamp: Some(identity.start_stamp),
                ..SlmStateFile::default()
            })
            .unwrap();
        write_pidfile(&paths, pid).unwrap();

        let outcome = stop_runtime(&paths).await.unwrap();
        assert!(outcome.stopped, "{}", outcome.message);
        let _ = child.wait();
        assert!(!super::pid_alive(pid));
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn start_kills_child_when_readiness_fails() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempdir().unwrap();
        let paths = SlmPaths::at(dir.path().to_path_buf());
        paths.ensure().unwrap();
        let marker = dir.path().join("child.pid");
        let ready = include_str!("../../tests/fixtures/am-slm-models-status.json");
        let script = format!(
            "#!/bin/sh\n\
             if [ \"$1\" = models ]; then\n\
               printf '%s\\n' '{ready}'\n\
               exit 0\n\
             fi\n\
             printf '%s\\n' \"$$\" > '{marker}'\n\
             exec sleep 120\n",
            ready = ready.replace('\'', "'\\''"),
            marker = marker.display()
        );
        fs::write(paths.binary(), script).unwrap();
        fs::set_permissions(paths.binary(), fs::Permissions::from_mode(0o755)).unwrap();

        let port = {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.local_addr().unwrap().port()
        };
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(2))
            .build()
            .unwrap();
        let err = start_runtime(&client, &paths, port, Duration::from_millis(400))
            .await
            .expect_err("readiness must fail");
        assert!(err.to_string().contains("readiness"));

        let child_pid: u32 = fs::read_to_string(&marker)
            .unwrap_or_else(|_| panic!("child pid marker missing: {err}"))
            .trim()
            .parse()
            .unwrap();
        assert!(
            !super::pid_alive(child_pid),
            "failed start must terminate the spawned child"
        );
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn waiting_start_refuses_foreign_listener_that_becomes_ready() {
        use std::os::unix::fs::PermissionsExt;

        let (mut http, port) = spawn_python_http_ready_after_503();
        let mut child = Command::new("sleep")
            .arg("120")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn sleep");
        let pid = child.id();
        let identity = capture_process_identity(pid).expect("sleep identity");

        let dir = tempdir().unwrap();
        let paths = SlmPaths::at(dir.path().to_path_buf());
        paths.ensure().unwrap();
        fs::write(paths.binary(), "#!/bin/sh\nexit 1\n").unwrap();
        fs::set_permissions(paths.binary(), fs::Permissions::from_mode(0o755)).unwrap();
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
        write_pidfile(&paths, pid).unwrap();

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(2))
            .build()
            .unwrap();
        let err = start_runtime(&client, &paths, port, Duration::from_secs(3))
            .await
            .expect_err("foreign listener must not be adopted");
        assert!(
            err.to_string().contains("not CLI-managed"),
            "expected foreign-listener refusal, got: {err}"
        );
        assert!(
            super::pid_alive(pid),
            "identified child is not the listener"
        );

        child.kill().ok();
        let _ = child.wait();
        http.kill().ok();
        let _ = http.wait();
    }

    #[cfg(unix)]
    fn spawn_python_listener() -> (std::process::Child, u16) {
        use std::io::{BufRead, BufReader};

        let mut child = Command::new("python3")
            .args([
                "-c",
                "import socket, sys, time\n\
                 s = socket.socket(); s.bind(('127.0.0.1', 0)); s.listen(1)\n\
                 sys.stdout.write(str(s.getsockname()[1]) + '\\n'); sys.stdout.flush()\n\
                 time.sleep(120)\n",
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn python listener");
        let stdout = child.stdout.take().expect("listener stdout");
        let mut line = String::new();
        BufReader::new(stdout)
            .read_line(&mut line)
            .expect("read listener port");
        let port: u16 = line.trim().parse().expect("listener port");
        (child, port)
    }

    #[cfg(unix)]
    fn spawn_python_http_ready_after_503() -> (std::process::Child, u16) {
        use std::io::{BufRead, BufReader};

        let dir = tempdir().unwrap();
        let script_path = dir.path().join("ready_after_503.py");
        let script = r#"
from http.server import BaseHTTPRequestHandler, HTTPServer
import json

class H(BaseHTTPRequestHandler):
    hits = 0
    def do_GET(self):
        H.hits += 1
        if H.hits == 1:
            self.send_response(503)
            self.end_headers()
            return
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
        // Keep the temp dir alive for the child by leaking it for the test process.
        std::mem::forget(dir);
        let mut child = Command::new("python3")
            .arg(&script_path)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn python http");
        let stdout = child.stdout.take().expect("http stdout");
        let mut line = String::new();
        BufReader::new(stdout)
            .read_line(&mut line)
            .expect("read http port");
        let port: u16 = line.trim().parse().unwrap_or_else(|_| {
            let stderr = child.stderr.take().map(|mut err| {
                let mut buf = String::new();
                let _ = std::io::Read::read_to_string(&mut err, &mut buf);
                buf
            });
            panic!("http port {line:?}; stderr={stderr:?}");
        });
        (child, port)
    }
}
