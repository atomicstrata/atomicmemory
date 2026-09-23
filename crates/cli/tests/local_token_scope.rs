//! Public memory and hook commands must carry the identity used by local JWT minting.

#![cfg(unix)]

#[path = "support/local_token.rs"]
mod support;

use std::path::Path;
use support::{CORE_KEY, Fixture, MEMBER};

fn binary() -> &'static Path {
    Path::new(env!("CARGO_BIN_EXE_am"))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_memory_and_hook_surface_sends_the_minted_user() {
    let fixture = Fixture::new().await;
    let cases: &[(&[&str], Option<&str>)] = &[
        (&["memory", "ingest", "fixture memory"], None),
        (
            &["memory", "ingest", "--mode", "verbatim", "fixture memory"],
            None,
        ),
        (&["memory", "search", "fixture"], None),
        (&["memory", "search", "--fast", "fixture"], None),
        (&["memory", "list"], None),
        (&["memory", "get", "mem_test"], None),
        (&["memory", "delete", "mem_test"], None),
        (&["memory", "package", "fixture"], None),
        (
            &[
                "hooks",
                "run",
                "user-prompt-submit",
                "--host",
                "claude-code",
            ],
            Some(r#"{"prompt":"remember the fixture architecture decisions"}"#),
        ),
        (
            &["hooks", "run", "post-compact", "--host", "claude-code"],
            Some(r#"{"summary":"The project uses a local memory service for context."}"#),
        ),
        (
            &["hooks", "run", "stop", "--host", "claude-code"],
            Some(
                r#"{"last_assistant_message":"Implemented the local memory integration and verified that the persisted configuration is reused across subsequent sessions without overwriting unrelated settings. The tests also cover retrieval, identity binding, and cleanup so future changes preserve the same behavior."}"#,
            ),
        ),
    ];
    for (args, input) in cases {
        let before = fixture.requests().len();
        let output = fixture.run(binary(), args, *input);
        assert!(
            output.status.success(),
            "{args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let requests = fixture.requests();
        let calls = &requests[before..];
        assert_eq!(calls.len(), 2, "{args:?}: {calls:?}");
        assert_eq!(calls[0].body["memory_user_id"], MEMBER);
        assert_eq!(calls[1].user.as_deref(), Some(MEMBER));
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn matching_scope_override_is_normalized_on_the_wire() {
    let fixture = Fixture::new().await;
    let output = fixture.run(
        binary(),
        &[
            "--scope-user",
            " user_member ",
            "memory",
            "search",
            "fixture",
        ],
        None,
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        fixture.requests().last().unwrap().user.as_deref(),
        Some(MEMBER)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn conflicting_scope_override_never_reaches_core() {
    let fixture = Fixture::new().await;
    let output = fixture.run(
        binary(),
        &[
            "--scope-user",
            "another_user",
            "memory",
            "search",
            "fixture",
        ],
        None,
    );
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("conflicts"));
    assert!(
        fixture
            .requests()
            .iter()
            .all(|request| request.path == "/v1/local/token")
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unbound_or_foreign_sessions_never_disclose_identity() {
    for binding in [None, Some("https://other.example")] {
        let fixture = Fixture::new().await;
        fixture.edit("credentials.toml", |value| {
            let oauth = value["oauth"]["cloud"].as_table_mut().unwrap();
            oauth.remove("api_origin");
            if let Some(binding) = binding {
                oauth.insert("api_origin".into(), binding.into());
            }
        });
        let output = fixture.run(binary(), &["connect", "token", "--print-token"], None);
        assert!(!output.status.success());
        assert!(
            fixture.requests().is_empty(),
            "identity must not leave the process"
        );
        let error = String::from_utf8_lossy(&output.stderr);
        assert!(
            error.contains("binding") || error.contains("acquired for"),
            "{error}"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn matching_origin_uses_expired_cached_identity_without_refresh() {
    let fixture = Fixture::new().await;
    fixture.edit("credentials.toml", |value| {
        value["oauth"]["cloud"]["expires_at"] = 0.into();
    });
    let output = fixture.run(binary(), &["connect", "token", "--print-token"], None);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(fixture.requests().len(), 1);
    assert_eq!(fixture.requests()[0].path, "/v1/local/token");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn foreign_issuer_is_rejected_even_on_matching_api_origin() {
    let fixture = Fixture::new().await;
    fixture.edit("credentials.toml", |value| {
        value["oauth"]["cloud"]["issuer"] = "https://other-issuer.example".into();
    });
    let output = fixture.run(binary(), &["connect", "token", "--print-token"], None);
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("issued by"));
    assert!(fixture.requests().is_empty());
}

const MANAGED_CORE_KEY: &[(&str, &str)] = &[("CORE_API_KEY", CORE_KEY)];

fn stderr(output: &std::process::Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

/// The single user-scoped Core request (health carries no `user_id`).
fn core_memory_request(fixture: &Fixture) -> support::Request {
    let requests = fixture.requests();
    let core: Vec<_> = requests
        .iter()
        .filter(|r| r.path.starts_with("/v1/memories") && r.path != "/v1/memories/health")
        .cloned()
        .collect();
    assert_eq!(
        core.len(),
        1,
        "expected one user-scoped Core request: {requests:?}"
    );
    core.into_iter().next().unwrap()
}

fn export_args<'a>(out: &'a str, user_id: Option<&'a str>) -> Vec<&'a str> {
    let mut args = vec!["migrate", "export", "--project", "proj_test", "--out", out];
    if let Some(user_id) = user_id {
        args.extend(["--user-id", user_id]);
    }
    args
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn managed_core_key_with_session_binds_clerk_identity() {
    // UTM-2 default: Connected Local session + persisted/env CORE_API_KEY.
    // The session identity is the default namespace even though HTTP auth
    // uses the key and never mints.
    let fixture = Fixture::new().await;
    let output = fixture.run_with_envs(
        binary(),
        &["memory", "search", "fixture"],
        None,
        MANAGED_CORE_KEY,
    );
    assert!(output.status.success(), "{}", stderr(&output));
    assert!(
        fixture
            .requests()
            .iter()
            .all(|r| r.path != "/v1/local/token"),
        "managed key must not mint"
    );
    let search = core_memory_request(&fixture);
    assert_eq!(search.user.as_deref(), Some(MEMBER));
    assert_eq!(search.auth.as_deref(), Some(CORE_KEY));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn managed_core_key_with_session_allows_explicit_scope_user_override() {
    // Core applies no user binding under a static key, so an explicit
    // --scope-user must reach Core. `default` is the namespace every
    // pre-binding install wrote to on this path.
    let fixture = Fixture::new().await;
    let output = fixture.run_with_envs(
        binary(),
        &["--scope-user", "default", "memory", "search", "fixture"],
        None,
        MANAGED_CORE_KEY,
    );
    assert!(output.status.success(), "{}", stderr(&output));
    assert!(
        !stderr(&output).contains("conflicts"),
        "{}",
        stderr(&output)
    );
    let search = core_memory_request(&fixture);
    assert_eq!(search.user.as_deref(), Some("default"));
    assert_eq!(search.auth.as_deref(), Some(CORE_KEY));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn managed_core_key_without_session_allows_explicit_scope_user() {
    // Pure Core-key admin (no Connected Local session) may target any namespace.
    let fixture = Fixture::new().await;
    fixture.edit("credentials.toml", |value| {
        value.as_table_mut().unwrap().remove("oauth");
    });
    fixture.edit("config.toml", |value| {
        value["profiles"]["local"]
            .as_table_mut()
            .unwrap()
            .remove("oauth_ref");
    });
    let output = fixture.run_with_envs(
        binary(),
        &["--scope-user", "team_a", "memory", "search", "fixture"],
        None,
        MANAGED_CORE_KEY,
    );
    assert!(output.status.success(), "{}", stderr(&output));
    assert_eq!(
        core_memory_request(&fixture).user.as_deref(),
        Some("team_a")
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unauthorizable_session_with_managed_key_falls_back_unbound_with_warning() {
    // A stale or foreign session must not break a Core the key authenticates.
    let fixture = Fixture::new().await;
    fixture.edit("credentials.toml", |value| {
        value["oauth"]["cloud"]["api_origin"] = "https://other.example".into();
    });
    let output = fixture.run_with_envs(
        binary(),
        &["memory", "search", "fixture"],
        None,
        MANAGED_CORE_KEY,
    );
    assert!(output.status.success(), "{}", stderr(&output));
    let err = stderr(&output);
    assert!(err.contains("could not be authorized"), "{err}");
    assert!(err.contains("`am auth login`"), "{err}");
    let search = core_memory_request(&fixture);
    assert_eq!(search.user.as_deref(), Some("default"), "unbound fallback");
    assert_eq!(search.auth.as_deref(), Some(CORE_KEY));
    assert!(
        fixture
            .requests()
            .iter()
            .all(|r| r.path != "/v1/local/token" && !r.path.contains("oauth")),
        "fallback must not mint or touch OAuth: {:?}",
        fixture.requests()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn managed_core_key_export_defaults_to_session_identity() {
    let fixture = Fixture::new().await;
    let out = fixture.home.path().join("export.jsonl");
    let out = out.to_str().unwrap();
    let output = fixture.run_with_envs(binary(), &export_args(out, None), None, MANAGED_CORE_KEY);
    assert!(output.status.success(), "{}", stderr(&output));
    assert_eq!(core_memory_request(&fixture).user.as_deref(), Some(MEMBER));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn managed_core_key_export_honors_explicit_default_user_id() {
    // Explicit `--user-id default` is distinguishable from omitted, and under
    // a Core key it exports the pre-binding namespace.
    let fixture = Fixture::new().await;
    let out = fixture.home.path().join("export.jsonl");
    let out = out.to_str().unwrap();
    let output = fixture.run_with_envs(
        binary(),
        &export_args(out, Some("default")),
        None,
        MANAGED_CORE_KEY,
    );
    assert!(output.status.success(), "{}", stderr(&output));
    let list = core_memory_request(&fixture);
    assert_eq!(list.user.as_deref(), Some("default"));
    assert_eq!(list.auth.as_deref(), Some(CORE_KEY));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn jwt_export_rejects_explicit_default_user_id() {
    // Under a Cloud-minted JWT, Core would 403 any user_id other than the
    // minted identity, so an explicit `default` must fail before any Core read.
    let fixture = Fixture::new().await;
    let out = fixture.home.path().join("export.jsonl");
    let out = out.to_str().unwrap();
    let output = fixture.run(binary(), &export_args(out, Some("default")), None);
    assert!(
        !output.status.success(),
        "explicit default must fail under JWT"
    );
    let err = stderr(&output);
    assert!(
        err.contains("conflicts with the Connected Local JWT identity"),
        "{err}"
    );
    assert!(
        fixture
            .requests()
            .iter()
            .all(|r| !r.path.starts_with("/v1/memories")),
        "conflict must not reach Core: {:?}",
        fixture.requests()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn health_only_callers_skip_identity_resolution() {
    // `am health` sends no user_id, so it must not warn about an unauthorizable
    // session or resolve identity it never uses.
    let fixture = Fixture::new().await;
    fixture.edit("credentials.toml", |value| {
        value["oauth"]["cloud"]["api_origin"] = "https://other.example".into();
    });
    let output = fixture.run_with_envs(binary(), &["health"], None, MANAGED_CORE_KEY);
    assert!(output.status.success(), "{}", stderr(&output));
    assert!(
        !stderr(&output).contains("could not be authorized"),
        "{}",
        stderr(&output)
    );
    assert!(
        fixture
            .requests()
            .iter()
            .any(|r| r.path == "/v1/memories/health" && r.auth.as_deref() == Some(CORE_KEY)),
        "health must still reach Core with the key: {:?}",
        fixture.requests()
    );
}
