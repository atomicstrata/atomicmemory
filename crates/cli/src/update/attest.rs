//! Publisher attestation policy shared with `install.sh`.
//!
//! `AM_VERIFY_ATTESTATION=1` must not fall through to checksum-only. `auto`
//! verifies when `gh` is authenticated and otherwise continues with the same
//! checksum-only warning as the installer. `0` skips. Any other value fails closed.

use std::ffi::OsStr;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use anyhow::{Context, Result, bail};

use super::channel::PUBLIC_INSTALL_COMMAND;

const ATTESTATION_TIMEOUT: Duration = Duration::from_secs(30);
const ATTESTATION_REPO: &str = "atomicstrata/atomicmemory";
const ATTESTATION_WORKFLOW: &str = "atomicstrata/atomicmemory/.github/workflows/release-cli.yml";

/// How `am update` treats GitHub artifact attestations.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttestationMode {
    /// Checksum verification only.
    Off,
    /// Verify when `gh` is installed and authenticated.
    Auto,
    /// Fail closed unless attestation verification succeeds.
    Require,
}

/// Parse `AM_VERIFY_ATTESTATION` the same way as `install.sh`.
pub fn parse_attestation_mode(raw: Option<&str>) -> Result<AttestationMode> {
    match raw.map(str::trim) {
        None | Some("") | Some("auto" | "AUTO") => Ok(AttestationMode::Auto),
        Some("0" | "false" | "FALSE" | "no" | "NO" | "off" | "OFF") => Ok(AttestationMode::Off),
        Some("1" | "true" | "TRUE" | "yes" | "YES" | "on" | "ON") => Ok(AttestationMode::Require),
        Some(other) => bail!("invalid AM_VERIFY_ATTESTATION: {other} (expected auto, 1, or 0)"),
    }
}

/// GitHub CLI executable `am update` runs in production.
pub const GH_PROGRAM: &str = "gh";

const GH_MISSING_WARNING: &str = "warning: GitHub CLI is unavailable; continuing with checksum verification only (set AM_VERIFY_ATTESTATION=1 to require provenance)";
const GH_LOGGED_OUT_WARNING: &str = "warning: GitHub CLI is not authenticated; continuing with checksum verification only (run gh auth login or set AM_VERIFY_ATTESTATION=1 to require provenance)";

/// What attestation enforcement did for one archive.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttestationOutcome {
    /// `gh attestation verify` succeeded.
    Verified,
    /// `AM_VERIFY_ATTESTATION=0`: checksum-only by request.
    Disabled,
    /// `auto` could not verify; the caller must surface this warning.
    ChecksumOnly(&'static str),
}

/// Verify `tarball` before it is extracted or executed, when `mode` requires it.
///
/// `gh` is the GitHub CLI executable ([`GH_PROGRAM`] outside tests).
pub async fn enforce_attestation(
    mode: AttestationMode,
    gh: &OsStr,
    tarball: &Path,
    version: &str,
) -> Result<AttestationOutcome> {
    if mode == AttestationMode::Off {
        return Ok(AttestationOutcome::Disabled);
    }
    match (mode, gh_status(gh)) {
        (_, GhStatus::Ready) => {
            verify_with_gh(gh, tarball, version).await?;
            Ok(AttestationOutcome::Verified)
        }
        (AttestationMode::Require, _) => bail!(
            "attestation verification requires an authenticated GitHub CLI. Reinstall with: {PUBLIC_INSTALL_COMMAND}"
        ),
        (_, GhStatus::Missing) => Ok(AttestationOutcome::ChecksumOnly(GH_MISSING_WARNING)),
        (_, GhStatus::LoggedOut) => Ok(AttestationOutcome::ChecksumOnly(GH_LOGGED_OUT_WARNING)),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GhStatus {
    Missing,
    LoggedOut,
    Ready,
}

fn gh_status(gh: &OsStr) -> GhStatus {
    let status = std::process::Command::new(gh)
        .args(["auth", "token"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .env("GH_PROMPT_DISABLED", "1")
        .status();
    match status {
        Err(_) => GhStatus::Missing,
        Ok(status) if status.success() => GhStatus::Ready,
        Ok(_) => GhStatus::LoggedOut,
    }
}

async fn verify_with_gh(gh: &OsStr, tarball: &Path, version: &str) -> Result<()> {
    let source_ref = format!("refs/tags/cli-v{version}");
    let status = tokio::time::timeout(ATTESTATION_TIMEOUT, gh_verify(gh, tarball, &source_ref))
        .await
        .context("attestation verification timed out")?
        .context("start gh attestation verify")?;
    if status.success() {
        return Ok(());
    }
    bail!(
        "attestation verification failed for {}. Reinstall with: {PUBLIC_INSTALL_COMMAND}",
        tarball.display()
    )
}

async fn gh_verify(
    gh: &OsStr,
    tarball: &Path,
    source_ref: &str,
) -> std::io::Result<std::process::ExitStatus> {
    tokio::process::Command::new(gh)
        .args(["attestation", "verify"])
        .arg(tarball)
        .args(["--repo", ATTESTATION_REPO])
        .args(["--signer-workflow", ATTESTATION_WORKFLOW])
        .args(["--source-ref", source_ref])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .env("GH_PROMPT_DISABLED", "1")
        .status()
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_installer_attestation_values() {
        assert_eq!(parse_attestation_mode(None).unwrap(), AttestationMode::Auto);
        assert_eq!(
            parse_attestation_mode(Some("auto")).unwrap(),
            AttestationMode::Auto
        );
        assert_eq!(
            parse_attestation_mode(Some("1")).unwrap(),
            AttestationMode::Require
        );
        assert_eq!(
            parse_attestation_mode(Some("0")).unwrap(),
            AttestationMode::Off
        );
        assert!(parse_attestation_mode(Some("maybe")).is_err());
    }

    #[cfg(unix)]
    mod gh_policy {
        use std::ffi::OsStr;
        use std::path::Path;

        use super::super::*;
        use crate::update::fixture_server::{MISSING_GH, gh_stub};

        async fn enforce(mode: AttestationMode, gh: &Path) -> Result<AttestationOutcome> {
            enforce_attestation(mode, gh.as_os_str(), Path::new("am.tar.gz"), "0.2.0").await
        }

        #[tokio::test]
        async fn auto_without_gh_falls_back_with_a_warning() {
            let outcome = enforce(AttestationMode::Auto, Path::new(MISSING_GH))
                .await
                .expect("auto continues");
            let AttestationOutcome::ChecksumOnly(warning) = outcome else {
                panic!("expected a checksum-only warning, got {outcome:?}");
            };
            assert!(warning.starts_with("warning:"), "{warning}");
            assert!(warning.contains("unavailable"), "{warning}");
            assert!(warning.contains("AM_VERIFY_ATTESTATION=1"), "{warning}");
        }

        #[tokio::test]
        async fn auto_with_logged_out_gh_falls_back_with_a_warning() {
            let tmp = tempfile::tempdir().expect("tempdir");
            let gh = gh_stub(tmp.path(), 1, 0);
            let outcome = enforce(AttestationMode::Auto, &gh).await.expect("auto");
            assert_eq!(
                outcome,
                AttestationOutcome::ChecksumOnly(GH_LOGGED_OUT_WARNING)
            );
            assert!(GH_LOGGED_OUT_WARNING.contains("not authenticated"));
        }

        #[tokio::test]
        async fn auto_with_ready_gh_verifies_the_release_tag() {
            let tmp = tempfile::tempdir().expect("tempdir");
            let gh = gh_stub(tmp.path(), 0, 0);
            let outcome = enforce(AttestationMode::Auto, &gh).await.expect("auto");
            assert_eq!(outcome, AttestationOutcome::Verified);
            let calls = std::fs::read_to_string(tmp.path().join("calls.log")).expect("log");
            assert!(
                calls.contains("--source-ref refs/tags/cli-v0.2.0"),
                "{calls}"
            );
        }

        #[tokio::test]
        async fn off_never_runs_gh() {
            let tmp = tempfile::tempdir().expect("tempdir");
            let gh = gh_stub(tmp.path(), 0, 1);
            let outcome = enforce(AttestationMode::Off, &gh).await.expect("off");
            assert_eq!(outcome, AttestationOutcome::Disabled);
            assert!(!tmp.path().join("calls.log").exists());
        }

        #[tokio::test]
        async fn require_without_gh_fails_closed() {
            let err = enforce_attestation(
                AttestationMode::Require,
                OsStr::new(MISSING_GH),
                Path::new("am.tar.gz"),
                "0.2.0",
            )
            .await
            .expect_err("require");
            assert!(
                err.to_string()
                    .contains("requires an authenticated GitHub CLI"),
                "{err}"
            );
        }
    }
}
