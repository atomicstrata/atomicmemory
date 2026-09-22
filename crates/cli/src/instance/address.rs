//! Validated loopback addresses for the managed Docker binding.

use anyhow::{Result, bail};
use url::Url;

/// A managed endpoint, derived from a loopback host and validated port.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManagedAddress {
    port: u16,
}

impl ManagedAddress {
    /// Accept only HTTP numeric IPv4 loopback or localhost, without URL extras.
    pub fn parse(value: &str) -> Result<Self> {
        let url = Url::parse(value)?;
        if url.scheme() != "http"
            || !matches!(url.host_str(), Some("127.0.0.1" | "localhost"))
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || !matches!(url.path(), "" | "/")
        {
            bail!(
                "managed Core requires http://127.0.0.1:<port> (or localhost); use --no-instance for an externally managed Core"
            );
        }
        let port = url
            .port_or_known_default()
            .filter(|port| *port > 0)
            .ok_or_else(|| anyhow::anyhow!("managed Core requires a nonzero TCP port"))?;
        Ok(Self { port })
    }

    /// The host-side Docker port.
    pub fn port(&self) -> u16 {
        self.port
    }

    /// Canonical URL used for published labels and authenticated probes.
    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_custom_port_and_normalizes_localhost() {
        let address = ManagedAddress::parse("http://localhost:17352/").unwrap();
        assert_eq!(address.port(), 17352);
        assert_eq!(address.url(), "http://127.0.0.1:17352");
    }

    #[test]
    fn refuses_remote_or_ambiguous_managed_addresses() {
        for value in [
            "https://127.0.0.1:17352",
            "http://example.com:17352",
            "http://127.0.0.1:0",
            "http://user@localhost:17352",
            "http://localhost:17352/path",
            "http://localhost:17352?x=1",
            "http://localhost:17352#x",
            "http://localhost.example.com:17352",
        ] {
            assert!(ManagedAddress::parse(value).is_err(), "{value}");
        }
    }
}
