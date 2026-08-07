//! Origin binding for stored Cloud credentials.
//!
//! Controlling invariant: **a credential minted for one Cloud origin is never
//! transmitted to another.**
//!
//! Credential selection and destination selection are independent inputs —
//! the credential comes from the stored profile, the destination from
//! `--base-url` / `ATOMICMEMORY_API_URL` / the profile — so nothing structural
//! stops a production session token or `amc_` key from being sent to an
//! arbitrary host. Every authenticated Cloud request must therefore pass its
//! credential through the checks here before the request is built.
//!
//! Guarding OAuth *resolution* (which issuer/client to log in with) is not
//! sufficient and was the source of repeated regressions: it governs how a
//! credential is obtained, not where an already-stored credential is sent.

use anyhow::{Result, bail};

use crate::environment::parse_api_base_url;

/// True when two URLs share scheme, host, and effective port.
pub fn same_origin(a: &str, b: &str) -> bool {
    match (parse_api_base_url(a), parse_api_base_url(b)) {
        (Ok(a), Ok(b)) => {
            a.scheme() == b.scheme()
                && a.host_str().map(str::to_ascii_lowercase)
                    == b.host_str().map(str::to_ascii_lowercase)
                && a.port_or_known_default() == b.port_or_known_default()
        }
        _ => false,
    }
}

/// Whether a stored OAuth session may be sent to `target_base_url`.
///
/// `token_api_origin` is the Cloud API origin the session was acquired for,
/// recorded at storage time. This is the binding that matters: the identity
/// issuer is a weaker signal, because two API origins can share one issuer, and
/// the profile's `base_url` is mutable so it cannot stand in for where the
/// credential came from.
///
/// `token_issuer` / `expected_issuer` are still compared as a secondary check
/// so a session from a different identity provider is refused even if the API
/// origins happen to line up.
pub fn check_token_origin(
    token_api_origin: Option<&str>,
    token_issuer: Option<&str>,
    expected_issuer: &str,
    target_base_url: &str,
) -> Result<()> {
    match token_api_origin {
        Some(origin) if same_origin(origin, target_base_url) => {}
        Some(origin) => bail!(
            "stored session was acquired for {origin}, not {target_base_url}.\n\
             Refusing to send it to a different Cloud origin — run `am auth login` \
             against {target_base_url}, or pass `--profile <name>` for the matching one."
        ),
        // A session with no recorded origin fails everywhere. Treating it as
        // production would be an assumption, not a derivation: a legacy
        // credential minted against a custom tier would then be disclosed to
        // production. Re-authentication is the only way to establish the
        // binding the invariant requires.
        None => bail!(
            "stored session predates Cloud-origin binding, so the origin it belongs to \
             is unknown.\n\
             Run `am auth login` against {target_base_url} (or `am auth login --token …`) \
             to re-establish it."
        ),
    }

    match token_issuer {
        Some(issuer) if same_origin(issuer, expected_issuer) => Ok(()),
        Some(issuer) => bail!(
            "stored session was issued by {issuer}, but {target_base_url} expects \
             {expected_issuer}.\n\
             Refusing to send that session to a different identity provider — run \
             `am auth login` for this profile."
        ),
        None => Ok(()),
    }
}

/// Whether a stored `amc_` API key bound to `key_origin` may be sent to
/// `target_base_url`.
///
/// Same failure shape as the session token: the key is selected from the
/// profile while the destination can be overridden per invocation.
pub fn check_api_key_origin(key_origin: &str, target_base_url: &str) -> bool {
    same_origin(key_origin, target_base_url)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::environment::Environment;

    const PROD: &str = Environment::PROD_BASE_URL;
    const PROD_ISSUER: &str = Environment::PROD_OAUTH_ISSUER;
    const CUSTOM_ISSUER: &str = "https://clerk.custom.example";

    #[test]
    fn same_origin_compares_scheme_host_and_port() {
        assert!(same_origin(PROD, "https://api.atomicstrata.ai/"));
        assert!(same_origin(PROD, "HTTPS://API.ATOMICSTRATA.AI"));
        assert!(same_origin(
            "https://api.atomicstrata.ai:443",
            "https://api.atomicstrata.ai"
        ));
        // Path differences do not change the origin.
        assert!(same_origin(PROD, "https://api.atomicstrata.ai/v1/"));

        assert!(!same_origin(PROD, "http://api.atomicstrata.ai"));
        // Scheme must be compared on its own: with both ports written out,
        // a port-only comparison would call these the same origin.
        assert!(!same_origin(
            "https://api.atomicstrata.ai:443",
            "http://api.atomicstrata.ai:443"
        ));
        assert!(!same_origin(PROD, "https://api.atomicstrata.ai:8443"));
        assert!(!same_origin(PROD, "https://api.staging.example.com"));
        assert!(!same_origin(PROD, "https://api.atomicstrata.ai.evil.test"));
    }

    #[test]
    fn session_is_refused_for_every_origin_it_was_not_acquired_for() {
        // Reported leak: a production session sent to a local cleartext
        // listener via --base-url.
        for target in [
            "http://127.0.0.1:38767",
            "http://api.atomicstrata.ai",
            "https://api.atomicstrata.ai:8443",
            "https://api.staging.example.com",
            "https://api.atomicstrata.ai.evil.test",
        ] {
            let err = check_token_origin(Some(PROD), Some(PROD_ISSUER), PROD_ISSUER, target)
                .expect_err("must refuse a session bound to another origin");
            assert!(
                err.to_string().contains("acquired for"),
                "unexpected error for {target}: {err}"
            );
        }
    }

    #[test]
    fn shared_issuer_does_not_authorize_a_different_api_origin() {
        // Two Cloud origins can legitimately share one identity issuer, so
        // matching issuers must NOT be read as permission to reuse a session.
        // Issuer comparison alone missed exactly this case.
        let err = check_token_origin(
            Some("https://api.a.example"),
            Some(CUSTOM_ISSUER),
            CUSTOM_ISSUER,
            "https://api.b.example",
        )
        .expect_err("same issuer must not authorize a different API origin");
        assert!(err.to_string().contains("acquired for"), "{err}");
    }

    #[test]
    fn session_is_allowed_for_the_origin_it_was_acquired_for() {
        assert!(check_token_origin(Some(PROD), Some(PROD_ISSUER), PROD_ISSUER, PROD).is_ok());
        assert!(
            check_token_origin(
                Some("https://api.custom.example"),
                Some(CUSTOM_ISSUER),
                "https://clerk.custom.example/",
                "https://api.custom.example"
            )
            .is_ok()
        );
    }

    #[test]
    fn a_different_identity_provider_is_refused_even_on_a_matching_origin() {
        let err = check_token_origin(
            Some(PROD),
            Some("https://clerk.evil.test"),
            PROD_ISSUER,
            PROD,
        )
        .expect_err("issuer mismatch must still be refused");
        assert!(err.to_string().contains("issued by"), "{err}");
    }

    #[test]
    fn sessions_without_a_recorded_origin_are_refused_everywhere() {
        // Including production: assuming production would disclose a legacy
        // custom-tier session to it.
        for target in [PROD, "https://api.custom.example", "http://127.0.0.1:9999"] {
            let err = check_token_origin(None, Some(PROD_ISSUER), PROD_ISSUER, target)
                .expect_err("legacy session must not be trusted anywhere");
            assert!(
                err.to_string().contains("predates Cloud-origin binding"),
                "unexpected error for {target}: {err}"
            );
        }
    }

    #[test]
    fn api_keys_are_bound_to_their_origin() {
        assert!(check_api_key_origin(PROD, PROD));
        assert!(!check_api_key_origin(PROD, "http://127.0.0.1:38767"));
        assert!(!check_api_key_origin(
            PROD,
            "https://api.staging.example.com"
        ));
    }
}
