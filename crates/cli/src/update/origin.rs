//! Update-origin allowlist.
//!
//! The public command hardcodes the install mirror. The library still rejects
//! non-https origins so a test helper or future caller cannot be pointed at an
//! arbitrary cleartext host. Loopback http exists only so unit tests can serve
//! fixtures without a certificate.

use anyhow::{Context, Result, bail};
use url::Url;

/// Normalize `base_url` or fail closed.
pub fn require_update_origin(base_url: &str) -> Result<String> {
    let trimmed = base_url.trim().trim_end_matches('/');
    let url = Url::parse(trimmed).context("parse update origin")?;
    if !origin_is_allowed(&url) {
        bail!("update origin must be https (loopback http is allowed for tests)");
    }
    if !url.username().is_empty() || url.password().is_some() {
        bail!("update origin must not include credentials");
    }
    if url.query().is_some() || url.fragment().is_some() {
        bail!("update origin must not include a query or fragment");
    }
    if url.path() != "/" && !url.path().is_empty() {
        bail!("update origin must not include a path");
    }
    Ok(trimmed.to_string())
}

fn origin_is_allowed(url: &Url) -> bool {
    match url.scheme() {
        "https" => true,
        "http" => is_loopback(url),
        _ => false,
    }
}

fn is_loopback(url: &Url) -> bool {
    match url.host() {
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        Some(url::Host::Domain(domain)) => domain.eq_ignore_ascii_case("localhost"),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_https_and_loopback_http_only() {
        assert!(require_update_origin("https://get.atomicstrata.ai").is_ok());
        assert!(require_update_origin("https://get.atomicstrata.ai/").is_ok());
        assert!(require_update_origin("http://127.0.0.1:9").is_ok());
        assert!(require_update_origin("http://localhost:9").is_ok());
        assert!(require_update_origin("http://[::1]:9").is_ok());
    }

    #[test]
    fn rejects_cleartext_credentials_and_extra_url_parts() {
        assert!(require_update_origin("http://example.com").is_err());
        assert!(require_update_origin("http://127.0.0.1.evil.com").is_err());
        assert!(require_update_origin("https://user:pass@get.atomicstrata.ai").is_err());
        assert!(require_update_origin("https://get.atomicstrata.ai/cli").is_err());
        assert!(require_update_origin("https://get.atomicstrata.ai?x=1").is_err());
    }
}
