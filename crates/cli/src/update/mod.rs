//! User-invoked replacement of a production `am` binary.
//!
//! Discovers the latest public release, verifies the platform tarball against
//! `SHA256SUMS`, and renames it over the current executable. This is not the
//! idle upgrade gate: nothing here runs unless the user asks.

mod attest;
mod channel;
mod checksum;
mod exclusive;
mod fetch;
mod install;
mod origin;
mod semver;
mod target;

#[cfg(all(test, unix))]
mod apply_tests;
#[cfg(test)]
mod fixture_server;
#[cfg(test)]
mod plan_tests;
#[cfg(all(test, unix))]
mod release_fixture;
#[cfg(all(test, unix))]
mod transport_tests;

use std::ffi::OsStr;
use std::path::Path;

use anyhow::Result;
use serde::Serialize;

use crate::version::latest_version_url;

use channel::ensure_production_channel;
use fetch::{fetch_latest_version, update_client};
use install::{ensure_dest_writable, install_release};
use origin::require_update_origin;
use semver::latest_is_newer;
use target::current_target;

pub use attest::{AttestationMode, GH_PROGRAM, parse_attestation_mode};

/// What `am update` should do for one invocation.
pub struct UpdateRequest<'a> {
    /// Install-mirror origin, without a path.
    pub base_url: &'a str,
    /// Compile-time `AM_BUILD_ENV` of the running binary.
    pub build_env: &'a str,
    /// Compile-time semver of the running binary.
    pub current_version: &'a str,
    /// Canonical path of the binary to replace.
    pub dest: &'a Path,
    /// Fetch and compare only; do not download or replace.
    pub check_only: bool,
    /// Suppress stderr progress lines.
    pub quiet: bool,
    /// `AM_VERIFY_ATTESTATION` policy for this invocation.
    pub attestation: AttestationMode,
    /// GitHub CLI used for attestation ([`GH_PROGRAM`]; tests pass a stub).
    pub gh: &'a OsStr,
}

/// Machine-readable result printed by `am update`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateReport {
    /// `current`, `available`, or `updated`.
    pub status: String,
    pub current_version: String,
    pub latest_version: String,
    pub update_available: bool,
    pub replaced: bool,
    pub binary_path: String,
}

/// Compare this binary with the published release and maybe replace it.
pub async fn run_update(request: UpdateRequest<'_>) -> Result<UpdateReport> {
    ensure_production_channel(request.build_env)?;
    let base = require_update_origin(request.base_url)?;
    current_target()?;
    if !request.check_only {
        ensure_dest_writable(request.dest)?;
    }
    note(
        request.quiet,
        &format!(
            "info: resolving latest version from {}",
            latest_version_url(&base)
        ),
    );
    let client = update_client(&base)?;
    let latest = fetch_latest_version(&client, &base).await?;
    finish_or_install(&request, &client, &base, &latest.version, &latest.env).await
}

async fn finish_or_install(
    request: &UpdateRequest<'_>,
    client: &reqwest::Client,
    base: &str,
    latest: &str,
    latest_env: &str,
) -> Result<UpdateReport> {
    ensure_production_channel(latest_env)?;
    let update_available = latest_is_newer(request.current_version, latest)?;
    if !update_available || request.check_only {
        return Ok(report(request, latest, update_available, false));
    }
    let replaced = install_release(client, base, latest, request).await?;
    Ok(report(request, latest, replaced, replaced))
}

fn report(
    request: &UpdateRequest<'_>,
    latest: &str,
    update_available: bool,
    replaced: bool,
) -> UpdateReport {
    let status = if replaced {
        "updated"
    } else if update_available {
        "available"
    } else {
        "current"
    };
    UpdateReport {
        status: status.to_string(),
        current_version: request.current_version.to_string(),
        latest_version: latest.to_string(),
        update_available,
        replaced,
        binary_path: request.dest.display().to_string(),
    }
}

fn note(quiet: bool, message: &str) {
    if !quiet {
        eprintln!("{message}");
    }
}
