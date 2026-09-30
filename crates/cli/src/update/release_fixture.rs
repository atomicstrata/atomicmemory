//! Release trees and installed-binary stand-ins for Unix `am update` tests.

use std::ffi::OsStr;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;

use super::checksum::sha256_hex;
use super::fixture_server::MISSING_GH;
use super::target::{artifact_name, current_target};
use super::{AttestationMode, UpdateRequest};

pub(super) fn unreachable_install_request(dest: &Path) -> UpdateRequest<'_> {
    UpdateRequest {
        base_url: "http://127.0.0.1:1",
        build_env: "production",
        current_version: "0.1.0",
        dest,
        check_only: false,
        quiet: true,
        attestation: AttestationMode::Off,
        gh: OsStr::new(MISSING_GH),
    }
}

pub(super) fn install_request<'a>(base: &'a str, dest: &'a Path) -> UpdateRequest<'a> {
    UpdateRequest {
        base_url: base,
        build_env: "production",
        current_version: "0.1.0",
        dest,
        check_only: false,
        quiet: true,
        attestation: AttestationMode::Off,
        gh: OsStr::new(MISSING_GH),
    }
}

/// Entries beside `dest` other than `dest` itself and the install lock.
pub(super) fn stage_leftovers(dest: &Path) -> Vec<String> {
    let name = dest.file_name().and_then(|n| n.to_str()).expect("name");
    let lock = format!(".{name}.update.lock");
    fs::read_dir(dest.parent().expect("parent"))
        .expect("read dir")
        .map(|entry| {
            entry
                .expect("entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .filter(|entry| entry != name && *entry != lock)
        .collect()
}

/// Release whose staged `am` records the path it was executed from.
pub(super) fn pack_probe(root: &Path, version: &str) {
    let target = current_target().expect("published unix target");
    let stage = root.join("stage");
    fs::create_dir_all(&stage).expect("stage");
    let body = format!(
        "#!/bin/sh\nprintf '%s\\n' \"$0\" >> '{}'\nprintf '%s\\n' '{{\"surface\":\"cli\",\"version\":\"{version}\",\"gitSha\":null,\"env\":\"production\"}}'\n",
        root.join("probe.log").display()
    );
    write_body(&stage.join("am"), &body);
    let name = artifact_name(version, target);
    let release = root.join("cli").join(format!("v{version}"));
    fs::create_dir_all(&release).expect("release dir");
    let tarball = release.join(&name);
    tar_am(&stage, &tarball);
    write_sums(&release, &tarball, &name, true);
    write_version(root, version);
}

pub(super) fn installed_dest(root: &Path) -> PathBuf {
    let dir = root.join("bin");
    fs::create_dir_all(&dir).expect("bin");
    let dest = dir.join("am");
    write_script(&dest, "0.1.0");
    dest
}

pub(super) fn snapshot(path: &Path) -> Vec<u8> {
    fs::read(path).expect("read")
}

pub(super) fn write_body(path: &Path, body: &str) {
    fs::write(path, body).expect("script");
    let mut perms = fs::metadata(path).expect("stat").permissions();
    perms.set_mode(0o755);
    fs::set_permissions(path, perms).expect("chmod");
}

pub(super) fn pack_with_envs(root: &Path, version: &str, script_env: &str, manifest_env: &str) {
    let target = current_target().expect("published unix target");
    let stage = root.join("stage");
    fs::create_dir_all(&stage).expect("stage");
    write_script_env(&stage.join("am"), version, script_env);
    let name = artifact_name(version, target);
    let release = root.join("cli").join(format!("v{version}"));
    fs::create_dir_all(&release).expect("release dir");
    let tarball = release.join(&name);
    tar_am(&stage, &tarball);
    write_sums(&release, &tarball, &name, true);
    write_version_env(root, version, manifest_env);
}

pub(super) fn pack(root: &Path, version: &str, script_version: &str, good_sum: bool) {
    let target = current_target().expect("published unix target");
    let stage = root.join("stage");
    fs::create_dir_all(&stage).expect("stage");
    write_script(&stage.join("am"), script_version);
    let name = artifact_name(version, target);
    let release = root.join("cli").join(format!("v{version}"));
    fs::create_dir_all(&release).expect("release dir");
    let tarball = release.join(&name);
    tar_am(&stage, &tarball);
    write_sums(&release, &tarball, &name, good_sum);
    write_version(root, version);
}

pub(super) fn write_script(path: &Path, version: &str) {
    write_script_env(path, version, "production");
}

pub(super) fn write_script_env(path: &Path, version: &str, env: &str) {
    let body = format!(
        "#!/bin/sh\nprintf '%s\\n' '{{\"surface\":\"cli\",\"version\":\"{version}\",\"gitSha\":null,\"env\":\"{env}\"}}'\n"
    );
    fs::write(path, body).expect("script");
    let mut perms = fs::metadata(path).expect("stat").permissions();
    perms.set_mode(0o755);
    fs::set_permissions(path, perms).expect("chmod");
}

pub(super) fn tar_am(stage: &Path, tarball: &Path) {
    let status = Command::new("tar")
        .arg("-czf")
        .arg(tarball)
        .arg("-C")
        .arg(stage)
        .arg("am")
        .status()
        .expect("tar");
    assert!(status.success(), "tar exited {status}");
}

pub(super) fn write_sums(release: &Path, tarball: &Path, name: &str, good_sum: bool) {
    let bytes = fs::read(tarball).expect("tarball");
    let hash = if good_sum {
        sha256_hex(&bytes)
    } else {
        "0".repeat(64)
    };
    fs::write(release.join("SHA256SUMS"), format!("{hash}  {name}\n")).expect("sums");
}

pub(super) fn write_version(root: &Path, version: &str) {
    write_version_env(root, version, "production");
}

pub(super) fn write_version_env(root: &Path, version: &str, env: &str) {
    let body =
        format!(r#"{{"surface":"cli","version":"{version}","gitSha":"abc123","env":"{env}"}}"#);
    fs::write(root.join("version.json"), body).expect("version.json");
}
