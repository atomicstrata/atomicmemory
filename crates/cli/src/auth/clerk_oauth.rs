//! Resolve the public Clerk OAuth client_id baked into shipped CLI builds.

use anyhow::{Result, bail};

use crate::config::ConfigFile;
use crate::environment::{Environment, is_first_party_cloud_api_url, is_production_api_url};

/// Accept a stored/env OAuth value only if it is not the shipped production
/// credential.
///
/// Reaching this point means the base URL is NOT a first-party Cloud origin, so
/// the production issuer/client_id must never be used: an older CLI seeded them
/// into `config.toml`, and reading them back would hand the production identity
/// to an arbitrary `--base-url` — the bearer token is then attached to that
/// origin. Fail closed instead and require explicit configuration.
fn usable_for_custom_origin(value: Option<String>, shipped_production: &str) -> Option<String> {
    value.filter(|v| !v.is_empty() && v != shipped_production)
}

/// Public OAuth `client_id` for end-user login (PKCE). Never uses `CLERK_SECRET_KEY`.
///
/// First-party API URL (prod / Dev / staging): CLI `--client-id` → baked preset → …
/// Custom API URL: `--client-id` → config → env (fail closed — never use prod OAuth).
pub fn resolve_public_client_id(
    config: &ConfigFile,
    flag_override: Option<String>,
    base_url: &str,
) -> Result<String> {
    if let Some(id) = flag_override {
        return Ok(id);
    }
    if is_first_party_cloud_api_url(base_url) {
        return Ok(Environment::PROD_OAUTH_CLIENT_ID.to_string());
    }
    if let Some(id) = usable_for_custom_origin(
        config.oauth.client_id.clone(),
        Environment::PROD_OAUTH_CLIENT_ID,
    ) {
        return Ok(id);
    }
    if let Some(id) = usable_for_custom_origin(
        std::env::var("ATOMICMEMORY_OAUTH_CLIENT_ID").ok(),
        Environment::PROD_OAUTH_CLIENT_ID,
    ) {
        return Ok(id);
    }

    if is_production_api_url(base_url) {
        bail!(
            "browser login is not configured in this CLI build yet.\n\
             \n\
             Preferred on remote/headless hosts (refreshable):\n\
               am auth login --device\n\
             \n\
             Short paste session from the web console:\n\
               am auth login --token <your-session-jwt>\n\
             \n\
             Or run `am auth doctor` to diagnose OAuth configuration."
        );
    }

    bail!(
        "custom Cloud API URL requires explicit OAuth configuration.\n\
         \n\
         Set issuer and client_id in config.toml, or run:\n\
           am auth login --issuer <clerk-issuer> --client-id <public-client-id>\n\
         \n\
         Or use device login on remote hosts:\n\
           am auth login --device\n\
         Or sign in via the web console (short paste, no refresh):\n\
           am auth login --token <your-session-jwt>"
    )
}

/// Resolve the OAuth issuer for a Cloud API base URL.
///
/// First-party API URL (prod / Dev / staging): CLI `--issuer` → baked preset.
/// Custom API URL: `--issuer` → env → config (fail closed).
///
/// The production issuer and client_id are shipped as ONE pair. Consulting a
/// stored `oauth.issuer` before the preset lets a custom profile's leftover
/// issuer be paired with the shipped production client_id, which the identity
/// provider rejects. This mirrors `resolve_public_client_id` above, so both
/// halves of the pair are resolved by the same rule.
fn resolve_issuer(
    config: &ConfigFile,
    flag_override: Option<String>,
    base_url: &str,
) -> Result<String> {
    if let Some(issuer) = flag_override.filter(|s| !s.is_empty()) {
        return Ok(issuer);
    }
    if is_first_party_cloud_api_url(base_url) {
        return Ok(Environment::PROD_OAUTH_ISSUER.to_string());
    }
    if let Some(issuer) = usable_for_custom_origin(
        std::env::var("ATOMICMEMORY_OAUTH_ISSUER").ok(),
        Environment::PROD_OAUTH_ISSUER,
    ) {
        return Ok(issuer);
    }
    if let Some(issuer) =
        usable_for_custom_origin(config.oauth.issuer.clone(), Environment::PROD_OAUTH_ISSUER)
    {
        return Ok(issuer);
    }
    bail!(
        "custom Cloud API URL requires explicit OAuth issuer.\n\
         Set oauth.issuer in config.toml or pass --issuer to auth login."
    )
}

/// Resolve OAuth issuer + client_id for a Cloud API base URL.
pub fn resolve_oauth_pair(
    config: &ConfigFile,
    base_url: &str,
    client_flag: Option<String>,
    issuer_flag: Option<String>,
) -> Result<(String, String)> {
    let client_id = resolve_public_client_id(config, client_flag, base_url)?;
    let issuer = resolve_issuer(config, issuer_flag, base_url)?;
    Ok((issuer, client_id))
}

/// Refuse blank `--issuer` / `--client-id` overrides before any login work.
///
/// Both login paths persist overrides into the global `[oauth]` table. A blank
/// value is not "no override": persisted, it replaces a working pair for every
/// profile and every later command. Omitting the flag is the way to use the
/// configured pair.
pub fn reject_blank_oauth_overrides(issuer: Option<&str>, client_id: Option<&str>) -> Result<()> {
    for (flag, value) in [("--issuer", issuer), ("--client-id", client_id)] {
        if value.is_some_and(|value| value.trim().is_empty()) {
            bail!("{flag} must not be blank; omit it to use the configured OAuth pair");
        }
    }
    Ok(())
}

pub fn invalid_client_help() -> &'static str {
    "The OAuth client_id in this CLI build is not accepted by Clerk (invalid_client).\n\
     Run `am auth doctor` to diagnose (checks env overrides and Clerk registration).\n\
     Remote/headless: am auth login --device\n\
     Short paste: am auth login --token <dashboard-jwt>"
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::ConfigFile;
    use crate::environment::Environment;

    #[test]
    fn prod_preset_wins_over_stale_config_and_env() {
        let config = ConfigFile {
            oauth: crate::config::OAuthDefaults {
                client_id: Some("stale-client".into()),
                ..Default::default()
            },
            ..Default::default()
        };
        let id = resolve_public_client_id(&config, None, Environment::PROD_BASE_URL).unwrap();
        assert_eq!(id, Environment::PROD_OAUTH_CLIENT_ID);
    }

    #[test]
    fn explicit_flag_overrides_prod_preset() {
        let config = ConfigFile::default();
        let id = resolve_public_client_id(
            &config,
            Some("custom-client".into()),
            Environment::PROD_BASE_URL,
        )
        .unwrap();
        assert_eq!(id, "custom-client");
    }

    #[test]
    fn custom_url_uses_config_not_prod_preset() {
        let config = ConfigFile {
            oauth: crate::config::OAuthDefaults {
                client_id: Some("staging-client".into()),
                ..Default::default()
            },
            ..Default::default()
        };
        let id =
            resolve_public_client_id(&config, None, "https://api.staging.example.com").unwrap();
        assert_eq!(id, "staging-client");
    }

    #[test]
    fn prod_issuer_and_client_stay_a_matched_pair() {
        // A leftover issuer from a custom profile must not be paired with the
        // shipped production client_id.
        let config = ConfigFile {
            oauth: crate::config::OAuthDefaults {
                issuer: Some("https://clerk.custom.example".into()),
                client_id: Some("stale-client".into()),
            },
            ..Default::default()
        };
        let (issuer, client_id) =
            resolve_oauth_pair(&config, Environment::PROD_BASE_URL, None, None).unwrap();
        assert_eq!(issuer, Environment::PROD_OAUTH_ISSUER);
        assert_eq!(client_id, Environment::PROD_OAUTH_CLIENT_ID);
    }

    #[test]
    fn explicit_issuer_flag_overrides_prod_preset() {
        let config = ConfigFile::default();
        let (issuer, _) = resolve_oauth_pair(
            &config,
            Environment::PROD_BASE_URL,
            None,
            Some("https://clerk.override.example".into()),
        )
        .unwrap();
        assert_eq!(issuer, "https://clerk.override.example");
    }

    #[test]
    fn custom_url_still_uses_configured_issuer() {
        let config = ConfigFile {
            oauth: crate::config::OAuthDefaults {
                issuer: Some("https://clerk.custom.example".into()),
                client_id: Some("staging-client".into()),
            },
            ..Default::default()
        };
        let (issuer, client_id) =
            resolve_oauth_pair(&config, "https://api.staging.example.com", None, None).unwrap();
        assert_eq!(issuer, "https://clerk.custom.example");
        assert_eq!(client_id, "staging-client");
    }

    #[test]
    fn blank_oauth_overrides_are_refused_and_omitted_ones_allowed() {
        for (issuer, client_id, flag) in [
            (Some(""), None, "--issuer"),
            (Some("  "), None, "--issuer"),
            (None, Some(""), "--client-id"),
            (None, Some(" \t"), "--client-id"),
        ] {
            let err = reject_blank_oauth_overrides(issuer, client_id)
                .expect_err("blank override must be refused")
                .to_string();
            assert!(err.contains(&format!("{flag} must not be blank")), "{err}");
        }
        reject_blank_oauth_overrides(None, None).unwrap();
        reject_blank_oauth_overrides(Some("https://clerk.example"), Some("client")).unwrap();
    }

    #[test]
    fn first_party_dev_url_uses_shipped_oauth_pair_without_config() {
        // ATO-2321: api.dev is first-party; whoami/doctor must not demand a
        // non-production issuer in config.toml (prod issuer there was filtered).
        let config = ConfigFile::default();
        let (issuer, client_id) =
            resolve_oauth_pair(&config, "https://api.dev.atomicstrata.ai", None, None).unwrap();
        assert_eq!(issuer, Environment::PROD_OAUTH_ISSUER);
        assert_eq!(client_id, Environment::PROD_OAUTH_CLIENT_ID);
    }

    #[test]
    fn first_party_dev_url_ignores_stale_custom_config_pair() {
        let config = ConfigFile {
            oauth: crate::config::OAuthDefaults {
                issuer: Some("https://clerk.custom.example".into()),
                client_id: Some("stale-client".into()),
            },
            ..Default::default()
        };
        let (issuer, client_id) =
            resolve_oauth_pair(&config, "https://api.dev.atomicstrata.ai/", None, None).unwrap();
        assert_eq!(issuer, Environment::PROD_OAUTH_ISSUER);
        assert_eq!(client_id, Environment::PROD_OAUTH_CLIENT_ID);
    }

    #[test]
    fn custom_origin_refuses_the_shipped_production_pair_from_config() {
        // `default_config()` used to seed config.toml with the production
        // issuer/client_id, so a custom --base-url read them straight back and
        // was handed the production OAuth identity. Reject them here even when
        // an older config file still carries them.
        let config = ConfigFile {
            oauth: crate::config::OAuthDefaults {
                issuer: Some(Environment::PROD_OAUTH_ISSUER.into()),
                client_id: Some(Environment::PROD_OAUTH_CLIENT_ID.into()),
            },
            ..Default::default()
        };
        for base_url in [
            "http://api.atomicstrata.ai",
            "https://api.staging.example.com",
            "https://api.atomicstrata.ai:8443",
        ] {
            let err = resolve_oauth_pair(&config, base_url, None, None)
                .expect_err("must not use the production OAuth pair for a custom origin")
                .to_string();
            assert!(
                err.contains("custom Cloud API URL"),
                "unexpected error for {base_url}: {err}"
            );
        }
    }

    #[test]
    fn default_config_does_not_seed_the_production_oauth_pair() {
        let cfg = crate::config::default_config_for_test();
        assert!(cfg.oauth.issuer.is_none());
        assert!(cfg.oauth.client_id.is_none());
    }

    #[test]
    fn lookalike_prod_host_fails_closed_without_oauth_config() {
        let config = ConfigFile::default();
        let err = resolve_public_client_id(&config, None, "https://api.prod.attacker.example")
            .unwrap_err()
            .to_string();
        assert!(err.contains("custom Cloud API URL"));
    }
}
