//! CLI version identity and latest-version discovery (ATO-1844).
//!
//! `--version` prints the machine-readable contract documented in
//! `crates/cli/VERSION.md`. Latest published metadata is fetched from the
//! install mirror's `version.json` for the future upgrade gate (ATO-1843);
//! this module does not enforce upgrades.

use std::sync::OnceLock;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

/// Surface id for this binary in the cross-product version contract.
pub const SURFACE: &str = "cli";

/// Default public mirror that publishes latest CLI `version.json`.
pub const DEFAULT_LATEST_VERSION_BASE_URL: &str = "https://get.atomicstrata.ai";

/// Compile-time crate/workspace semver (`[workspace.package].version`).
pub const CRATE_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Env var CI sets to the commit SHA when building release binaries.
#[allow(dead_code)] // referenced by stamp_env_vars / release docs
pub const GIT_SHA_ENV: &str = "AM_GIT_SHA";

/// Env var CI sets to the build channel (`production`, `internal`, `canary`, …).
#[allow(dead_code)] // referenced by stamp_env_vars / release docs
pub const BUILD_ENV_ENV: &str = "AM_BUILD_ENV";

/// Local/dev default when `AM_BUILD_ENV` is unset at compile time.
pub const DEFAULT_BUILD_ENV: &str = "dev";

/// Compile-time stamp env var names (for release docs / CI).
#[allow(dead_code)] // release docs / ATO-1843
pub const fn stamp_env_vars() -> (&'static str, &'static str) {
    (GIT_SHA_ENV, BUILD_ENV_ENV)
}

const LATEST_FETCH_TIMEOUT: Duration = Duration::from_secs(10);

/// Machine-readable identity printed by `am --version` / `am -V`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionInfo {
    pub surface: String,
    pub version: String,
    /// Commit SHA stamped at CI. JSON `null` when unset (local/dev builds).
    #[serde(default)]
    pub git_sha: Option<String>,
    pub env: String,
}

/// Latest published CLI metadata from `{base}/version.json`.
///
/// Extra fields (`tag`, …) are tolerated so installers can keep advertising
/// them without breaking the upgrade-gate parser.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LatestVersionInfo {
    pub surface: String,
    pub version: String,
    #[serde(default)]
    pub git_sha: Option<String>,
    pub env: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tag: Option<String>,
}

impl VersionInfo {
    /// Identity for this running binary.
    pub fn current() -> Self {
        Self {
            surface: SURFACE.to_string(),
            version: CRATE_VERSION.to_string(),
            git_sha: compile_time_git_sha(),
            env: compile_time_build_env().to_string(),
        }
    }

    /// Single-line JSON for clap's `--version` printer.
    pub fn to_json_line(&self) -> String {
        serde_json::to_string(self).expect("VersionInfo serializes")
    }
}

/// Clap `--version` string (JSON object, one line). Cached for `'static`.
pub fn clap_version_json() -> &'static str {
    static JSON: OnceLock<String> = OnceLock::new();
    JSON.get_or_init(|| VersionInfo::current().to_json_line())
}

/// Resolve `AM_GIT_SHA` at compile time. Empty/whitespace → `None` (never fake).
pub fn compile_time_git_sha() -> Option<String> {
    normalize_git_sha(option_env!("AM_GIT_SHA"))
}

/// Resolve `AM_BUILD_ENV` at compile time; default `dev` when unset.
pub fn compile_time_build_env() -> &'static str {
    match option_env!("AM_BUILD_ENV") {
        Some(value) if !value.trim().is_empty() => value,
        _ => DEFAULT_BUILD_ENV,
    }
}

/// Treat missing/blank/`unknown` as unset so local builds do not pretend a SHA.
pub fn normalize_git_sha(raw: Option<&str>) -> Option<String> {
    let value = raw?.trim();
    if value.is_empty() || value.eq_ignore_ascii_case("unknown") {
        return None;
    }
    Some(value.to_string())
}

/// URL for the latest-version discovery document.
pub fn latest_version_url(base_url: &str) -> String {
    format!("{}/version.json", base_url.trim().trim_end_matches('/'))
}

/// Default public discovery URL for the latest CLI version document.
#[allow(dead_code)] // ATO-1843 discovery entrypoint
pub fn default_latest_version_url() -> String {
    latest_version_url(DEFAULT_LATEST_VERSION_BASE_URL)
}

/// Fetch and parse latest CLI version metadata (no upgrade enforcement).
#[allow(dead_code)] // ATO-1843 calls this; no enforcement in this ticket
pub async fn fetch_latest_version(base_url: &str) -> Result<LatestVersionInfo> {
    let url = latest_version_url(base_url);
    let client = reqwest::Client::builder()
        .user_agent(concat!("am/", env!("CARGO_PKG_VERSION")))
        .timeout(LATEST_FETCH_TIMEOUT)
        .build()
        .context("build HTTP client for latest version discovery")?;
    let response = client
        .get(&url)
        .send()
        .await
        .with_context(|| format!("fetch latest version from {url}"))?;
    if !response.status().is_success() {
        bail!(
            "latest version discovery returned HTTP {}",
            response.status()
        );
    }
    let body = response
        .text()
        .await
        .context("read latest version response body")?;
    parse_latest_version_json(&body)
}

/// Parse a `version.json` body into [`LatestVersionInfo`].
pub fn parse_latest_version_json(body: &str) -> Result<LatestVersionInfo> {
    let info: LatestVersionInfo =
        serde_json::from_str(body).context("parse version.json as LatestVersionInfo")?;
    validate_latest_version(&info)?;
    Ok(info)
}

fn validate_latest_version(info: &LatestVersionInfo) -> Result<()> {
    if info.surface != SURFACE {
        bail!(
            "version.json surface must be \"{SURFACE}\", got {:?}",
            info.surface
        );
    }
    if info.version.trim().is_empty() {
        bail!("version.json version must be non-empty");
    }
    if info.env.trim().is_empty() {
        bail!("version.json env must be non-empty");
    }
    // Mirror the binary contract: never accept a faked placeholder SHA.
    if let Some(sha) = info.git_sha.as_deref() {
        if normalize_git_sha(Some(sha)).is_none() {
            bail!("version.json gitSha is empty/unknown; omit the field or set a real SHA");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_uses_crate_semver_and_cli_surface() {
        let info = VersionInfo::current();
        assert_eq!(info.surface, "cli");
        assert_eq!(info.version, CRATE_VERSION);
        assert!(!info.version.is_empty());
        assert_eq!(info.env, compile_time_build_env());
    }

    #[test]
    fn current_json_shape_is_stable() {
        let value: serde_json::Value =
            serde_json::from_str(&VersionInfo::current().to_json_line()).expect("json");
        assert_eq!(value["surface"], "cli");
        assert_eq!(value["version"], CRATE_VERSION);
        assert!(value.get("env").and_then(|v| v.as_str()).is_some());
        assert!(
            value.get("gitSha").is_some(),
            "gitSha key must always be present, got {value}"
        );
        // Local/dev CI without AM_GIT_SHA must not invent a SHA string.
        if option_env!("AM_GIT_SHA").is_none() {
            assert!(
                value["gitSha"].is_null(),
                "unset AM_GIT_SHA must serialize as null, got {value}"
            );
        }
    }

    #[test]
    fn normalize_git_sha_rejects_empty_and_unknown() {
        assert_eq!(normalize_git_sha(None), None);
        assert_eq!(normalize_git_sha(Some("")), None);
        assert_eq!(normalize_git_sha(Some("   ")), None);
        assert_eq!(normalize_git_sha(Some("unknown")), None);
        assert_eq!(normalize_git_sha(Some("UNKNOWN")), None);
        assert_eq!(
            normalize_git_sha(Some("abc123def")),
            Some("abc123def".into())
        );
    }

    #[test]
    fn clap_version_json_is_parseable_contract() {
        let line = clap_version_json();
        let info: VersionInfo = serde_json::from_str(line).expect("clap version json");
        assert_eq!(info.surface, SURFACE);
        assert_eq!(info.version, CRATE_VERSION);
    }

    #[test]
    fn stamp_env_vars_match_compile_time_names() {
        let (git, env) = stamp_env_vars();
        assert_eq!(git, "AM_GIT_SHA");
        assert_eq!(env, "AM_BUILD_ENV");
        assert_eq!(
            default_latest_version_url(),
            "https://get.atomicstrata.ai/version.json"
        );
    }

    #[test]
    fn latest_version_url_joins_version_json() {
        assert_eq!(
            latest_version_url("https://get.atomicstrata.ai"),
            "https://get.atomicstrata.ai/version.json"
        );
        assert_eq!(
            latest_version_url("https://get.atomicstrata.ai/"),
            "https://get.atomicstrata.ai/version.json"
        );
    }

    #[test]
    fn parse_latest_version_json_accepts_contract_plus_tag() {
        let body = r#"{"surface":"cli","version":"0.2.0","gitSha":"deadbeef","env":"production","tag":"cli-v0.2.0"}"#;
        let info = parse_latest_version_json(body).expect("parse");
        assert_eq!(info.surface, "cli");
        assert_eq!(info.version, "0.2.0");
        assert_eq!(info.git_sha.as_deref(), Some("deadbeef"));
        assert_eq!(info.env, "production");
        assert_eq!(info.tag.as_deref(), Some("cli-v0.2.0"));
    }

    #[test]
    fn parse_latest_version_json_allows_missing_git_sha() {
        let body = r#"{"surface":"cli","version":"0.2.0","env":"production"}"#;
        let info = parse_latest_version_json(body).expect("parse");
        assert_eq!(info.git_sha, None);
    }

    #[test]
    fn parse_latest_version_json_rejects_unknown_git_sha() {
        let body = r#"{"surface":"cli","version":"0.2.0","gitSha":"unknown","env":"production"}"#;
        let err = parse_latest_version_json(body).expect_err("unknown sha");
        assert!(
            err.to_string().contains("gitSha") || err.to_string().contains("unknown"),
            "{err:#}"
        );
    }

    #[test]
    fn parse_latest_version_json_rejects_wrong_surface() {
        let body = r#"{"surface":"api","version":"0.2.0","env":"production"}"#;
        assert!(parse_latest_version_json(body).is_err());
    }
}
