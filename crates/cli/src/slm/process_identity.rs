//! Verify a recorded managed PID still refers to the same process before signalling it.

use std::process::Command;

/// Stable identity for a process at spawn time (survives PID reuse checks).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessIdentity {
    pub pid: u32,
    /// Platform-specific start stamp (`lstart` on Unix).
    pub start_stamp: String,
}

/// Capture the current start identity for `pid`, if the process exists.
pub fn capture_process_identity(pid: u32) -> Option<ProcessIdentity> {
    read_start_stamp(pid).map(|start_stamp| ProcessIdentity { pid, start_stamp })
}

/// True when `pid` is alive and its start stamp still matches `expected`.
pub fn process_identity_matches(pid: u32, expected: &ProcessIdentity) -> bool {
    if pid != expected.pid {
        return false;
    }
    match read_start_stamp(pid) {
        Some(stamp) => stamp == expected.start_stamp,
        None => false,
    }
}

/// PID listening on `127.0.0.1:port`, if any.
pub fn listener_pid_on_port(port: u16) -> Option<u32> {
    listener_pid_on_port_impl(port)
}

pub fn port_owned_by_pid(port: u16, pid: u32) -> bool {
    listener_pid_on_port(port).is_some_and(|listener| listener == pid)
}

#[cfg(unix)]
fn read_start_stamp(pid: u32) -> Option<String> {
    let output = Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "lstart="])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stamp = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if stamp.is_empty() { None } else { Some(stamp) }
}

#[cfg(not(unix))]
fn read_start_stamp(_pid: u32) -> Option<String> {
    None
}

#[cfg(unix)]
fn listener_pid_on_port_impl(port: u16) -> Option<u32> {
    let output = Command::new("lsof")
        .args(["-nP", &format!("-iTCP:{port}"), "-sTCP:LISTEN", "-t"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()
        .and_then(|line| line.trim().parse().ok())
}

#[cfg(not(unix))]
fn listener_pid_on_port_impl(_port: u16) -> Option<u32> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};
    use std::time::Duration;

    #[test]
    #[cfg(unix)]
    fn capture_and_match_current_process() {
        let pid = std::process::id();
        let identity = capture_process_identity(pid).expect("current process identity");
        assert!(process_identity_matches(pid, &identity));
    }

    #[test]
    #[cfg(unix)]
    fn stale_pid_does_not_match_after_process_exits() {
        let mut child = Command::new("sleep")
            .arg("30")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn sleep");
        let pid = child.id();
        let identity = capture_process_identity(pid).expect("sleep identity");
        child.kill().ok();
        let _ = child.wait();
        std::thread::sleep(Duration::from_millis(50));
        assert!(
            !process_identity_matches(pid, &identity),
            "exited pid must not still match its old start stamp"
        );
    }
}
