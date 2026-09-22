//! Shared HTTP client construction for CLI authentication requests.

use std::time::Duration;

use anyhow::{Context, Result};

const AUTH_HTTP_TIMEOUT: Duration = Duration::from_secs(30);
pub(crate) const USER_AGENT: &str = concat!("am/", env!("CARGO_PKG_VERSION"));

/// Build an authentication client identified by the CLI name and version.
///
/// The production Cloud edge rejects requests without a user agent, so all
/// authentication requests must use this constructor rather than a raw client.
pub(crate) fn client() -> Result<reqwest::Client> {
    client_with_timeout(AUTH_HTTP_TIMEOUT).context("build authentication HTTP client")
}

/// Build an identified authentication client with a caller-specific timeout.
pub(crate) fn client_with_timeout(timeout: Duration) -> reqwest::Result<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(timeout)
        .build()
}

#[cfg(test)]
mod tests {
    const AUTH_SOURCES: &[(&str, &str)] = &[
        ("auth_wait.rs", include_str!("auth_wait.rs")),
        ("claims.rs", include_str!("claims.rs")),
        ("clerk_oauth.rs", include_str!("clerk_oauth.rs")),
        ("device_login.rs", include_str!("device_login.rs")),
        ("doctor.rs", include_str!("doctor.rs")),
        ("ensure_org.rs", include_str!("ensure_org.rs")),
        ("login.rs", include_str!("login.rs")),
        ("login_feedback.rs", include_str!("login_feedback.rs")),
        ("mod.rs", include_str!("mod.rs")),
        ("origin.rs", include_str!("origin.rs")),
        ("pkce.rs", include_str!("pkce.rs")),
        ("setup.rs", include_str!("setup.rs")),
        ("token.rs", include_str!("token.rs")),
        ("token_login.rs", include_str!("token_login.rs")),
    ];

    fn invokes_constructor(compact: &str, type_name: &str) -> bool {
        ["builder", "new"].iter().any(|method| {
            let needle = format!("{type_name}::{method}(");
            compact.match_indices(&needle).any(|(offset, _)| {
                compact[..offset]
                    .chars()
                    .next_back()
                    .is_none_or(|prefix| !prefix.is_alphanumeric() && prefix != '_')
            })
        })
    }

    fn constructs_raw_client(source: &str) -> bool {
        let compact: String = source
            .chars()
            .filter(|character| !character.is_whitespace())
            .collect();
        if invokes_constructor(&compact, "Client") {
            return true;
        }

        compact.split(';').any(|statement| {
            if !statement.starts_with("usereqwest::") {
                return false;
            }
            statement.find("Clientas").is_some_and(|offset| {
                let alias = statement[offset + "Clientas".len()..]
                    .chars()
                    .take_while(|character| character.is_alphanumeric() || *character == '_')
                    .collect::<String>();
                !alias.is_empty() && invokes_constructor(&compact, &alias)
            })
        })
    }

    #[test]
    fn cloud_auth_callers_cannot_bypass_the_shared_http_client() {
        let declared_modules: Vec<&str> = include_str!("mod.rs")
            .lines()
            .filter_map(|line| {
                line.trim()
                    .strip_prefix("pub mod ")
                    .and_then(|module| module.strip_suffix(';'))
            })
            .filter(|module| *module != "http")
            .collect();
        let scanned_modules: Vec<&str> = AUTH_SOURCES
            .iter()
            .filter_map(|(path, _)| path.strip_suffix(".rs"))
            .filter(|module| *module != "mod")
            .collect();

        assert_eq!(
            scanned_modules, declared_modules,
            "every auth module must be included in the raw-client source scan",
        );

        for (path, source) in AUTH_SOURCES.iter().copied().chain([(
            "commands/connect.rs",
            include_str!("../commands/connect.rs"),
        )]) {
            assert!(
                !constructs_raw_client(source),
                "{path} must use auth::http rather than construct a raw reqwest client",
            );
        }
    }

    #[test]
    fn raw_client_scan_rejects_spaced_rust_syntax() {
        assert!(constructs_raw_client("reqwest::Client :: builder ()"));
        assert!(constructs_raw_client("Client :: new ()"));
        assert!(constructs_raw_client(
            "use reqwest::Client as HttpClient; HttpClient :: new()"
        ));
        assert!(constructs_raw_client(
            "use reqwest::{Client as C}; C :: builder()"
        ));
        assert!(!constructs_raw_client("DashboardClient :: new ()"));
    }
}
