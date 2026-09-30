//! Extract a verified tarball and atomically replace the installed `am`.
//!
//! The final version check and rename share a per-install lock so a slower
//! updater cannot overwrite a newer binary that landed after this process
//! started. The binary is extracted into a fresh private directory beside the
//! installed file (`mkdir` fails on any existing entry, so nothing planted is
//! followed), probed with `--version` from there so a `noexec` system temp
//! does not matter, fsynced, and renamed on the same filesystem. The parent
//! directory is fsynced after the rename so the swap survives a crash.

use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use fs4::fs_std::FileExt;

use crate::version::{SURFACE, VersionInfo};

use super::UpdateRequest;
use super::attest::{AttestationOutcome, enforce_attestation};
use super::channel::{PUBLIC_INSTALL_COMMAND, ensure_production_channel};
use super::checksum::expected_sha256;
use super::exclusive::{create_private_dir, random_token};
use super::fetch::{SUMS_LIMIT, download_verified, fetch_text};
use super::semver::latest_is_newer;
use super::target::{artifact_name, artifact_url, current_target, sums_url};

const STAGED_VERSION_TIMEOUT: Duration = Duration::from_secs(10);

/// Fail when this process cannot create a new file next to `dest`.
pub fn ensure_dest_writable(dest: &Path) -> Result<()> {
    let dir = dest
        .parent()
        .context("installed am path has no parent directory")?;
    let probe = dir.join(format!(".am.update.probe.{}", random_token()));
    match OpenOptions::new().write(true).create_new(true).open(&probe) {
        Ok(_) => {
            let _ = fs::remove_file(&probe);
            Ok(())
        }
        Err(err) => bail!(
            "cannot update {}: {} is not writable ({err}). Reinstall with: {PUBLIC_INSTALL_COMMAND}",
            dest.display(),
            dir.display()
        ),
    }
}

/// Download, verify, and replace `request.dest` with published `version`.
///
/// Returns whether the installed file was replaced. A concurrent newer install
/// leaves `dest` unchanged and returns `false`.
pub async fn install_release(
    client: &reqwest::Client,
    base: &str,
    version: &str,
    request: &UpdateRequest<'_>,
) -> Result<bool> {
    let target = current_target()?;
    let name = artifact_name(version, target);
    note(request.quiet, &format!("info: downloading {name}"));
    let work = WorkDir::create()?;
    let tarball = download_release(client, &work, base, version, target, &name).await?;
    let outcome = enforce_attestation(request.attestation, request.gh, &tarball, version).await?;
    if let AttestationOutcome::ChecksumOnly(warning) = outcome {
        note(request.quiet, warning);
    }
    let stage = stage_release(&tarball, request.dest, version).await?;
    let replaced = commit_install(&stage.binary(), request.dest, version).await?;
    if replaced {
        note(
            request.quiet,
            &format!("info: installed am {version} -> {}", request.dest.display()),
        );
    }
    Ok(replaced)
}

async fn download_release(
    client: &reqwest::Client,
    work: &WorkDir,
    base: &str,
    version: &str,
    target: &str,
    name: &str,
) -> Result<PathBuf> {
    let sums = fetch_text(client, &sums_url(base, version), SUMS_LIMIT).await?;
    let expected = expected_sha256(&sums, name)?;
    let tarball = work.path.join(name);
    let url = artifact_url(base, version, target);
    download_verified(client, &url, &expected, &tarball).await?;
    Ok(tarball)
}

/// Extract `am` beside `dest`, make it executable, flush it, and confirm its identity.
async fn stage_release(tarball: &Path, dest: &Path, version: &str) -> Result<StageDir> {
    let stage = StageDir::create(dest)?;
    let staged = extract_am(tarball, &stage.0)?;
    set_executable(&staged)?;
    sync_file(&staged)?;
    confirm_staged_version(&staged, version).await?;
    Ok(stage)
}

fn extract_am(tarball: &Path, dest_dir: &Path) -> Result<PathBuf> {
    let status = Command::new("tar")
        .arg("-xzf")
        .arg(tarball)
        .arg("-C")
        .arg(dest_dir)
        .arg("am")
        .status()
        .context("run tar to extract the CLI update (tar is required)")?;
    if !status.success() {
        bail!("tar failed to extract the CLI update ({status})");
    }
    let bin = dest_dir.join("am");
    if !is_regular_file(&bin) {
        bail!("archive did not contain a regular file named am");
    }
    Ok(bin)
}

async fn confirm_staged_version(path: &Path, expected: &str) -> Result<()> {
    let info = read_version(path)
        .await
        .context("read staged am --version")?;
    require_production_cli(&info)?;
    if info.version != expected {
        bail!(
            "staged binary identity mismatch (surface {}, version {}, expected {expected})",
            info.surface,
            info.version
        );
    }
    Ok(())
}

/// Lock, re-read the installed binary, and replace it only when `version` is newer.
///
/// `staged` must already be synced and live on the same filesystem as `dest`
/// (a sibling of it). A failed identity probe is an error. It is not
/// permission to overwrite `dest`.
pub(crate) async fn commit_install(staged: &Path, dest: &Path, version: &str) -> Result<bool> {
    let _lock = acquire_install_lock(dest)?;
    replace_if_newer(staged, dest, version).await
}

/// Exclusive lock beside `dest`. Held across the on-disk version check and rename.
pub(crate) fn acquire_install_lock(dest: &Path) -> Result<InstallLock> {
    let parent = dest
        .parent()
        .context("installed am path has no parent directory")?;
    let name = dest.file_name().and_then(|n| n.to_str()).unwrap_or("am");
    let path = parent.join(format!(".{name}.update.lock"));
    let file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false)
        .open(&path)
        .with_context(|| format!("open update lock {}", path.display()))?;
    file.lock_exclusive()
        .with_context(|| format!("lock {}", path.display()))?;
    Ok(InstallLock(file))
}

async fn replace_if_newer(staged: &Path, dest: &Path, version: &str) -> Result<bool> {
    let installed = installed_identity(dest).await?;
    if !latest_is_newer(&installed.version, version)? {
        return Ok(false);
    }
    replace_executable(staged, dest)?;
    Ok(true)
}

async fn installed_identity(path: &Path) -> Result<VersionInfo> {
    let info = match read_version(path).await {
        Ok(info) => info,
        Err(err) => bail!("read installed am identity {}: {err:#}", path.display()),
    };
    require_production_cli(&info)?;
    Ok(info)
}

fn require_production_cli(info: &VersionInfo) -> Result<()> {
    if info.surface != SURFACE {
        bail!("binary surface is {}, expected {SURFACE}", info.surface);
    }
    ensure_production_channel(&info.env)
}

fn replace_executable(staged: &Path, dest: &Path) -> Result<()> {
    fs::rename(staged, dest).context("replace installed am binary")?;
    let parent = dest
        .parent()
        .context("installed am path has no parent directory")?;
    sync_dir(parent)
}

fn sync_file(path: &Path) -> Result<()> {
    File::open(path)
        .and_then(|file| file.sync_all())
        .with_context(|| format!("fsync {}", path.display()))
}

#[cfg(unix)]
fn sync_dir(dir: &Path) -> Result<()> {
    File::open(dir)
        .and_then(|file| file.sync_all())
        .with_context(|| format!("fsync {}", dir.display()))
}

#[cfg(not(unix))]
fn sync_dir(dir: &Path) -> Result<()> {
    let _ = dir;
    Ok(())
}

async fn read_version(path: &Path) -> Result<VersionInfo> {
    let output = tokio::time::timeout(
        STAGED_VERSION_TIMEOUT,
        tokio::process::Command::new(path).arg("--version").output(),
    )
    .await
    .context("timed out running am --version")?
    .context("run am --version")?;
    if !output.status.success() {
        bail!("am --version exited {}", output.status);
    }
    let stdout = String::from_utf8(output.stdout).context("am --version was not utf-8")?;
    serde_json::from_str(stdout.trim()).context("parse am --version")
}

fn is_regular_file(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|meta| meta.file_type().is_file())
        .unwrap_or(false)
}

fn note(quiet: bool, message: &str) {
    if !quiet {
        eprintln!("{message}");
    }
}

/// Held for the critical section. Unlock on drop so the next updater can proceed.
pub(crate) struct InstallLock(File);

impl Drop for InstallLock {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.0);
    }
}

/// Private directory beside the installed binary, removed with its contents on drop.
struct StageDir(PathBuf);

impl StageDir {
    fn create(dest: &Path) -> Result<Self> {
        let parent = dest
            .parent()
            .context("installed am path has no parent directory")?;
        let path = parent.join(format!(".am.update.{}", random_token()));
        create_private_dir(&path)?;
        Ok(Self(path))
    }

    fn binary(&self) -> PathBuf {
        self.0.join("am")
    }
}

impl Drop for StageDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Private system-temp directory for the downloaded tarball. Nothing here is executed.
struct WorkDir {
    path: PathBuf,
}

impl WorkDir {
    fn create() -> Result<Self> {
        let path = std::env::temp_dir().join(format!("am-update-{}", random_token()));
        create_private_dir(&path)?;
        Ok(Self { path })
    }
}

impl Drop for WorkDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

#[cfg(unix)]
fn set_executable(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mut perms = fs::metadata(path)
        .with_context(|| format!("stat {}", path.display()))?
        .permissions();
    perms.set_mode(0o755);
    fs::set_permissions(path, perms).with_context(|| format!("chmod {}", path.display()))
}

#[cfg(not(unix))]
fn set_executable(path: &Path) -> Result<()> {
    let _ = path;
    bail!("am update cannot replace a binary on this platform")
}
