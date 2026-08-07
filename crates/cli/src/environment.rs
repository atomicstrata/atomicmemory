//! Cloud environment presets (production) and URL resolution helpers.

use std::fmt;

use clap::ValueEnum;
use serde::{Deserialize, Serialize};
use url::Url;

pub const ENV_CORE_IMAGE: &str = "ATOMICMEMORY_CORE_IMAGE";

/// Hostnames treated as production Cloud API endpoints (exact match, lowercase).
pub const PROD_API_HOSTS: [&str; 1] = ["api.atomicstrata.ai"];

/// Named Cloud tier — production preset only in the public CLI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize, ValueEnum)]
#[serde(rename_all = "lowercase")]
#[value(rename_all = "lowercase")]
pub enum Environment {
    #[default]
    Prod,
}

impl Environment {
    pub const PROD_BASE_URL: &'static str = "https://api.atomicstrata.ai";
    pub const PROD_CORE_IMAGE: &'static str = "ghcr.io/atomicstrata/atomicmemory-core:latest";
    pub const PROD_OAUTH_ISSUER: &'static str = "https://clerk.atomicstrata.ai";

    /// Public OAuth client_id for prod Clerk (NOT a secret).
    pub const PROD_OAUTH_CLIENT_ID: &'static str = "FCJpVFZsULYPj8sa";

    pub fn base_url(self) -> &'static str {
        Self::PROD_BASE_URL
    }

    pub fn core_image(self) -> &'static str {
        Self::PROD_CORE_IMAGE
    }

    /// Label forwarded to Core as `CLOUD_ENV`.
    pub fn cloud_env_label(self) -> &'static str {
        "production"
    }
}

impl fmt::Display for Environment {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "prod")
    }
}

/// Parse and normalize a Cloud API base URL.
pub fn parse_api_base_url(raw: &str) -> Result<Url, url::ParseError> {
    let trimmed = raw.trim();
    let with_scheme = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };
    let mut url = Url::parse(&with_scheme)?;
    url.set_fragment(None);
    let mut path = url.path().trim_end_matches('/').to_string();
    if path.is_empty() {
        path = "/".to_string();
    } else if !path.ends_with('/') {
        path.push('/');
    }
    url.set_path(&path);
    Ok(url)
}

/// True when the URL is the canonical production Cloud API origin.
///
/// This gates whether the shipped production OAuth identity is used and,
/// downstream, whether a bearer token is attached to the request. Matching on
/// hostname alone would treat `http://api.atomicstrata.ai` (cleartext, so the
/// token is exposed to anyone on path) and non-default ports as production, so
/// the scheme and port must be canonical too.
pub fn is_production_api_url(raw: &str) -> bool {
    let Ok(url) = parse_api_base_url(raw) else {
        return false;
    };
    if url.scheme() != "https" {
        return false;
    }
    // `Url::port()` is None when the port is the scheme default (443).
    if url.port().is_some_and(|port| port != 443) {
        return false;
    }
    url.host_str()
        .map(str::to_ascii_lowercase)
        .is_some_and(|host| PROD_API_HOSTS.contains(&host.as_str()))
}

/// Dashboard project overview URL for production Cloud hosts only.
pub fn dashboard_project_url(api_base_url: &str, project_id: &str) -> Option<String> {
    if !is_production_api_url(api_base_url) {
        return None;
    }
    let normalized = parse_api_base_url(api_base_url).ok()?.to_string();
    let memory = normalized.replace("://api.", "://memory.");
    Some(format!("{memory}app/projects/{project_id}/overview"))
}

/// Map a Cloud API base URL to Core's `CLOUD_ENV` tier label.
pub fn cloud_tier_from_api_url(api_url: &str) -> &'static str {
    if is_production_api_url(api_url) {
        Environment::Prod.cloud_env_label()
    } else {
        "custom"
    }
}

/// Where a resolved config value came from (for `am config env show`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ValueSource {
    Flag,
    Profile,
    Config,
    BuiltInDefault,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Resolved<T> {
    pub value: T,
    pub source: ValueSource,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct BaseUrlInput<'a> {
    pub base_url_override: Option<&'a str>,
    pub environment_override: Option<Environment>,
    pub profile_base_url: Option<&'a str>,
    pub config_environment: Option<Environment>,
}

pub fn resolve_base_url(input: &BaseUrlInput<'_>) -> Resolved<String> {
    if let Some(url) = input.base_url_override.filter(|s| !s.is_empty()) {
        return Resolved {
            value: normalize_base_url_string(url),
            source: ValueSource::Flag,
        };
    }
    if let Some(env) = input.environment_override {
        return Resolved {
            value: env.base_url().to_string(),
            source: ValueSource::Flag,
        };
    }
    if let Some(url) = input.profile_base_url.filter(|s| !s.is_empty()) {
        return Resolved {
            value: normalize_base_url_string(url),
            source: ValueSource::Profile,
        };
    }
    if let Some(env) = input.config_environment {
        return Resolved {
            value: env.base_url().to_string(),
            source: ValueSource::Config,
        };
    }
    Resolved {
        value: Environment::default().base_url().to_string(),
        source: ValueSource::BuiltInDefault,
    }
}

fn normalize_base_url_string(raw: &str) -> String {
    parse_api_base_url(raw)
        .map(|u| u.to_string())
        .unwrap_or_else(|_| raw.trim().trim_end_matches('/').to_string())
}

#[derive(Debug, Clone, Copy, Default)]
pub struct CoreImageInput<'a> {
    pub image_override: Option<&'a str>,
    pub config_core_image: Option<&'a str>,
}

pub fn resolve_core_image(input: &CoreImageInput<'_>) -> Resolved<String> {
    if let Some(image) = input.image_override.filter(|s| !s.is_empty()) {
        return Resolved {
            value: image.to_string(),
            source: ValueSource::Flag,
        };
    }
    if let Some(image) = input.config_core_image.filter(|s| !s.is_empty()) {
        return Resolved {
            value: image.to_string(),
            source: ValueSource::Config,
        };
    }
    Resolved {
        value: Environment::default().core_image().to_string(),
        source: ValueSource::BuiltInDefault,
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct EffectiveEnvironmentInput<'a> {
    pub environment_override: Option<Environment>,
    pub base_url_override: Option<&'a str>,
    pub profile_base_url: Option<&'a str>,
    pub config_environment: Option<Environment>,
}

pub fn resolve_effective_environment(
    input: &EffectiveEnvironmentInput<'_>,
) -> Resolved<Environment> {
    if let Some(env) = input.environment_override {
        return Resolved {
            value: env,
            source: ValueSource::Flag,
        };
    }
    if input.base_url_override.is_some() || input.profile_base_url.is_some() {
        return Resolved {
            value: Environment::Prod,
            source: if input.base_url_override.is_some() {
                ValueSource::Flag
            } else {
                ValueSource::Profile
            },
        };
    }
    if let Some(env) = input.config_environment {
        return Resolved {
            value: env,
            source: ValueSource::Config,
        };
    }
    Resolved {
        value: Environment::default(),
        source: ValueSource::BuiltInDefault,
    }
}

/// True when the image ref names a remote registry (needs `docker run --pull`).
pub fn image_has_registry(image: &str) -> bool {
    let image = image.split('@').next().unwrap_or(image);
    match image.split_once('/') {
        Some((host, _)) => host.contains('.') || host.contains(':') || host == "localhost",
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn environment_table_values() {
        assert_eq!(Environment::Prod.base_url(), Environment::PROD_BASE_URL);
        assert_eq!(Environment::Prod.core_image(), Environment::PROD_CORE_IMAGE);
        assert_eq!(Environment::PROD_OAUTH_CLIENT_ID, "FCJpVFZsULYPj8sa");
    }

    #[test]
    fn is_production_api_url_accepts_canonical_host() {
        assert!(is_production_api_url("https://api.atomicstrata.ai"));
        assert!(is_production_api_url("HTTPS://API.ATOMICSTRATA.AI/"));
    }

    #[test]
    fn is_production_api_url_rejects_custom_hosts() {
        assert!(!is_production_api_url("https://api.staging.example.com"));
        assert!(!is_production_api_url("http://127.0.0.1:8080"));
    }

    #[test]
    fn is_production_api_url_requires_https() {
        // Cleartext to the production host would expose the bearer token.
        assert!(!is_production_api_url("http://api.atomicstrata.ai"));
        assert!(!is_production_api_url("HTTP://API.ATOMICSTRATA.AI/"));
    }

    #[test]
    fn is_production_api_url_requires_the_default_port() {
        assert!(!is_production_api_url("https://api.atomicstrata.ai:8443"));
        // An explicit :443 is still the canonical origin.
        assert!(is_production_api_url("https://api.atomicstrata.ai:443"));
    }

    #[test]
    fn is_production_api_url_rejects_lookalike_hosts() {
        assert!(!is_production_api_url("https://api.prod.attacker.example"));
        assert!(!is_production_api_url(
            "https://api.atomicstrata.ai.attacker.example"
        ));
        assert!(!is_production_api_url(
            "https://api.prod.atomicstrata.ai.evil.test"
        ));
        assert!(!is_production_api_url(
            "https://api.atomicstrata.ai@evil.test"
        ));
    }

    #[test]
    fn dashboard_project_url_prod_only() {
        let prod = dashboard_project_url("https://api.atomicstrata.ai", "proj_1").unwrap();
        assert!(prod.contains("memory.atomicstrata.ai"));
        assert!(prod.contains("/app/projects/proj_1/overview"));

        assert!(dashboard_project_url("https://api.staging.example.com", "proj_1").is_none());
    }

    #[test]
    fn parse_api_base_url_normalizes_trailing_slash() {
        let url = parse_api_base_url("https://api.atomicstrata.ai").unwrap();
        assert!(url.path().ends_with('/'));
    }

    #[test]
    fn resolve_base_url_precedence() {
        let input = BaseUrlInput {
            base_url_override: Some("https://custom.example.com"),
            environment_override: Some(Environment::Prod),
            profile_base_url: Some("https://profile.example.com"),
            config_environment: Some(Environment::Prod),
        };
        assert_eq!(
            resolve_base_url(&input).value,
            "https://custom.example.com/"
        );

        let input = BaseUrlInput {
            base_url_override: None,
            environment_override: Some(Environment::Prod),
            profile_base_url: Some("https://profile.example.com"),
            config_environment: None,
        };
        assert_eq!(resolve_base_url(&input).value, Environment::PROD_BASE_URL);

        let input = BaseUrlInput::default();
        assert_eq!(resolve_base_url(&input).value, Environment::PROD_BASE_URL);
    }

    #[test]
    fn resolve_core_image_uses_prod_default() {
        let input = CoreImageInput {
            image_override: None,
            config_core_image: None,
        };
        assert_eq!(
            resolve_core_image(&input).value,
            Environment::PROD_CORE_IMAGE
        );
    }

    #[test]
    fn image_has_registry_detects_ghcr() {
        assert!(image_has_registry(
            "ghcr.io/atomicstrata/atomicmemory-core:latest"
        ));
        assert!(!image_has_registry("atomicmemory-core:local-runtime-test"));
    }

    #[test]
    fn cloud_tier_from_api_url_matches_host() {
        assert_eq!(
            cloud_tier_from_api_url("https://api.atomicstrata.ai"),
            "production"
        );
        assert_eq!(
            cloud_tier_from_api_url("https://custom.example.com"),
            "custom"
        );
    }
}
