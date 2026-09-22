//! HTTP contract tests for smoke extraction, retrieval, and residue cleanup.

use super::*;
use axum::{
    Json, Router,
    extract::State,
    http::{Method, StatusCode, Uri},
    routing::any,
};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

#[derive(Clone, Default)]
struct Scenario {
    requests: Arc<Mutex<Vec<(Method, String, Value)>>>,
    marker: Arc<Mutex<String>>,
    cleanup_fails: bool,
    /// When true, DELETE returns `{ "deleted": true }` instead of Core's
    /// `{ "success": true }` so both acknowledgment shapes stay covered.
    cleanup_uses_deleted_flag: bool,
    search_fails: bool,
    no_facts: bool,
    duplicate_stored: bool,
    paraphrased: bool,
    search_pending: bool,
    search_started: Arc<tokio::sync::Notify>,
}

async fn handle(
    State(scenario): State<Scenario>,
    method: Method,
    uri: Uri,
    body: Option<Json<Value>>,
) -> (StatusCode, Json<Value>) {
    let body = body.map(|v| v.0).unwrap_or(Value::Null);
    scenario
        .requests
        .lock()
        .unwrap()
        .push((method.clone(), uri.to_string(), body.clone()));
    if uri.path().contains("ingest") {
        *scenario.marker.lock().unwrap() = body["conversation"].as_str().unwrap().into();
        return (
            StatusCode::OK,
            Json(json!({
                "episode_id":"episode", "facts_extracted": if scenario.no_facts {0} else {1},
                "stored_memory_ids": if scenario.duplicate_stored {vec!["stored", "updated", "stored"]} else {vec!["stored"]}, "updated_memory_ids":["updated", "stored"]
            })),
        );
    }
    if method == Method::DELETE {
        return (
            StatusCode::OK,
            // Core's SuccessResponseSchema is `{ "success": true }`. The
            // `deleted` flag exercises the alternate acknowledgment path.
            Json(if scenario.cleanup_fails {
                json!({"deleted": false, "success": false})
            } else if scenario.cleanup_uses_deleted_flag {
                json!({"deleted": true})
            } else {
                json!({"success": true})
            }),
        );
    }
    if scenario.search_pending {
        scenario.search_started.notify_one();
        std::future::pending::<()>().await;
    }
    if scenario.search_fails {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"search failed"})),
        );
    }
    (
        StatusCode::OK,
        Json(json!({"memories":[{
            "id":"stored", "content": if scenario.paraphrased { "Remember the preferred project codename".into() } else {scenario.marker.lock().unwrap().clone()}
        }]})),
    )
}

async fn run(scenario: Scenario, opts: SmokeOptions) -> Result<SmokeResult> {
    run_as(scenario, opts, SMOKE_USER_ID).await
}

async fn run_as(scenario: Scenario, opts: SmokeOptions, user_id: &str) -> Result<SmokeResult> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let router = Router::new().fallback(any(handle)).with_state(scenario);
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let client =
        MemoryClient::new(format!("http://{addr}").parse().unwrap(), "local-admin").unwrap();
    let result = run_memory_smoke_with_client(client, opts, None, user_id).await;
    server.abort();
    result
}

#[tokio::test]
async fn cleanup_includes_stored_and_updated_ids_without_duplicates() {
    let scenario = Scenario::default();
    let result = run(scenario, SmokeOptions::default()).await.unwrap();
    assert_eq!(result.memory_ids_cleaned, ["stored", "updated"]);
}

#[tokio::test]
async fn cleanup_rejection_fails_verification() {
    let scenario = Scenario {
        cleanup_fails: true,
        ..Scenario::default()
    };
    let result = run(scenario.clone(), SmokeOptions::default()).await;
    assert!(
        result.is_err(),
        "failed cleanup must not yield verified=true"
    );
    assert_eq!(
        scenario
            .requests
            .lock()
            .unwrap()
            .iter()
            .filter(|(m, _, _)| *m == Method::DELETE)
            .count(),
        2
    );
}

#[tokio::test]
async fn cleanup_accepts_core_success_response_shape() {
    // Regression: Core returns `{ "success": true }` while the CLI type only
    // looked at `deleted`, so Connected Local smoke always reported
    // "deletion was not confirmed" after a successful DELETE.
    let scenario = Scenario::default();
    let result = run(scenario, SmokeOptions::default()).await.unwrap();
    assert!(result.verified);
    assert_eq!(result.memory_ids_cleaned, ["stored", "updated"]);
}

#[tokio::test]
async fn cleanup_accepts_deleted_true_acknowledgment() {
    let scenario = Scenario {
        cleanup_uses_deleted_flag: true,
        ..Scenario::default()
    };
    let result = run(scenario, SmokeOptions::default()).await.unwrap();
    assert!(result.verified);
    assert_eq!(result.memory_ids_cleaned, ["stored", "updated"]);
}

#[tokio::test]
async fn retrieval_failure_still_cleans_all_ingested_ids() {
    let scenario = Scenario {
        search_fails: true,
        ..Scenario::default()
    };
    assert!(
        run(scenario.clone(), SmokeOptions::default())
            .await
            .is_err()
    );
    assert_eq!(
        scenario
            .requests
            .lock()
            .unwrap()
            .iter()
            .filter(|(m, _, _)| *m == Method::DELETE)
            .count(),
        2
    );
}

fn full_options() -> SmokeOptions {
    SmokeOptions {
        mode: SmokeMode::FullExtraction,
        ..SmokeOptions::default()
    }
}

#[tokio::test]
async fn full_mode_exercises_extraction_before_embedding_retrieval() {
    let scenario = Scenario::default();
    assert!(
        run(scenario.clone(), full_options())
            .await
            .unwrap()
            .verified
    );
    let requests = scenario.requests.lock().unwrap();
    assert_eq!(requests[0].1, "/v1/memories/ingest");
    assert_eq!(requests[0].2["skip_extraction"], false);
    assert!(requests[0].2.get("content_class").is_none());
    assert_eq!(requests[1].1, "/v1/memories/search/fast");
    assert_eq!(requests[0].2["user_id"], "am-cli-smoke");
}

#[tokio::test]
async fn full_mode_rejects_zero_extracted_facts_and_cleans_residue() {
    let scenario = Scenario {
        no_facts: true,
        ..Scenario::default()
    };
    let result = run(scenario.clone(), full_options()).await;
    assert!(
        result.is_err(),
        "successful HTTP response alone must not prove extraction"
    );
    assert_eq!(
        scenario
            .requests
            .lock()
            .unwrap()
            .iter()
            .filter(|(m, _, _)| *m == Method::DELETE)
            .count(),
        2
    );
}

#[tokio::test]
async fn nonadjacent_stored_duplicates_are_cleaned_only_once() {
    let scenario = Scenario {
        duplicate_stored: true,
        ..Scenario::default()
    };
    let result = run(scenario, SmokeOptions::default()).await.unwrap();
    assert_eq!(result.memory_ids_cleaned, ["stored", "updated"]);
}

#[tokio::test]
async fn extraction_can_paraphrase_without_losing_retrieval_identity() {
    let scenario = Scenario {
        paraphrased: true,
        ..Scenario::default()
    };
    let result = run(scenario, full_options()).await.unwrap();
    assert!(result.verified);
    assert_eq!(result.mode, SmokeMode::FullExtraction);
    assert_eq!(result.facts_extracted, 1);
}

#[tokio::test]
async fn combined_search_and_cleanup_failures_preserve_both_reasons() {
    let scenario = Scenario {
        search_fails: true,
        cleanup_fails: true,
        ..Scenario::default()
    };
    let error = run(scenario, full_options()).await.unwrap_err().to_string();
    assert!(error.contains("search failed"));
    assert!(error.contains("cleanup failed"));
}

#[tokio::test]
async fn search_timeout_reserves_time_to_clean_known_memories() {
    let scenario = Scenario {
        search_pending: true,
        ..Scenario::default()
    };
    let opts = SmokeOptions {
        timeout: Duration::from_secs(4),
        ..full_options()
    };
    let mut smoke = tokio::spawn(run(scenario.clone(), opts));
    tokio::select! {
        () = scenario.search_started.notified() => {},
        result = &mut smoke => panic!("smoke ended before search: {result:?}"),
    }
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(3)).await;
    tokio::time::resume();
    let error = smoke.await.unwrap().unwrap_err().to_string();
    assert!(error.contains("search timed out"));
    assert!(!error.contains("cleanup failed"));
    assert_eq!(
        scenario
            .requests
            .lock()
            .unwrap()
            .iter()
            .filter(|(m, _, _)| *m == Method::DELETE)
            .count(),
        2
    );
}

/// A Connected Local JWT is minted for the Clerk `sub`; Core rejects every
/// request whose `user_id` differs from it. Once the client is JWT-bound, the
/// smoke ingest, search, and cleanup must all carry that identity rather than
/// the dedicated smoke namespace.
#[tokio::test]
async fn jwt_bound_user_replaces_smoke_namespace_on_every_request() {
    let scenario = Scenario::default();
    let requests = scenario.requests.clone();
    run_as(scenario, SmokeOptions::default(), "user_member")
        .await
        .unwrap();
    let requests = requests.lock().unwrap();
    assert!(
        requests.len() >= 3,
        "expected ingest, search, and delete requests"
    );
    for (method, uri, body) in requests.iter() {
        let user = if *method == Method::DELETE {
            uri.split('?')
                .nth(1)
                .and_then(|q| q.split('&').find_map(|kv| kv.strip_prefix("user_id=")))
                .map(str::to_string)
        } else {
            body["user_id"].as_str().map(str::to_string)
        };
        assert_eq!(
            user.as_deref(),
            Some("user_member"),
            "{method} {uri} {body}"
        );
    }
}

#[tokio::test]
async fn key_based_smoke_keeps_dedicated_namespace() {
    let scenario = Scenario::default();
    let requests = scenario.requests.clone();
    run(scenario, SmokeOptions::default()).await.unwrap();
    let ingest = requests
        .lock()
        .unwrap()
        .iter()
        .find(|(_, uri, _)| uri.contains("ingest"))
        .map(|(_, _, body)| body.clone())
        .expect("ingest request");
    assert_eq!(ingest["user_id"], SMOKE_USER_ID);
}
