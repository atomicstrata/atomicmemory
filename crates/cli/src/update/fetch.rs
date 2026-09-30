//! HTTP transport for `am update`.
//!
//! One dedicated client per run, pinned to the validated update origin: https
//! only (loopback http exists solely for the test path `require_update_origin`
//! already allows), redirects only to the same scheme, host, and port, and
//! every body read through a size cap so a hostile or broken mirror cannot
//! exhaust memory. Carries the shared CLI user agent.

use std::path::Path;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use reqwest::redirect::{Attempt, Policy};
use url::Url;

use super::checksum::verify_sha256;
use super::exclusive::write_exclusive;
use crate::auth::http::USER_AGENT;
use crate::version::{LatestVersionInfo, latest_version_url, parse_latest_version_json};

const ARTIFACT_TIMEOUT: Duration = Duration::from_secs(120);
const VERSION_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_REDIRECTS: usize = 5;

/// Largest accepted `version.json` body.
pub const VERSION_DOC_LIMIT: u64 = 64 * 1024;
/// Largest accepted `SHA256SUMS` body.
pub const SUMS_LIMIT: u64 = 64 * 1024;
/// Largest accepted release tarball.
pub const TARBALL_LIMIT: u64 = 256 * 1024 * 1024;

/// Client for every update request against `origin`.
pub fn update_client(origin: &str) -> Result<reqwest::Client> {
    let origin = Url::parse(origin).context("parse update origin")?;
    let https_only = origin.scheme() == "https";
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(ARTIFACT_TIMEOUT)
        .https_only(https_only)
        .redirect(Policy::custom(move |attempt| {
            same_origin_redirect(&origin, attempt)
        }))
        .build()
        .context("build HTTP client for CLI update")
}

fn same_origin_redirect(origin: &Url, attempt: Attempt<'_>) -> reqwest::redirect::Action {
    if attempt.previous().len() > MAX_REDIRECTS {
        return attempt.error("too many redirects from the update origin");
    }
    if redirect_allowed(origin, attempt.url()) {
        return attempt.follow();
    }
    let target = attempt.url().clone();
    attempt.error(format!(
        "refusing update redirect to {target}: only the update origin {} is trusted",
        origin.origin().ascii_serialization()
    ))
}

/// Whether a redirect to `target` stays on `origin` (same scheme, host, port).
pub fn redirect_allowed(origin: &Url, target: &Url) -> bool {
    origin.origin() == target.origin()
}

/// Fetch and validate `{origin}/version.json`.
pub async fn fetch_latest_version(
    client: &reqwest::Client,
    origin: &str,
) -> Result<LatestVersionInfo> {
    let url = latest_version_url(origin);
    let body = fetch_limited(client, &url, VERSION_DOC_LIMIT, Some(VERSION_TIMEOUT))
        .await
        .context("latest version discovery")?;
    let text = String::from_utf8(body).context("version.json is not utf-8")?;
    parse_latest_version_json(&text)
}

/// GET a small text body, failing on any non-success status or oversize body.
pub async fn fetch_text(client: &reqwest::Client, url: &str, limit: u64) -> Result<String> {
    let body = fetch_limited(client, url, limit, None).await?;
    String::from_utf8(body).with_context(|| format!("{url} is not utf-8"))
}

/// Download `url` and write it only after the digest matches `expected_sha`.
pub async fn download_verified(
    client: &reqwest::Client,
    url: &str,
    expected_sha: &str,
    dest: &Path,
) -> Result<()> {
    let bytes = fetch_limited(client, url, TARBALL_LIMIT, None).await?;
    verify_sha256(&bytes, expected_sha)?;
    write_exclusive(dest, &bytes)
}

/// GET `url` and read at most `limit` bytes of body.
pub async fn fetch_limited(
    client: &reqwest::Client,
    url: &str,
    limit: u64,
    timeout: Option<Duration>,
) -> Result<Vec<u8>> {
    let mut request = client.get(url);
    if let Some(timeout) = timeout {
        request = request.timeout(timeout);
    }
    let mut response = request
        .send()
        .await
        .with_context(|| format!("fetch {url}"))?;
    if !response.status().is_success() {
        bail!("{url} returned HTTP {}", response.status());
    }
    if let Some(declared) = response.content_length() {
        ensure_within_limit(url, declared, limit)?;
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .with_context(|| format!("read {url}"))?
    {
        append_limited(&mut body, &chunk, url, limit)?;
    }
    Ok(body)
}

fn append_limited(body: &mut Vec<u8>, chunk: &[u8], url: &str, limit: u64) -> Result<()> {
    let total = body.len() as u64 + chunk.len() as u64;
    ensure_within_limit(url, total, limit)?;
    body.extend_from_slice(chunk);
    Ok(())
}

fn ensure_within_limit(url: &str, size: u64, limit: u64) -> Result<()> {
    if size > limit {
        bail!("{url} is larger than the {limit}-byte update limit");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(raw: &str) -> Url {
        Url::parse(raw).expect("url")
    }

    #[test]
    fn redirects_stay_on_the_update_origin() {
        let origin = url("https://get.atomicstrata.ai");
        assert!(redirect_allowed(
            &origin,
            &url("https://get.atomicstrata.ai/cli/v0.2.0/SHA256SUMS")
        ));
        assert!(!redirect_allowed(&origin, &url("https://evil.example/am")));
        assert!(!redirect_allowed(
            &origin,
            &url("https://get.atomicstrata.ai.evil.example/am")
        ));
        assert!(!redirect_allowed(
            &origin,
            &url("https://get.atomicstrata.ai:8443/am")
        ));
    }

    #[test]
    fn redirects_cannot_downgrade_to_cleartext() {
        let origin = url("https://get.atomicstrata.ai");
        assert!(!redirect_allowed(
            &origin,
            &url("http://get.atomicstrata.ai/version.json")
        ));
    }

    #[test]
    fn streamed_body_stops_at_the_limit() {
        let mut body = Vec::new();
        append_limited(&mut body, &[0; 8], "u", 10).expect("under");
        let err = append_limited(&mut body, &[0; 3], "u", 10).expect_err("over");
        assert!(err.to_string().contains("limit"), "{err}");
        assert_eq!(body.len(), 8);
    }

    #[test]
    fn update_client_rejects_cleartext_for_an_https_origin() {
        let client = update_client("https://get.atomicstrata.ai").expect("client");
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        let err = runtime
            .block_on(fetch_limited(&client, "http://127.0.0.1:1/x", 10, None))
            .expect_err("cleartext");
        assert!(
            format!("{err:#}").contains("scheme is not allowed"),
            "{err:#}"
        );
    }
}
