//! Download, verify, and atomically install the managed `am-slm` binary.

use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{Context, Result, bail};
use serde::Serialize;
use sha2::{Digest, Sha256};

use super::manifest::{
    ManifestArtifact, VersionManifest, current_target, fetch_manifest, select_artifact,
};
use super::paths::{SlmPaths, SlmStateFile};

/// Result of `install` / `update`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct InstallOutcome {
    pub version: String,
    pub tag: String,
    pub binary_path: PathBuf,
    pub replaced_existing: bool,
    pub artifact_sha256: String,
}

/// Install or update from the public manifest (fail closed on target/checksum).
pub async fn install_or_update(
    client: &reqwest::Client,
    paths: &SlmPaths,
    manifest_url: &str,
) -> Result<InstallOutcome> {
    let target = current_target().ok_or_else(|| {
        anyhow::anyhow!(
            "am-slm is not published for this platform ({os}-{arch}); Apple Silicon macOS only",
            os = std::env::consts::OS,
            arch = std::env::consts::ARCH
        )
    })?;
    let manifest = fetch_manifest(client, manifest_url).await?;
    let artifact = select_artifact(&manifest, target)?.clone();
    install_artifact(client, paths, &manifest, &artifact).await
}

/// Install a previously selected artifact (tests may inject local file URLs).
pub async fn install_artifact(
    client: &reqwest::Client,
    paths: &SlmPaths,
    manifest: &VersionManifest,
    artifact: &ManifestArtifact,
) -> Result<InstallOutcome> {
    paths.ensure()?;
    let staging = paths.staging_dir();
    let _ = fs::remove_dir_all(&staging);
    fs::create_dir_all(&staging).context("recreate am-slm staging dir")?;

    let tarball = staging.join(&artifact.filename);
    download_verified(client, &artifact.url, artifact.sha256.as_str(), &tarball).await?;

    let extract_dir = staging.join("extract");
    fs::create_dir_all(&extract_dir).context("create extract dir")?;
    extract_tarball(&tarball, &extract_dir)?;

    let staged_bin = find_am_slm_binary(&extract_dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&staged_bin)
            .context("stat staged am-slm")?
            .permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&staged_bin, perms).context("chmod staged am-slm")?;
    }

    let dest = paths.binary();
    let replaced_existing = dest.exists();
    let dest_tmp = paths.bin_dir().join("am-slm.new");
    fs::copy(&staged_bin, &dest_tmp).context("copy staged am-slm into bin")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&dest_tmp)?.permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&dest_tmp, perms)?;
    }
    fs::rename(&dest_tmp, &dest).context("atomic replace am-slm binary")?;
    let _ = fs::remove_dir_all(&staging);

    let mut state = paths.read_state().unwrap_or_default();
    state.installed_version = Some(manifest.version.clone());
    state.installed_tag = Some(manifest.tag.clone());
    state.source_sha = Some(manifest.source_sha.clone());
    state.artifact_sha256 = Some(artifact.sha256.clone());
    state.binary_path = Some(dest.display().to_string());
    state.log_path = Some(paths.log_path().display().to_string());
    paths.write_state(&state)?;

    Ok(InstallOutcome {
        version: manifest.version.clone(),
        tag: manifest.tag.clone(),
        binary_path: dest,
        replaced_existing,
        artifact_sha256: artifact.sha256.clone(),
    })
}

async fn download_verified(
    client: &reqwest::Client,
    url: &str,
    expected_sha256: &str,
    dest: &Path,
) -> Result<()> {
    let response = client
        .get(url)
        .send()
        .await
        .with_context(|| format!("download am-slm artifact from {url}"))?;
    if !response.status().is_success() {
        bail!(
            "am-slm artifact unreachable at {url} (HTTP {}) — fail closed",
            response.status()
        );
    }
    let bytes = response
        .bytes()
        .await
        .context("read am-slm artifact bytes")?;
    let digest = hex::encode(Sha256::digest(&bytes));
    if !digest.eq_ignore_ascii_case(expected_sha256) {
        bail!(
            "am-slm artifact checksum mismatch (expected {expected_sha256}, got {digest}) — refusing install"
        );
    }
    let mut file = File::create(dest).context("create am-slm tarball staging file")?;
    file.write_all(&bytes).context("write am-slm tarball")?;
    let _ = file.flush();
    Ok(())
}

fn extract_tarball(tarball: &Path, dest_dir: &Path) -> Result<()> {
    let status = Command::new("tar")
        .args([
            "-xzf",
            tarball
                .to_str()
                .ok_or_else(|| anyhow::anyhow!("am-slm tarball path is not UTF-8"))?,
            "-C",
            dest_dir
                .to_str()
                .ok_or_else(|| anyhow::anyhow!("am-slm extract path is not UTF-8"))?,
        ])
        .status()
        .context("spawn tar to extract am-slm artifact")?;
    if !status.success() {
        bail!("tar failed extracting am-slm artifact (exit {status})");
    }
    Ok(())
}

fn find_am_slm_binary(extract_dir: &Path) -> Result<PathBuf> {
    let direct = extract_dir.join("am-slm");
    if direct.is_file() {
        return Ok(direct);
    }
    for entry in fs::read_dir(extract_dir).context("list am-slm extract dir")? {
        let entry = entry?;
        let candidate = entry.path().join("am-slm");
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    bail!(
        "am-slm binary missing from extracted artifact under {}",
        extract_dir.display()
    );
}

/// SHA-256 hex of a local file (tests / doctor).
#[cfg_attr(not(test), allow(dead_code))]
pub fn file_sha256(path: &Path) -> Result<String> {
    let bytes = fs::read(path).with_context(|| format!("read {}", path.display()))?;
    Ok(hex::encode(Sha256::digest(&bytes)))
}

/// Remove the managed binary and state (models retained unless `purge_models`).
pub fn uninstall(paths: &SlmPaths, purge_models: bool) -> Result<()> {
    let preserved_dims = paths
        .read_state()
        .ok()
        .and_then(|state| state.embedding_dimensions);

    if paths.binary().exists() {
        fs::remove_file(paths.binary()).context("remove am-slm binary")?;
    }
    let _ = fs::remove_file(paths.pid_path());
    let _ = fs::remove_file(paths.state_path());
    let _ = fs::remove_file(paths.log_path());
    let _ = fs::remove_dir_all(paths.staging_dir());
    if purge_models {
        super::cache::purge_managed_model_cache(paths)?;
    }
    // Clear install fields but keep embedding_dimensions marker when Core data remains.
    let state = SlmStateFile {
        embedding_dimensions: preserved_dims,
        ..SlmStateFile::default()
    };
    let _ = paths.write_state(&state);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::slm::SLM_EMBED_DIMENSIONS;
    use crate::slm::manifest::parse_manifest;
    use sha2::{Digest, Sha256};
    use tempfile::tempdir;

    #[test]
    fn checksum_mismatch_surface() {
        let dir = tempdir().unwrap();
        let payload = b"not-a-real-tarball";
        let good = hex::encode(Sha256::digest(payload));
        let tarball = dir.path().join("a.tgz");
        fs::write(&tarball, payload).unwrap();
        assert_eq!(file_sha256(&tarball).unwrap(), good);
        assert_ne!(good, "00".repeat(32));
    }

    #[test]
    fn find_binary_nested_or_flat() {
        let dir = tempdir().unwrap();
        let flat = dir.path().join("flat");
        fs::create_dir_all(&flat).unwrap();
        fs::write(flat.join("am-slm"), b"x").unwrap();
        assert_eq!(find_am_slm_binary(&flat).unwrap(), flat.join("am-slm"));

        let nested_root = dir.path().join("nested");
        let nested = nested_root.join("am-slm-0.1.1");
        fs::create_dir_all(&nested).unwrap();
        fs::write(nested.join("am-slm"), b"x").unwrap();
        assert_eq!(
            find_am_slm_binary(&nested_root).unwrap(),
            nested.join("am-slm")
        );
    }

    #[test]
    fn manifest_fixture_parses_for_install_wiring() {
        let body = include_str!("../../tests/fixtures/am-slm-version.json");
        let m = parse_manifest(body).unwrap();
        assert_eq!(m.version, "0.1.1");
    }

    #[test]
    fn uninstall_preserves_embedding_dimensions_without_purge() {
        let dir = tempdir().unwrap();
        let paths = SlmPaths::at(dir.path().to_path_buf());
        let mut state = paths.read_state().unwrap();
        state.embedding_dimensions = Some(SLM_EMBED_DIMENSIONS);
        paths.write_state(&state).unwrap();
        uninstall(&paths, false).unwrap();
        let state = paths.read_state().unwrap();
        assert_eq!(state.embedding_dimensions, Some(SLM_EMBED_DIMENSIONS));
    }

    #[test]
    fn uninstall_preserves_embedding_dimensions_when_purging_models() {
        let dir = tempdir().unwrap();
        let paths = SlmPaths::at(dir.path().to_path_buf());
        let mut state = paths.read_state().unwrap();
        state.embedding_dimensions = Some(SLM_EMBED_DIMENSIONS);
        paths.write_state(&state).unwrap();
        uninstall(&paths, true).unwrap();
        let state = paths.read_state().unwrap();
        assert_eq!(
            state.embedding_dimensions,
            Some(SLM_EMBED_DIMENSIONS),
            "model-cache purge must not drop the volume/provider marker"
        );
    }
}
