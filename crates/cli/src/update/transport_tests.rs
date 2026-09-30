//! Unix `am update` transport tests: redirect policy and body size limits.

use std::fs;

use super::fixture_server::FixtureServer;
use super::release_fixture::{install_request, installed_dest, pack, snapshot, write_version};
use super::run_update;

#[tokio::test]
async fn cross_origin_redirect_is_refused() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let other_root = tmp.path().join("other");
    fs::create_dir_all(&other_root).expect("other");
    write_version(&other_root, "0.2.0");
    let other = FixtureServer::spawn(&other_root).await;
    fs::write(
        tmp.path().join("version.json.redirect"),
        format!("{}/version.json", other.base),
    )
    .expect("redirect");
    let dest = installed_dest(tmp.path());
    let server = FixtureServer::spawn(tmp.path()).await;
    let err = run_update(install_request(&server.base, &dest))
        .await
        .expect_err("cross-origin redirect");
    assert!(
        format!("{err:#}").contains("refusing update redirect"),
        "{err:#}"
    );
    assert!(other.hits().is_empty(), "{:?}", other.hits());
}

#[tokio::test]
async fn same_origin_redirect_is_followed() {
    let tmp = tempfile::tempdir().expect("tempdir");
    pack(tmp.path(), "0.2.0", "0.2.0", true);
    fs::rename(
        tmp.path().join("version.json"),
        tmp.path().join("moved.json"),
    )
    .expect("move");
    fs::write(tmp.path().join("version.json.redirect"), "/moved.json").expect("redirect");
    let dest = installed_dest(tmp.path());
    let server = FixtureServer::spawn(tmp.path()).await;
    let report = run_update(install_request(&server.base, &dest))
        .await
        .expect("same-origin redirect");
    assert!(report.replaced);
}

#[tokio::test]
async fn oversized_version_document_is_refused() {
    let tmp = tempfile::tempdir().expect("tempdir");
    pack(tmp.path(), "0.2.0", "0.2.0", true);
    let mut body = fs::read(tmp.path().join("version.json")).expect("version");
    body.resize(70 * 1024, b' ');
    fs::write(tmp.path().join("version.json"), body).expect("pad");
    let dest = installed_dest(tmp.path());
    let before = snapshot(&dest);
    let server = FixtureServer::spawn(tmp.path()).await;
    let err = run_update(install_request(&server.base, &dest))
        .await
        .expect_err("oversized version.json");
    assert!(format!("{err:#}").contains("update limit"), "{err:#}");
    assert_eq!(snapshot(&dest), before);
}

#[tokio::test]
async fn oversized_checksum_manifest_is_refused() {
    let tmp = tempfile::tempdir().expect("tempdir");
    pack(tmp.path(), "0.2.0", "0.2.0", true);
    let sums = tmp.path().join("cli").join("v0.2.0").join("SHA256SUMS");
    let mut body = fs::read(&sums).expect("sums");
    body.resize(70 * 1024, b'\n');
    fs::write(&sums, body).expect("pad");
    let dest = installed_dest(tmp.path());
    let before = snapshot(&dest);
    let server = FixtureServer::spawn(tmp.path()).await;
    let err = run_update(install_request(&server.base, &dest))
        .await
        .expect_err("oversized SHA256SUMS");
    assert!(format!("{err:#}").contains("update limit"), "{err:#}");
    assert!(server.hits().iter().all(|hit| !hit.contains(".tar.gz")));
    assert_eq!(snapshot(&dest), before);
}
