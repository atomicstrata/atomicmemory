//! Strict `X.Y.Z` comparison for CLI self-update.
//!
//! The public release bump rule only publishes three numeric components, so
//! this parser rejects prefixes, pre-release tags, and build metadata instead
//! of guessing.

use anyhow::{Context, Result, bail};

/// Numeric CLI release version.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct SemVer {
    major: u64,
    minor: u64,
    patch: u64,
}

/// True when `latest` is a strictly newer `X.Y.Z` than `current`.
pub fn latest_is_newer(current: &str, latest: &str) -> Result<bool> {
    let current = parse_semver(current)?;
    let latest = parse_semver(latest)?;
    Ok(latest > current)
}

/// Parse an installer-shaped version (`^[0-9]+\.[0-9]+\.[0-9]+$`).
pub fn parse_semver(raw: &str) -> Result<SemVer> {
    let mut parts = raw.split('.');
    let major = parse_component(raw, parts.next())?;
    let minor = parse_component(raw, parts.next())?;
    let patch = parse_component(raw, parts.next())?;
    if parts.next().is_some() {
        bail!("invalid version: {raw} (expected X.Y.Z)");
    }
    Ok(SemVer {
        major,
        minor,
        patch,
    })
}

fn parse_component(raw: &str, part: Option<&str>) -> Result<u64> {
    let part = part.with_context(|| format!("invalid version: {raw} (expected X.Y.Z)"))?;
    if part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()) {
        bail!("invalid version: {raw} (expected X.Y.Z)");
    }
    part.parse()
        .with_context(|| format!("invalid version: {raw} (expected X.Y.Z)"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn newer_patch_minor_and_major_are_ordered_numerically() {
        assert!(!latest_is_newer("0.2.0", "0.2.0").unwrap());
        assert!(latest_is_newer("0.2.0", "0.2.1").unwrap());
        assert!(!latest_is_newer("0.2.1", "0.2.0").unwrap());
        assert!(latest_is_newer("0.2.0", "0.10.0").unwrap());
        assert!(!latest_is_newer("1.0.0", "0.9.9").unwrap());
    }

    #[test]
    fn rejects_versions_that_are_not_three_numeric_components() {
        assert!(parse_semver("0.2").is_err());
        assert!(parse_semver("v0.2.0").is_err());
        assert!(parse_semver("0.2.0-rc.1").is_err());
        assert!(parse_semver("0.2.0.1").is_err());
    }
}
