//! Exercise the real stored-key entry point in a process with isolated credentials.

#[path = "../../tests/support/local_token.rs"]
mod support;

use super::{ProvisionOutcome, ensure_connected_local_cloud_api_key_stored};
use crate::cli::GlobalOptions;
use support::Fixture;

const CHILD: &str = "AM_TEST_STORED_KEY_CHILD";

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn identity_lookup_failure_preserves_valid_key() {
    if std::env::var_os(CHILD).is_some() {
        let result = ensure_connected_local_cloud_api_key_stored(
            &GlobalOptions::default(),
            "local",
            "proj_test",
        )
        .await;
        let error = result.expect_err("identity failure must not provision a key");
        assert!(format!("{error:#}").contains("stored key preserved"));
        return;
    }
    let fixture = Fixture::new().await;
    fixture.edit("config.toml", |value| {
        value["profiles"]["local"]
            .as_table_mut()
            .unwrap()
            .remove("oauth_ref");
    });
    fixture.edit("credentials.toml", |value| {
        value["oauth"]["cloud"]["expires_at"] = 0.into();
    });
    fixture.api.lock().unwrap().fail_first_discovery = true;
    let before = std::fs::read(fixture.config.join("credentials.toml")).unwrap();
    let output = fixture
        .command(&std::env::current_exe().unwrap())
        .env(CHILD, "1")
        .args([
            "--exact",
            "commands::cloud_api_key::identity_tests::identity_lookup_failure_preserves_valid_key",
            "--nocapture",
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        fixture.requests().len(),
        1,
        "must not retry auth then rotate an unprobed key"
    );
    assert_eq!(
        fixture.requests()[0].path,
        "/.well-known/oauth-authorization-server"
    );
    assert_eq!(
        before,
        std::fs::read(fixture.config.join("credentials.toml")).unwrap()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn successful_mint_reuses_key_without_mutation() {
    if std::env::var_os(CHILD).is_some() {
        let outcome = ensure_connected_local_cloud_api_key_stored(
            &GlobalOptions::default(),
            "local",
            "proj_test",
        )
        .await
        .unwrap();
        assert_eq!(outcome, ProvisionOutcome::Reused);
        return;
    }
    let fixture = Fixture::new().await;
    let before = std::fs::read(fixture.config.join("credentials.toml")).unwrap();
    let output = fixture
        .command(&std::env::current_exe().unwrap())
        .env(CHILD, "1")
        .args([
            "--exact",
            "commands::cloud_api_key::identity_tests::successful_mint_reuses_key_without_mutation",
            "--nocapture",
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(fixture.requests().len(), 1);
    assert_eq!(fixture.requests()[0].path, "/v1/local/token");
    assert_eq!(
        before,
        std::fs::read(fixture.config.join("credentials.toml")).unwrap()
    );
}
