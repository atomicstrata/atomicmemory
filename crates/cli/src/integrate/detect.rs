//! Detect installed agent hosts from PATH and config presence (no execution).

use std::path::Path;

use serde::Serialize;

use crate::integrate::host::{Host, HostConfigPaths, all_hosts};
use crate::integrate::path_util::binary_on_path;

#[derive(Debug, Clone, Serialize)]
pub struct HostDetectEntry {
    pub host: Host,
    pub detected: bool,
    pub signals: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DetectReport {
    pub cwd: String,
    pub hosts: Vec<HostDetectEntry>,
}

pub fn detect_hosts(cwd: &Path, config_paths: &HostConfigPaths) -> DetectReport {
    DetectReport {
        cwd: cwd.display().to_string(),
        hosts: all_hosts()
            .into_iter()
            .map(|host| detect_one(host, config_paths))
            .collect(),
    }
}

fn detect_one(host: Host, config_paths: &HostConfigPaths) -> HostDetectEntry {
    let mut signals = Vec::new();
    if let Some(binary) = host_binaries(host)
        .iter()
        .copied()
        .find(|binary| binary_on_path(binary))
    {
        signals.push(format!("binary `{binary}` on PATH"));
    }
    if config_paths.global_config_path(host).exists() {
        signals.push("global config exists".into());
    }
    if config_paths.support_path_exists(host) {
        signals.push("support directory exists".into());
    }
    HostDetectEntry {
        host,
        detected: !signals.is_empty(),
        signals,
    }
}

fn host_binaries(host: Host) -> &'static [&'static str] {
    match host {
        Host::Cursor => &["cursor-agent"],
        Host::ClaudeCode => &["claude"],
        Host::Codex => &["codex"],
        Host::OpenCode => &["opencode2", "opencode"],
    }
}

pub fn detected_hosts(report: &DetectReport) -> Vec<Host> {
    report
        .hosts
        .iter()
        .filter(|h| h.detected)
        .map(|h| h.host)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    #[test]
    fn detect_report_lists_all_hosts() {
        let cwd = env::current_dir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let paths = HostConfigPaths::new(home.path().into(), None);
        let report = detect_hosts(&cwd, &paths);
        assert_eq!(report.hosts.len(), 4);
    }
}
