//! Portable `am update` decisions that do not replace a binary.

use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};

use super::fixture_server::{FixtureServer, MISSING_GH};
use super::{AttestationMode, UpdateRequest, run_update};

fn write_version(dir: &Path, version: &str) {
    let body = format!(
        r#"{{"surface":"cli","version":"{version}","gitSha":"abc123","env":"production"}}"#
    );
    fs::write(dir.join("version.json"), body).expect("version.json");
}

fn dest_file(dir: &Path) -> PathBuf {
    let dest = dir.join("installed-am");
    fs::write(&dest, b"old").expect("dest");
    dest
}

#[cfg(all(
    any(target_os = "macos", target_os = "linux"),
    any(target_arch = "x86_64", target_arch = "aarch64")
))]
#[tokio::test]
async fn check_reports_current_without_downloading_a_tarball() {
    let tmp = tempfile::tempdir().expect("tempdir");
    write_version(tmp.path(), "0.2.0");
    let dest = dest_file(tmp.path());
    let server = FixtureServer::spawn(tmp.path()).await;
    let report = run_update(check_request(&server.base, "0.2.0", &dest))
        .await
        .expect("check");
    assert_eq!(report.status, "current");
    assert!(!report.update_available);
    assert!(!report.replaced);
    assert_eq!(fs::read(&dest).expect("read"), b"old");
    assert!(server.hits().iter().all(|hit| !hit.contains(".tar.gz")));
}

#[cfg(all(
    any(target_os = "macos", target_os = "linux"),
    any(target_arch = "x86_64", target_arch = "aarch64")
))]
#[tokio::test]
async fn check_reports_available_update_without_replacing() {
    let tmp = tempfile::tempdir().expect("tempdir");
    write_version(tmp.path(), "0.2.0");
    let dest = dest_file(tmp.path());
    let server = FixtureServer::spawn(tmp.path()).await;
    let report = run_update(check_request(&server.base, "0.1.0", &dest))
        .await
        .expect("check");
    assert_eq!(report.status, "available");
    assert!(report.update_available);
    assert!(!report.replaced);
    assert_eq!(fs::read(&dest).expect("read"), b"old");
    assert!(server.hits().iter().all(|hit| !hit.contains(".tar.gz")));
}

#[cfg(all(
    any(target_os = "macos", target_os = "linux"),
    any(target_arch = "x86_64", target_arch = "aarch64")
))]
#[tokio::test]
async fn newer_local_version_does_not_downgrade() {
    let tmp = tempfile::tempdir().expect("tempdir");
    write_version(tmp.path(), "0.2.0");
    let dest = dest_file(tmp.path());
    let server = FixtureServer::spawn(tmp.path()).await;
    let report = run_update(check_request(&server.base, "0.3.0", &dest))
        .await
        .expect("check");
    assert_eq!(report.status, "current");
    assert!(!report.update_available);
    assert_eq!(fs::read(&dest).expect("read"), b"old");
}

#[tokio::test]
async fn dev_channel_refuses_before_any_download() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let dest = dest_file(tmp.path());
    let err = run_update(UpdateRequest {
        base_url: "http://127.0.0.1:1",
        build_env: "dev",
        current_version: "0.1.0",
        dest: &dest,
        check_only: false,
        quiet: true,
        attestation: AttestationMode::Off,
        gh: OsStr::new(MISSING_GH),
    })
    .await
    .expect_err("dev build must refuse");
    assert!(
        err.to_string()
            .contains("cargo install --path crates/cli --force")
    );
    assert_eq!(fs::read(&dest).expect("read"), b"old");
}

#[tokio::test]
async fn cleartext_public_origin_is_rejected() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let dest = dest_file(tmp.path());
    let err = run_update(UpdateRequest {
        base_url: "http://example.com",
        build_env: "production",
        current_version: "0.1.0",
        dest: &dest,
        check_only: true,
        quiet: true,
        attestation: AttestationMode::Off,
        gh: OsStr::new(MISSING_GH),
    })
    .await
    .expect_err("cleartext origin");
    assert!(err.to_string().contains("https"));
    assert_eq!(fs::read(&dest).expect("read"), b"old");
}

fn check_request<'a>(base: &'a str, current: &'a str, dest: &'a Path) -> UpdateRequest<'a> {
    UpdateRequest {
        base_url: base,
        build_env: "production",
        current_version: current,
        dest,
        check_only: true,
        quiet: true,
        attestation: AttestationMode::Off,
        gh: OsStr::new(MISSING_GH),
    }
}

#[cfg(not(all(
    any(target_os = "macos", target_os = "linux"),
    any(target_arch = "x86_64", target_arch = "aarch64")
)))]
#[tokio::test]
async fn check_reports_an_unpublished_platform_before_fetching() {
    let tmp = tempfile::tempdir().expect("tempdir");
    write_version(tmp.path(), "0.2.0");
    let dest = dest_file(tmp.path());
    let server = FixtureServer::spawn(tmp.path()).await;
    let err = run_update(check_request(&server.base, "0.1.0", &dest))
        .await
        .expect_err("unpublished platform");
    assert!(err.to_string().contains("unsupported platform"), "{err}");
    assert!(server.hits().is_empty());
}
