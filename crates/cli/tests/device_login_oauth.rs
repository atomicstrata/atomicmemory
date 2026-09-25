//! Device login must leave a session that later commands can authorize.

#![cfg(unix)]

#[path = "support/local_token.rs"]
mod support;

use std::path::Path;
use support::{Fixture, MEMBER};

fn binary() -> &'static Path {
    Path::new(env!("CARGO_BIN_EXE_am"))
}

fn stderr(output: &std::process::Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

/// A custom Cloud origin with no OAuth pair in configuration.
async fn custom_origin_without_oauth_pair() -> Fixture {
    let fixture = Fixture::new().await;
    fixture.edit("config.toml", |value| {
        value.as_table_mut().unwrap().remove("oauth");
    });
    fixture.edit("credentials.toml", |value| {
        value.as_table_mut().unwrap().remove("oauth");
    });
    fixture
}

fn device_requests(fixture: &Fixture) -> usize {
    fixture
        .requests()
        .iter()
        .filter(|r| r.path.starts_with("/api/oauth/device/"))
        .count()
}

fn stored_session(fixture: &Fixture, profile: &str) -> Option<toml::Value> {
    let text = std::fs::read_to_string(fixture.config.join("credentials.toml")).unwrap();
    let value: toml::Value = text.parse().unwrap();
    value.get("oauth")?.get(profile).cloned()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn blank_oauth_overrides_are_rejected_without_changing_credentials() {
    for route in ["--device", "--no-browser"] {
        for flag in ["--issuer", "--client-id"] {
            for value in ["", "   "] {
                let fixture = Fixture::new().await;
                let config_before = std::fs::read(fixture.config.join("config.toml")).unwrap();
                let credentials_before =
                    std::fs::read(fixture.config.join("credentials.toml")).unwrap();
                let login = fixture.run(
                    binary(),
                    &["auth", "login", route, flag, value, "--skip-project-select"],
                    None,
                );
                assert!(
                    !login.status.success(),
                    "{route} {flag} {value:?} must fail"
                );
                assert!(
                    stderr(&login).contains(&format!("{flag} must not be blank")),
                    "{}",
                    stderr(&login)
                );
                assert_eq!(device_requests(&fixture), 0);
                assert_eq!(
                    std::fs::read(fixture.config.join("config.toml")).unwrap(),
                    config_before
                );
                assert_eq!(
                    std::fs::read(fixture.config.join("credentials.toml")).unwrap(),
                    credentials_before
                );
                let whoami = fixture.run(binary(), &["auth", "whoami"], None);
                assert!(whoami.status.success(), "{}", stderr(&whoami));
            }
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn device_login_overrides_keep_the_session_usable_afterwards() {
    let fixture = custom_origin_without_oauth_pair().await;
    let base = fixture.base.clone();
    let login = fixture.run(
        binary(),
        &[
            "auth",
            "login",
            "--device",
            "--issuer",
            &base,
            "--client-id",
            "fixture_client",
            "--skip-project-select",
        ],
        None,
    );
    assert!(login.status.success(), "{}", stderr(&login));

    let config: toml::Value = std::fs::read_to_string(fixture.config.join("config.toml"))
        .unwrap()
        .parse()
        .unwrap();
    assert_eq!(config["oauth"]["issuer"].as_str(), Some(base.as_str()));
    assert_eq!(
        config["oauth"]["client_id"].as_str(),
        Some("fixture_client")
    );

    // A later command resolves the OAuth pair from configuration, not the
    // login command line. Before the fix this failed on a custom origin.
    let whoami = fixture.run(binary(), &["auth", "whoami"], None);
    assert!(whoami.status.success(), "{}", stderr(&whoami));
    assert!(
        String::from_utf8_lossy(&whoami.stdout).contains(MEMBER),
        "{}",
        String::from_utf8_lossy(&whoami.stdout)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn device_login_without_a_resolvable_oauth_pair_fails_before_the_flow() {
    let fixture = custom_origin_without_oauth_pair().await;
    let login = fixture.run(
        binary(),
        &["auth", "login", "--device", "--skip-project-select"],
        None,
    );
    assert!(!login.status.success(), "must fail without an OAuth pair");
    assert!(
        stderr(&login).contains("requires explicit OAuth configuration"),
        "must fail on the missing pair, not something else: {}",
        stderr(&login)
    );
    assert_eq!(
        device_requests(&fixture),
        0,
        "no device flow may start: {:?}",
        fixture.requests()
    );
    assert!(stored_session(&fixture, "local").is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn device_login_refuses_a_session_from_another_issuer() {
    let fixture = custom_origin_without_oauth_pair().await;
    fixture.api.lock().unwrap().device_iss = Some("https://other-issuer.example".into());
    let base = fixture.base.clone();
    let login = fixture.run(
        binary(),
        &[
            "auth",
            "login",
            "--device",
            "--issuer",
            &base,
            "--client-id",
            "fixture_client",
            "--skip-project-select",
        ],
        None,
    );
    assert!(
        !login.status.success(),
        "foreign-issuer session must be refused"
    );
    assert!(
        stderr(&login).contains("refusing to store"),
        "{}",
        stderr(&login)
    );
    assert!(stored_session(&fixture, "local").is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn device_login_refuses_an_issuer_override_the_environment_would_shadow() {
    // ATOMICMEMORY_OAUTH_ISSUER outranks configuration, so a persisted
    // --issuer would never be used; the resulting session could not be
    // authorized by any later command.
    let fixture = custom_origin_without_oauth_pair().await;
    let base = fixture.base.clone();
    let login = fixture.run_with_envs(
        binary(),
        &[
            "auth",
            "login",
            "--device",
            "--issuer",
            &base,
            "--client-id",
            "fixture_client",
            "--skip-project-select",
        ],
        None,
        &[("ATOMICMEMORY_OAUTH_ISSUER", "https://env-issuer.example")],
    );
    assert!(
        !login.status.success(),
        "a shadowed --issuer must be refused"
    );
    assert!(
        stderr(&login).contains("would not be used after login"),
        "{}",
        stderr(&login)
    );
    assert_eq!(
        device_requests(&fixture),
        0,
        "must fail before the device flow: {:?}",
        fixture.requests()
    );
    assert!(stored_session(&fixture, "local").is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn blank_oauth_overrides_are_rejected_for_browser_login_too() {
    // Browser login persists overrides into the same global [oauth] table
    // before opening the browser, so it must refuse blank ones first.
    for flag in ["--issuer", "--client-id"] {
        for value in ["", "   "] {
            let fixture = Fixture::new().await;
            let config_before = std::fs::read(fixture.config.join("config.toml")).unwrap();
            let credentials_before =
                std::fs::read(fixture.config.join("credentials.toml")).unwrap();
            let login = fixture.run(
                binary(),
                &["auth", "login", flag, value, "--skip-project-select"],
                None,
            );
            assert!(
                !login.status.success(),
                "browser {flag} {value:?} must fail"
            );
            assert!(
                stderr(&login).contains(&format!("{flag} must not be blank")),
                "{}",
                stderr(&login)
            );
            assert!(fixture.requests().is_empty(), "{:?}", fixture.requests());
            assert_eq!(
                std::fs::read(fixture.config.join("config.toml")).unwrap(),
                config_before
            );
            assert_eq!(
                std::fs::read(fixture.config.join("credentials.toml")).unwrap(),
                credentials_before
            );
            let whoami = fixture.run(binary(), &["auth", "whoami"], None);
            assert!(whoami.status.success(), "{}", stderr(&whoami));
        }
    }
}
