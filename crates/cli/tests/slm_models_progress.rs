//! Public model-pull output and cache recovery contracts with a fake runtime.

#![cfg(unix)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::process::{Command, Output};

struct Fixture {
    home: tempfile::TempDir,
    root: PathBuf,
}

impl Fixture {
    fn new(fail: bool) -> Self {
        let home = tempfile::tempdir().unwrap();
        let root = if cfg!(target_os = "macos") {
            home.path()
                .join("Library/Application Support/ai.atomicstrata.atomicmemory/slm")
        } else {
            home.path().join("data/atomicmemory/slm")
        };
        fs::create_dir_all(root.join("bin")).unwrap();
        let status = include_str!("fixtures/am-slm-models-status.json");
        let script = format!(
            r#"#!/bin/sh
if [ "$2" = status ]; then
    printf '%s\n' '{status}'
    exit 0
fi
if [ "$1" != models ] || [ "$2" != pull ] || [ "$3" != --json ]; then exit 19; fi
printf '%s\n' '{{"event":"model_start","model_id":"qwen"}}' >&2
printf '%s\n' '{{"event":"file_cached","model_id":"qwen","file":"config.json","path":"private-cache-path"}}' >&2
printf '%s\n' '{{"event":"file_start","model_id":"qwen","file":"weights","bytes_total":33554432}}' >&2
printf '%s\n' '{{"event":"file_progress","model_id":"qwen","file":"weights","bytes":8388608}}' >&2
printf '%s\n' 'child stdout must never leak'
printf '%s\n' 'partial bytes' > "$HF_HOME/weights.partial"
exit {exit}
"#,
            exit = if fail { 7 } else { 0 },
        );
        let binary = root.join("bin/am-slm");
        fs::write(&binary, script).unwrap();
        fs::set_permissions(binary, fs::Permissions::from_mode(0o755)).unwrap();
        Self { home, root }
    }

    fn pull(&self, flags: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_am"))
            .env("HOME", self.home.path())
            .env("XDG_DATA_HOME", self.home.path().join("data"))
            .env("XDG_CONFIG_HOME", self.home.path().join("config"))
            .env("AM_NO_TELEMETRY", "1")
            .arg("--no-telemetry")
            .args(flags)
            .args(["slm", "models", "pull", "--yes"])
            .output()
            .unwrap()
    }
}

#[test]
fn json_pull_is_one_valid_result_without_child_stdout() {
    let fixture = Fixture::new(false);
    let output = fixture.pull(&["-o", "json"]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["ok"], true);
    assert!(!String::from_utf8_lossy(&output.stderr).contains("file_progress"));
}

#[test]
fn quiet_pull_suppresses_child_and_reporter_output() {
    let fixture = Fixture::new(false);
    let output = fixture.pull(&["--quiet"]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stdout.is_empty());
    assert!(output.stderr.is_empty());
}

#[test]
fn plain_pull_reports_known_bytes_and_cache_hits() {
    let fixture = Fixture::new(false);
    let output = fixture.pull(&[]);
    assert!(output.status.success());
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(stderr.contains("qwen / config.json — cached"));
    assert!(stderr.contains("8.0 MiB / 32.0 MiB"));
    assert!(!stderr.contains("private-cache-path"));
    assert!(!stderr.contains('\u{1b}'));
}

#[test]
fn failed_pull_keeps_partial_cache_and_gives_retry() {
    let fixture = Fixture::new(true);
    let output = fixture.pull(&[]);
    assert!(!output.status.success());
    assert_eq!(
        fs::read_to_string(fixture.root.join("hf-home/weights.partial")).unwrap(),
        "partial bytes\n"
    );
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(stderr.contains("am slm models pull --yes"));
    assert!(stderr.contains("retained"));
    assert!(stderr.contains("qwen"));
    assert!(!String::from_utf8_lossy(&output.stdout).contains("child stdout"));
}
