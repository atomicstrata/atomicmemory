//! Public OpenCode integration lifecycle against isolated user configuration.

#![cfg(unix)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::process::{Command, Output};

use serde_json::{Value, json};

struct Fixture {
    home: tempfile::TempDir,
    config_home: PathBuf,
    config_path: PathBuf,
    bin_dir: PathBuf,
}

impl Fixture {
    fn new(config: &Value) -> Self {
        let contents = format!("{}\n", serde_json::to_string_pretty(config).unwrap());
        Self::with_config("opencode.json", &contents)
    }

    fn new_jsonc(config: &str) -> Self {
        Self::with_config("opencode.jsonc", config)
    }

    fn with_config(file_name: &str, contents: &str) -> Self {
        let home = tempfile::tempdir().unwrap();
        let config_home = home.path().join("config");
        let opencode_dir = config_home.join("opencode");
        let config_path = opencode_dir.join(file_name);
        let bin_dir = home.path().join("bin");
        fs::create_dir_all(&opencode_dir).unwrap();
        fs::create_dir_all(&bin_dir).unwrap();
        fs::write(&config_path, contents).unwrap();
        let npx = bin_dir.join("npx");
        fs::write(&npx, "#!/bin/sh\nexit 0\n").unwrap();
        fs::set_permissions(npx, fs::Permissions::from_mode(0o755)).unwrap();
        Self {
            home,
            config_home,
            config_path,
            bin_dir,
        }
    }

    fn run(&self, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_am"))
            .env("HOME", self.home.path())
            .env("XDG_CONFIG_HOME", &self.config_home)
            .env("XDG_DATA_HOME", self.home.path().join("data"))
            .env("PATH", &self.bin_dir)
            .env("ATOMICMEMORY_API_KEY", "amc_test")
            .env("USER", "test-user")
            .args(["--no-telemetry", "-o", "json", "integrate"])
            .args(args)
            .output()
            .unwrap()
    }

    fn run_success(&self, args: &[&str]) -> Output {
        let output = self.run(args);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        output
    }

    fn config(&self) -> Value {
        jsonc_parser::parse_to_serde_value(&self.raw_config(), &Default::default()).unwrap()
    }

    fn raw_config(&self) -> String {
        fs::read_to_string(&self.config_path).unwrap()
    }
}

#[test]
fn opencode_install_update_doctor_and_uninstall_lifecycle() {
    let fixture = Fixture::new(&json!({
        "model": "example/model",
        "mcp": { "servers": { "other": { "type": "remote", "url": "https://example.com" } } }
    }));

    fixture.run_success(&["--yes", "--global", "--host", "opencode"]);
    let installed = fixture.config();
    assert_eq!(installed["model"], "example/model");
    assert_eq!(installed["mcp"]["servers"]["atomicmemory"]["type"], "local");
    assert_eq!(
        installed["mcp"]["servers"]["atomicmemory"]["codemode"],
        false
    );
    let command = installed["mcp"]["servers"]["atomicmemory"]["command"]
        .as_array()
        .unwrap();
    assert_eq!(command[0], "npx");
    assert!(
        command
            .iter()
            .any(|part| part == "@atomicmemory/mcp-server@0.1.5")
    );
    assert!(command.iter().any(|part| part == "atomicmemory-mcp"));
    assert_eq!(installed["mcp"]["servers"]["other"]["type"], "remote");

    fixture.run_success(&["--yes", "--global", "--host", "opencode"]);
    assert_eq!(fixture.config(), installed);
    fixture.run_success(&["update", "--host", "opencode"]);
    fixture.run_success(&["update", "--host", "opencode"]);
    assert_eq!(fixture.config(), installed);
    fixture.run_success(&["doctor", "--host", "opencode"]);

    fixture.run_success(&["uninstall", "--host", "opencode"]);
    let removed = fixture.config();
    assert!(removed["mcp"]["servers"].get("atomicmemory").is_none());
    assert_eq!(removed["mcp"]["servers"]["other"]["type"], "remote");
    assert_eq!(removed["model"], "example/model");
}

#[test]
fn opencode_force_install_restores_prior_entry_on_uninstall() {
    let prior = json!({ "type": "remote", "url": "https://prior.example.com/mcp" });
    let fixture = Fixture::new(&json!({
        "mcp": { "servers": { "atomicmemory": prior.clone() } }
    }));

    let refused = fixture.run(&["--yes", "--host", "opencode"]);
    assert!(!refused.status.success());
    assert_eq!(fixture.config()["mcp"]["servers"]["atomicmemory"], prior);

    fixture.run_success(&["--yes", "--host", "opencode", "--force"]);
    assert_eq!(
        fixture.config()["mcp"]["servers"]["atomicmemory"]["type"],
        "local"
    );

    fixture.run_success(&["uninstall", "--host", "opencode"]);
    assert_eq!(fixture.config()["mcp"]["servers"]["atomicmemory"], prior);
}

#[test]
fn opencode_jsonc_comments_survive_install_and_uninstall() {
    let fixture = Fixture::new_jsonc(
        r#"{
  // Keep this explanation with the user's model.
  "model": "example/model",
  "mcp": {
    "servers": {
      "other": { "type": "remote", "url": "https://example.com/mcp" },
    },
  },
}
"#,
    );

    fixture.run_success(&["--yes", "--host", "opencode"]);
    assert!(
        fixture
            .raw_config()
            .contains("// Keep this explanation with the user's model.")
    );
    assert_eq!(
        fixture.config()["mcp"]["servers"]["atomicmemory"]["type"],
        "local"
    );
    assert!(!fixture.config_path.with_file_name("opencode.json").exists());

    fixture.run_success(&["uninstall", "--host", "opencode"]);
    assert!(
        fixture
            .raw_config()
            .contains("// Keep this explanation with the user's model.")
    );
    let removed = fixture.config();
    assert!(removed["mcp"]["servers"].get("atomicmemory").is_none());
    assert_eq!(removed["mcp"]["servers"]["other"]["type"], "remote");
}

#[test]
fn opencode_refuses_managed_entry_in_sibling_global_file() {
    let fixture = Fixture::new(&json!({ "model": "example/model" }));
    let sibling = fixture.config_path.with_file_name("config.json");
    fs::write(
        &sibling,
        serde_json::to_string_pretty(&json!({
            "mcp": { "servers": { "atomicmemory": {
                "type": "remote", "url": "https://sibling.example.com/mcp"
            } } }
        }))
        .unwrap(),
    )
    .unwrap();
    let before = fixture.raw_config();

    let output = fixture.run(&["--yes", "--host", "opencode", "--force"]);

    assert!(!output.status.success());
    assert_eq!(fixture.raw_config(), before);
    assert!(String::from_utf8_lossy(&output.stdout).contains("config.json"));
}

#[test]
fn opencode_operations_stay_on_recorded_install_file() {
    let fixture = Fixture::new(&json!({ "model": "example/model" }));
    fixture.run_success(&["--yes", "--host", "opencode"]);
    let jsonc = fixture.config_path.with_file_name("opencode.jsonc");
    fs::write(&jsonc, "{\n  // User-created later.\n}\n").unwrap();

    fixture.run_success(&["update", "--host", "opencode"]);
    fixture.run_success(&["uninstall", "--host", "opencode"]);

    assert!(
        fixture.config()["mcp"]["servers"]
            .get("atomicmemory")
            .is_none()
    );
    assert_eq!(
        fs::read_to_string(jsonc).unwrap(),
        "{\n  // User-created later.\n}\n"
    );
}

#[test]
fn opencode_operations_follow_recorded_file_rename() {
    let fixture = Fixture::new(&json!({ "model": "example/model" }));
    fixture.run_success(&["--yes", "--host", "opencode"]);
    let renamed = fixture.config_path.with_file_name("opencode.jsonc");
    fs::rename(&fixture.config_path, &renamed).unwrap();

    fixture.run_success(&["doctor", "--host", "opencode"]);
    fixture.run_success(&["update", "--host", "opencode"]);
    fixture.run_success(&["uninstall", "--host", "opencode"]);

    let raw = fs::read_to_string(renamed).unwrap();
    let config: Value = jsonc_parser::parse_to_serde_value(&raw, &Default::default()).unwrap();
    assert!(config["mcp"]["servers"].get("atomicmemory").is_none());
    assert_eq!(config["model"], "example/model");
}

#[test]
fn opencode_uninstall_follows_recorded_file_rename_without_update() {
    let fixture = Fixture::new(&json!({ "model": "example/model" }));
    fixture.run_success(&["--yes", "--host", "opencode"]);
    let renamed = fixture.config_path.with_file_name("opencode.jsonc");
    fs::rename(&fixture.config_path, &renamed).unwrap();

    fixture.run_success(&["uninstall", "--host", "opencode"]);

    let raw = fs::read_to_string(renamed).unwrap();
    let config: Value = jsonc_parser::parse_to_serde_value(&raw, &Default::default()).unwrap();
    assert!(config["mcp"]["servers"].get("atomicmemory").is_none());
    assert_eq!(config["model"], "example/model");
}

#[test]
fn opencode_duplicate_entries_fail_install_and_force_uninstall_removes_all() {
    let fixture = Fixture::new_jsonc(
        r#"{
  "mcp": { "servers": {
    "atomicmemory": { "type": "remote", "url": "https://first.example" },
    "atomicmemory": { "type": "remote", "url": "https://second.example" },
  } },
}
"#,
    );

    let install = fixture.run(&["--yes", "--host", "opencode", "--force"]);
    assert!(!install.status.success());
    fixture.run_success(&["uninstall", "--host", "opencode", "--force"]);
    assert_eq!(fixture.raw_config().matches("\"atomicmemory\"").count(), 0);
}

#[test]
fn opencode_force_uninstall_removes_entry_hidden_by_duplicate_parent() {
    let fixture = Fixture::new_jsonc(
        r#"{
  "mcp": { "servers": {
    "atomicmemory": { "type": "remote", "url": "https://hidden.example" },
  } },
  "mcp": { "servers": {} },
}
"#,
    );

    let refused = fixture.run(&["uninstall", "--host", "opencode"]);
    assert!(!refused.status.success());
    fixture.run_success(&["uninstall", "--host", "opencode", "--force"]);
    assert_eq!(fixture.raw_config().matches("\"atomicmemory\"").count(), 0);
}

#[test]
fn integrate_list_survives_unreadable_owned_opencode_config() {
    let fixture = Fixture::new(&json!({}));
    fixture.run_success(&["--yes", "--host", "opencode"]);
    fs::write(&fixture.config_path, "{ invalid jsonc").unwrap();

    let output = fixture.run_success(&["list"]);
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    let opencode = report["installs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["host"] == "opencode")
        .unwrap();
    assert_eq!(opencode["owned"], true);
    assert_eq!(opencode["fingerprint_match"], false);
}

#[test]
fn opencode2_binary_is_detected_without_config() {
    let home = tempfile::tempdir().unwrap();
    let config_home = home.path().join("config");
    let bin_dir = home.path().join("bin");
    fs::create_dir_all(&bin_dir).unwrap();
    let opencode2 = bin_dir.join("opencode2");
    fs::write(&opencode2, "#!/bin/sh\nexit 0\n").unwrap();
    fs::set_permissions(opencode2, fs::Permissions::from_mode(0o755)).unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_am"))
        .env("HOME", home.path())
        .env("XDG_CONFIG_HOME", &config_home)
        .env("XDG_DATA_HOME", home.path().join("data"))
        .env("PATH", &bin_dir)
        .args([
            "--no-telemetry",
            "-o",
            "json",
            "integrate",
            "detect",
            "--host",
            "opencode",
        ])
        .output()
        .unwrap();

    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["hosts"][0]["detected"], true);
    assert!(
        report["hosts"][0]["signals"]
            .as_array()
            .unwrap()
            .iter()
            .any(|signal| signal
                .as_str()
                .is_some_and(|value| value.contains("opencode2")))
    );
}
