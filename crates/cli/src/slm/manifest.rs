//! Public `am-slm` version.json (schema_version 1) — parse + target select.

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

/// Default public manifest URL (ATO-1935 / ATO-1936 contract).
pub const DEFAULT_MANIFEST_URL: &str = "https://get.atomicstrata.ai/am-slm/version.json";

/// Failures specific to manifest consumption (stable operator messages).
#[derive(Debug)]
pub enum ManifestError {
    UnsupportedTarget { found: String },
    UnsupportedSchema { found: u32 },
    MissingArtifact { target: String },
}

impl std::fmt::Display for ManifestError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnsupportedTarget { found } => write!(
                f,
                "am-slm is not published for this platform ({found}); Apple Silicon macOS (aarch64-apple-darwin) only until a Linux/Intel artifact exists"
            ),
            Self::UnsupportedSchema { found } => write!(
                f,
                "am-slm manifest schema_version {found} is unsupported (expected 1)"
            ),
            Self::MissingArtifact { target } => {
                write!(f, "am-slm manifest has no artifact for target {target}")
            }
        }
    }
}

impl std::error::Error for ManifestError {}

/// Top-level `version.json` document.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VersionManifest {
    pub schema_version: u32,
    pub version: String,
    pub tag: String,
    pub source_sha: String,
    pub supported_targets: Vec<String>,
    pub artifacts: Vec<ManifestArtifact>,
    pub min_disk_bytes: MinDiskBytes,
    pub models_catalog_url: String,
    pub runtime_api_compat: String,
    #[serde(default)]
    pub license_id: Option<String>,
    #[serde(default)]
    pub third_party_notices_file: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ManifestArtifact {
    pub target: String,
    pub filename: String,
    pub url: String,
    pub sha256: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MinDiskBytes {
    pub binary_only: u64,
    pub with_models: u64,
}

/// Host target triple the managed runtime publishes for, when supported.
pub fn current_target() -> Option<&'static str> {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        Some("aarch64-apple-darwin")
    } else {
        None
    }
}

/// Human platform label for status / doctor.
pub fn current_platform_label() -> String {
    format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH)
}

/// Parse and validate a manifest body (fail closed on schema drift).
pub fn parse_manifest(body: &str) -> Result<VersionManifest> {
    let manifest: VersionManifest =
        serde_json::from_str(body).context("parse am-slm version.json")?;
    if manifest.schema_version != 1 {
        bail!(ManifestError::UnsupportedSchema {
            found: manifest.schema_version
        });
    }
    if manifest.version.trim().is_empty() {
        bail!("am-slm manifest version must be non-empty");
    }
    if manifest.artifacts.is_empty() {
        bail!("am-slm manifest artifacts must be non-empty");
    }
    if manifest.runtime_api_compat.trim().is_empty() {
        bail!("am-slm manifest runtime_api_compat must be non-empty");
    }
    for artifact in &manifest.artifacts {
        validate_artifact(artifact)?;
    }
    Ok(manifest)
}

fn validate_artifact(artifact: &ManifestArtifact) -> Result<()> {
    if artifact.target.trim().is_empty() {
        bail!("am-slm artifact target must be non-empty");
    }
    if artifact.url.trim().is_empty() {
        bail!("am-slm artifact url must be non-empty");
    }
    if artifact.sha256.len() != 64 || !artifact.sha256.chars().all(|c| c.is_ascii_hexdigit()) {
        bail!(
            "am-slm artifact sha256 must be 64 hex chars, got {:?}",
            artifact.sha256
        );
    }
    if artifact.size_bytes == 0 {
        bail!("am-slm artifact size_bytes must be > 0");
    }
    Ok(())
}

/// Select the artifact for `target`, fail closed when unsupported/missing.
pub fn select_artifact<'a>(
    manifest: &'a VersionManifest,
    target: &str,
) -> Result<&'a ManifestArtifact> {
    if !manifest.supported_targets.iter().any(|t| t == target) {
        bail!(ManifestError::UnsupportedTarget {
            found: target.to_string()
        });
    }
    manifest
        .artifacts
        .iter()
        .find(|a| a.target == target)
        .ok_or_else(|| {
            anyhow::Error::new(ManifestError::MissingArtifact {
                target: target.to_string(),
            })
        })
}

/// Fetch + parse the public (or override) manifest URL.
pub async fn fetch_manifest(client: &reqwest::Client, url: &str) -> Result<VersionManifest> {
    let response = client
        .get(url)
        .send()
        .await
        .with_context(|| format!("fetch am-slm manifest from {url}"))?;
    if !response.status().is_success() {
        bail!(
            "am-slm manifest unreachable at {url} (HTTP {}) — check network / R2",
            response.status()
        );
    }
    let body = response.text().await.context("read am-slm manifest body")?;
    parse_manifest(&body)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = include_str!("../../tests/fixtures/am-slm-version.json");

    #[test]
    fn parses_public_0_1_1_contract() {
        let m = parse_manifest(FIXTURE).unwrap();
        assert_eq!(m.version, "0.1.1");
        assert_eq!(m.runtime_api_compat, "am-slm-openai-v1");
        let art = select_artifact(&m, "aarch64-apple-darwin").unwrap();
        assert_eq!(art.sha256.len(), 64);
        assert_eq!(art.size_bytes, 6_374_708);
    }

    #[test]
    fn rejects_unsupported_target() {
        let m = parse_manifest(FIXTURE).unwrap();
        let err = select_artifact(&m, "x86_64-unknown-linux-gnu").unwrap_err();
        assert!(err.to_string().contains("Apple Silicon"));
    }

    #[test]
    fn rejects_bad_schema_and_sha() {
        assert!(parse_manifest(r#"{"schema_version":2,"version":"1","tag":"t","source_sha":"s","supported_targets":[],"artifacts":[],"min_disk_bytes":{"binary_only":1,"with_models":1},"models_catalog_url":"u","runtime_api_compat":"c"}"#).is_err());
        let mut bad = FIXTURE.to_string();
        if let Some(art) = parse_manifest(FIXTURE).unwrap().artifacts.first() {
            bad = bad.replace(&art.sha256, "deadbeef");
        }
        assert!(parse_manifest(&bad).is_err());
    }
}
