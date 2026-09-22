//! Public Connected Local auth gates must honor machine-output and prompt flags.

#![cfg(unix)]

use std::process::Command;

#[test]
fn connect_requires_existing_auth_when_prompts_are_disabled() {
    for (global_flags, flags) in [
        (vec![], vec!["--yes"]),
        (vec!["-o", "json"], vec![]),
        (vec!["--quiet"], vec![]),
        (vec![], vec!["--yes", "--device"]),
    ] {
        let home = tempfile::tempdir().unwrap();
        let output = Command::new(env!("CARGO_BIN_EXE_am"))
            .env("HOME", home.path())
            .env("XDG_DATA_HOME", home.path().join("data"))
            .env("XDG_CONFIG_HOME", home.path().join("config"))
            .args(["--no-telemetry", "--base-url", "http://127.0.0.1:9"])
            .args(&global_flags)
            .args(["connect", "--project", "proj_test"])
            .args(&flags)
            .output()
            .unwrap();
        assert!(!output.status.success());
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(stderr.contains("sign-in required"), "{flags:?}: {stderr}");
        assert!(output.stdout.is_empty(), "unexpected login output");
    }
}
