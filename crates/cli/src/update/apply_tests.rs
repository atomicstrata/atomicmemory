//! Unix replace tests. Windows CI runs `cargo test` but has no published target.

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use super::fixture_server::{FixtureServer, gh_stub};
use super::install::{acquire_install_lock, commit_install};
use super::release_fixture::{
    install_request, installed_dest, pack, pack_probe, pack_with_envs, snapshot, stage_leftovers,
    unreachable_install_request, write_body, write_script, write_version_env,
};
use super::{AttestationMode, run_update};

#[tokio::test]
async fn replaces_dest_when_checksum_and_staged_version_match() {
    let tmp = tempfile::tempdir().expect("tempdir");
    pack(tmp.path(), "0.2.0", "0.2.0", true);
    let dest = installed_dest(tmp.path());
    let before = snapshot(&dest);
    let server = FixtureServer::spawn(tmp.path()).await;
    let report = run_update(install_request(&server.base, &dest))
        .await
        .expect("update");
    assert_eq!(report.status, "updated");
    assert!(report.replaced);
    assert_ne!(snapshot(&dest), before);
}

#[tokio::test]
async fn checksum_mismatch_leaves_the_installed_binary_untouched() {
    let tmp = tempfile::tempdir().expect("tempdir");
    pack(tmp.path(), "0.2.0", "0.2.0", false);
    let dest = installed_dest(tmp.path());
    let before = snapshot(&dest);
    let server = FixtureServer::spawn(tmp.path()).await;
    let err = run_update(install_request(&server.base, &dest))
        .await
        .expect_err("bad checksum");
    assert!(err.to_string().contains("checksum"));
    assert_eq!(snapshot(&dest), before);
}

#[tokio::test]
async fn staged_version_mismatch_leaves_the_installed_binary_untouched() {
    let tmp = tempfile::tempdir().expect("tempdir");
    pack(tmp.path(), "0.2.0", "9.9.9", true);
    let dest = installed_dest(tmp.path());
    let before = snapshot(&dest);
    let server = FixtureServer::spawn(tmp.path()).await;
    let err = run_update(install_request(&server.base, &dest))
        .await
        .expect_err("bad staged version");
    assert!(err.to_string().contains("identity"));
    assert_eq!(snapshot(&dest), before);
}

#[tokio::test]
async fn refuses_when_install_dir_is_not_writable() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let dest_dir = tmp.path().join("bin");
    fs::create_dir_all(&dest_dir).expect("bin");
    let dest = dest_dir.join("am");
    fs::write(&dest, b"old").expect("dest");
    let _restore = ModeGuard::readonly(&dest_dir);
    if ModeGuard::is_writable(&dest_dir) {
        eprintln!(
            "skipping refuses_when_install_dir_is_not_writable: a 0555 directory is still \
             writable (running as root?); refuses_when_install_parent_is_not_a_directory \
             covers the refusal path"
        );
        return;
    }
    let err = run_update(unreachable_install_request(&dest))
        .await
        .expect_err("readonly dir");
    assert!(err.to_string().contains("not writable"));
    assert_eq!(fs::read(&dest).expect("read"), b"old");
}

#[tokio::test]
async fn refuses_when_install_parent_is_not_a_directory() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let not_dir = tmp.path().join("bin");
    fs::write(&not_dir, b"file").expect("file");
    let dest = not_dir.join("am");
    let err = run_update(unreachable_install_request(&dest))
        .await
        .expect_err("file parent");
    assert!(err.to_string().contains("not writable"), "{err}");
    assert_eq!(fs::read(&not_dir).expect("read"), b"file");
}

#[tokio::test]
async fn nonproduction_discovery_env_preserves_the_installed_binary() {
    for env in ["dev", "internal", "canary", "staging"] {
        refuse_discovery_env(env).await;
    }
}

async fn refuse_discovery_env(env: &str) {
    let tmp = tempfile::tempdir().expect("tempdir");
    write_version_env(tmp.path(), "0.2.0", env);
    let dest = installed_dest(tmp.path());
    let before = snapshot(&dest);
    let server = FixtureServer::spawn(tmp.path()).await;
    let err = run_update(install_request(&server.base, &dest))
        .await
        .expect_err(env);
    assert!(err.to_string().contains(env), "{env}: {err}");
    assert_eq!(snapshot(&dest), before);
    assert!(server.hits().iter().all(|hit| !hit.contains(".tar.gz")));
}

#[tokio::test]
async fn nonproduction_staged_binary_preserves_the_installed_binary() {
    for env in ["dev", "internal", "canary", "staging"] {
        refuse_staged_env(env).await;
    }
}

async fn refuse_staged_env(env: &str) {
    let tmp = tempfile::tempdir().expect("tempdir");
    pack_with_envs(tmp.path(), "0.2.0", env, "production");
    let dest = installed_dest(tmp.path());
    let before = snapshot(&dest);
    let server = FixtureServer::spawn(tmp.path()).await;
    let err = run_update(install_request(&server.base, &dest))
        .await
        .expect_err(env);
    assert!(err.to_string().contains(env), "{env}: {err}");
    assert_eq!(snapshot(&dest), before);
}

#[tokio::test]
async fn required_attestation_does_not_install_an_unverified_archive() {
    let tmp = tempfile::tempdir().expect("tempdir");
    pack(tmp.path(), "0.2.0", "0.2.0", true);
    let dest = installed_dest(tmp.path());
    let before = snapshot(&dest);
    let gh_dir = tmp.path().join("gh");
    fs::create_dir_all(&gh_dir).expect("gh dir");
    let gh = gh_stub(&gh_dir, 0, 1);
    let server = FixtureServer::spawn(tmp.path()).await;
    let mut request = install_request(&server.base, &dest);
    request.attestation = AttestationMode::Require;
    request.gh = gh.as_os_str();
    let err = run_update(request).await.expect_err("attestation");
    assert!(
        err.to_string().contains("attestation verification failed"),
        "{err}"
    );
    let calls = fs::read_to_string(gh_dir.join("calls.log")).expect("gh calls");
    assert!(
        calls.contains("attestation verify") && calls.contains("--repo atomicstrata/atomicmemory"),
        "{calls}"
    );
    assert_eq!(snapshot(&dest), before);
}

/// Auto falls back only when `gh` is missing or logged out. A verification
/// that actually runs and fails must stay fatal, never checksum-only.
#[tokio::test]
async fn auto_attestation_failure_with_ready_gh_does_not_fall_back() {
    let tmp = tempfile::tempdir().expect("tempdir");
    pack(tmp.path(), "0.2.0", "0.2.0", true);
    let dest = installed_dest(tmp.path());
    let before = snapshot(&dest);
    let gh_dir = tmp.path().join("gh");
    fs::create_dir_all(&gh_dir).expect("gh dir");
    let gh = gh_stub(&gh_dir, 0, 1);
    let server = FixtureServer::spawn(tmp.path()).await;
    let mut request = install_request(&server.base, &dest);
    request.attestation = AttestationMode::Auto;
    request.gh = gh.as_os_str();
    let err = run_update(request)
        .await
        .expect_err("a failed verification must not fall back to checksum-only");
    assert!(
        err.to_string().contains("attestation verification failed"),
        "{err}"
    );
    let calls = fs::read_to_string(gh_dir.join("calls.log")).expect("gh calls");
    assert!(calls.contains("attestation verify"), "{calls}");
    assert_eq!(snapshot(&dest), before);
    assert_eq!(stage_leftovers(&dest), Vec::<String>::new());
}

#[tokio::test]
async fn required_attestation_without_gh_fails_before_extraction() {
    let tmp = tempfile::tempdir().expect("tempdir");
    pack(tmp.path(), "0.2.0", "0.2.0", true);
    let dest = installed_dest(tmp.path());
    let before = snapshot(&dest);
    let server = FixtureServer::spawn(tmp.path()).await;
    let mut request = install_request(&server.base, &dest);
    request.attestation = AttestationMode::Require;
    let err = run_update(request).await.expect_err("attestation");
    assert!(
        err.to_string()
            .contains("requires an authenticated GitHub CLI"),
        "{err}"
    );
    assert_eq!(snapshot(&dest), before);
    assert_eq!(stage_leftovers(&dest), Vec::<String>::new());
}

#[tokio::test]
async fn auto_attestation_without_gh_installs_checksum_only() {
    let tmp = tempfile::tempdir().expect("tempdir");
    pack(tmp.path(), "0.2.0", "0.2.0", true);
    let dest = installed_dest(tmp.path());
    let before = snapshot(&dest);
    let server = FixtureServer::spawn(tmp.path()).await;
    let mut request = install_request(&server.base, &dest);
    request.attestation = AttestationMode::Auto;
    let report = run_update(request).await.expect("auto falls back");
    assert!(report.replaced);
    assert_ne!(snapshot(&dest), before);
}

#[tokio::test]
async fn staged_binary_runs_from_the_install_dir_and_is_cleaned_up() {
    let tmp = tempfile::tempdir().expect("tempdir");
    pack_probe(tmp.path(), "0.2.0");
    let dest = installed_dest(tmp.path());
    let server = FixtureServer::spawn(tmp.path()).await;
    let report = run_update(install_request(&server.base, &dest))
        .await
        .expect("update");
    assert!(report.replaced);
    let ran_from = fs::read_to_string(tmp.path().join("probe.log")).expect("probe log");
    let staged_dir = Path::new(ran_from.trim()).parent().expect("staged dir");
    assert_eq!(staged_dir.parent(), dest.parent(), "{ran_from}");
    assert_eq!(stage_leftovers(&dest), Vec::<String>::new());
}

#[tokio::test]
async fn failed_staging_leaves_no_sibling_files() {
    let tmp = tempfile::tempdir().expect("tempdir");
    pack(tmp.path(), "0.2.0", "9.9.9", true);
    let dest = installed_dest(tmp.path());
    let server = FixtureServer::spawn(tmp.path()).await;
    run_update(install_request(&server.base, &dest))
        .await
        .expect_err("bad staged version");
    assert_eq!(stage_leftovers(&dest), Vec::<String>::new());
}

#[tokio::test]
async fn stale_process_does_not_replace_a_newer_installed_binary() {
    let tmp = tempfile::tempdir().expect("tempdir");
    pack(tmp.path(), "0.2.0", "0.2.0", true);
    let dest = tmp.path().join("bin").join("am");
    fs::create_dir_all(dest.parent().expect("parent")).expect("bin");
    write_script(&dest, "0.3.0");
    let before = snapshot(&dest);
    let server = FixtureServer::spawn(tmp.path()).await;
    let report = run_update(install_request(&server.base, &dest))
        .await
        .expect("no downgrade");
    assert!(!report.replaced);
    assert_eq!(report.status, "current");
    assert_eq!(snapshot(&dest), before);
}

#[test]
fn slower_commit_cannot_overwrite_a_newer_release() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let dest = tmp.path().join("am");
    let staged = tmp.path().join("staged-am");
    write_script(&dest, "0.1.0");
    write_script(&staged, "0.2.0");
    let lock = acquire_install_lock(&dest).expect("lock");
    let dest_bg = dest.clone();
    let staged_bg = staged.clone();
    let handle = std::thread::spawn(move || {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(commit_install(&staged_bg, &dest_bg, "0.2.0"))
    });
    write_script(&dest, "0.3.0");
    let newer = snapshot(&dest);
    drop(lock);
    let replaced = handle.join().expect("join").expect("commit");
    assert!(!replaced);
    assert_eq!(snapshot(&dest), newer);
}

#[tokio::test]
async fn unreadable_installed_identity_is_not_replaced() {
    for (body, needle) in dest_identity_cases() {
        refuse_dest_identity(body, needle).await;
    }
}

async fn refuse_dest_identity(body: &str, needle: &str) {
    let tmp = tempfile::tempdir().expect("tempdir");
    pack(tmp.path(), "0.2.0", "0.2.0", true);
    let dest = installed_dest(tmp.path());
    write_body(&dest, body);
    let before = snapshot(&dest);
    let server = FixtureServer::spawn(tmp.path()).await;
    let err = run_update(install_request(&server.base, &dest))
        .await
        .expect_err(needle);
    assert!(err.to_string().contains(needle), "{needle}: {err}");
    assert_eq!(snapshot(&dest), before);
}

fn dest_identity_cases() -> [(&'static str, &'static str); 4] {
    [
        ("#!/bin/sh\nexit 1\n", "exited"),
        ("#!/bin/sh\nprintf '%s\\n' 'not-json'\n", "parse"),
        (
            "#!/bin/sh\nprintf '%s\\n' '{\"surface\":\"sdk\",\"version\":\"0.1.0\",\"gitSha\":null,\"env\":\"production\"}'\n",
            "surface",
        ),
        (
            "#!/bin/sh\nprintf '%s\\n' '{\"surface\":\"cli\",\"version\":\"0.1.0\",\"gitSha\":null,\"env\":\"internal\"}'\n",
            "internal",
        ),
    ]
}

struct ModeGuard {
    dir: PathBuf,
}

impl ModeGuard {
    fn readonly(dir: &Path) -> Self {
        let mut perms = fs::metadata(dir).expect("stat").permissions();
        perms.set_mode(0o555);
        fs::set_permissions(dir, perms).expect("chmod");
        Self {
            dir: dir.to_path_buf(),
        }
    }

    fn is_writable(dir: &Path) -> bool {
        let probe = dir.join(".am-write-probe");
        let ok = fs::File::create(&probe).is_ok();
        let _ = fs::remove_file(&probe);
        ok
    }
}

impl Drop for ModeGuard {
    fn drop(&mut self) {
        let mut perms = fs::metadata(&self.dir).expect("stat").permissions();
        perms.set_mode(0o755);
        let _ = fs::set_permissions(&self.dir, perms);
    }
}
