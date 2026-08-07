//! Detect installed agent hosts from PATH and config presence (no execution).

use std::path::Path;

use serde::Serialize;

use crate::integrate::host::{Host, InstallScope, all_hosts};
use crate::integrate::path_util::{binary_on_path, home_dir};

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

pub fn detect_hosts(cwd: &Path) -> DetectReport {
    DetectReport {
        cwd: cwd.display().to_string(),
        hosts: all_hosts()
            .into_iter()
            .filter_map(|host| detect_one(host, cwd).ok())
            .collect(),
    }
}

fn detect_one(host: Host, _cwd: &Path) -> anyhow::Result<HostDetectEntry> {
    let mut signals = Vec::new();
    if binary_on_path(host_binary(host)) {
        signals.push(format!("binary `{}` on PATH", host_binary(host)));
    }
    if host
        .config_path(InstallScope::Global, Path::new("."))?
        .exists()
    {
        signals.push("global config exists".into());
    }
    if host_support_dir_exists(host)? {
        signals.push("support directory exists".into());
    }
    Ok(HostDetectEntry {
        host,
        detected: !signals.is_empty(),
        signals,
    })
}

fn host_binary(host: Host) -> &'static str {
    match host {
        Host::Cursor => "cursor-agent",
        Host::ClaudeCode => "claude",
        Host::Codex => "codex",
    }
}

fn host_support_dir_exists(host: Host) -> anyhow::Result<bool> {
    let home = home_dir()?;
    Ok(match host {
        Host::Cursor => home.join(".cursor").is_dir(),
        Host::ClaudeCode => home.join(".claude").is_dir() || home.join(".claude.json").exists(),
        Host::Codex => home.join(".codex").is_dir(),
    })
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
        let report = detect_hosts(&cwd);
        assert_eq!(report.hosts.len(), 3);
    }
}
