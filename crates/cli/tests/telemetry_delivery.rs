//! Real CLI lifecycle against loopback memory and capture endpoints only.
#![cfg(unix)]
#[path = "support/local_token.rs"]
mod support;

use axum::{Json, Router, extract::State, http::StatusCode, routing::post};
use serde_json::{Value, json};
use std::{
    path::Path,
    sync::{Arc, Mutex},
};
use support::Fixture;

type Captures = Arc<Mutex<(usize, Vec<Value>)>>;
async fn receiver(
    State(state): State<Captures>,
    Json(body): Json<Value>,
) -> (StatusCode, Json<Value>) {
    let mut state = state.lock().unwrap();
    state.1.push(body);
    if state.1.len() <= state.0 {
        (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"status":0})))
    } else {
        (StatusCode::OK, Json(json!({"status":"Ok"})))
    }
}
async fn endpoint(failures: usize) -> (String, Captures, tokio::task::JoinHandle<()>) {
    let state = Arc::new(Mutex::new((failures, Vec::new())));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let app = Router::new()
        .route("/capture/", post(receiver))
        .with_state(state.clone());
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (url, state, task)
}
fn ingest(fixture: &Fixture, host: &str) {
    let output = fixture
        .command(Path::new(env!("CARGO_BIN_EXE_am")))
        .env("AM_TELEMETRY", "1")
        .env("AM_POSTHOG_KEY", "phc_test_only")
        .env("AM_POSTHOG_HOST", host)
        .args([
            "memory",
            "ingest",
            "--mode",
            "verbatim",
            "private fixture content",
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}
fn privacy_state(fixture: &Fixture) -> toml::Value {
    std::fs::read_to_string(fixture.config.join("telemetry-first-memory.toml"))
        .unwrap()
        .parse()
        .unwrap()
}
fn invalid_optout(fixture: &Fixture) {
    let before = std::fs::read(fixture.config.join("config.toml")).unwrap();
    let credentials = std::fs::read(fixture.config.join("credentials.toml")).unwrap();
    let output = fixture.run(
        Path::new(env!("CARGO_BIN_EXE_am")),
        &[
            "auth",
            "login",
            "--device",
            "--issuer",
            "",
            "--skip-project-select",
        ],
        None,
    );
    assert!(!output.status.success());
    assert_eq!(
        std::fs::read(fixture.config.join("config.toml")).unwrap(),
        before
    );
    assert_eq!(
        std::fs::read(fixture.config.join("credentials.toml")).unwrap(),
        credentials
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn first_memory_replays_identical_envelope_after_process_restart() {
    let fixture = Fixture::new().await;
    let (host, captures, task) = endpoint(2).await;
    ingest(&fixture, &host);
    assert_eq!(
        privacy_state(&fixture)["telemetry_first_memory"]["state"].as_str(),
        Some("pending")
    );
    ingest(&fixture, &host);
    assert_eq!(
        privacy_state(&fixture)["telemetry_first_memory"]["state"].as_str(),
        Some("accepted")
    );
    ingest(&fixture, &host);
    let captures = captures.lock().unwrap();
    assert_eq!(captures.1.len(), 3);
    assert!(captures.1.iter().all(|body| body == &captures.1[0]));
    let config: toml::Value = std::fs::read_to_string(fixture.config.join("config.toml"))
        .unwrap()
        .parse()
        .unwrap();
    assert_eq!(
        captures.1[0]["distinct_id"].as_str(),
        config["telemetry_distinct_id"].as_str()
    );
    let text = std::fs::read_to_string(fixture.config.join("telemetry-first-memory.toml")).unwrap();
    for secret in [
        "phc_test_only",
        "private fixture content",
        "amc_fixture",
        "fixture_refresh",
    ] {
        assert!(!text.contains(secret));
    }
    task.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn invalid_optout_revokes_pending_without_mutating_auth_or_replaying() {
    let fixture = Fixture::new().await;
    let (host, captures, task) = endpoint(2).await;
    ingest(&fixture, &host);
    invalid_optout(&fixture);
    assert_eq!(
        privacy_state(&fixture)["telemetry_first_memory"]["state"].as_str(),
        Some("suppressed")
    );
    ingest(&fixture, &host);
    assert_eq!(captures.lock().unwrap().1.len(), 2);
    task.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unrelated_optout_does_not_consume_later_first_ingest() {
    let fixture = Fixture::new().await;
    let (host, captures, task) = endpoint(0).await;
    invalid_optout(&fixture);
    assert!(
        privacy_state(&fixture)
            .get("telemetry_first_memory")
            .is_none()
    );
    ingest(&fixture, &host);
    assert_eq!(captures.lock().unwrap().1.len(), 1);
    assert_eq!(
        privacy_state(&fixture)["telemetry_first_memory"]["state"].as_str(),
        Some("accepted")
    );
    task.abort();
}
