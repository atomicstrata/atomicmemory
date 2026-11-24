//! Opt-out CLI activation telemetry (PostHog HTTP capture).

use std::sync::OnceLock;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use serde::Serialize;

mod first_memory;
pub(crate) use first_memory::ConsentGeneration;
pub(crate) use first_memory::begin as begin_first_memory;
use sha2::{Digest, Sha256};

use crate::config::{ensure_config_initialized, update_config};
use crate::validation::recovery::classify_error;

const DEFAULT_POSTHOG_HOST: &str = "https://us.i.posthog.com";

static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
static PENDING_CAPTURES: AtomicUsize = AtomicUsize::new(0);

// Leave room for both attempts and backoff within the existing exit budget.
const REQUEST_TIMEOUT: Duration = Duration::from_millis(900);
const RETRY_DELAY: Duration = Duration::from_millis(100);
const MAX_ATTEMPTS: usize = 2;
const FLUSH_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActivationEvent {
    InitStarted,
    LoginCompleted,
    WorkspaceCreated,
    ProjectLinked,
    CoreStarted,
    HeartbeatReceived,
    FirstIngestCompleted,
    FirstRetrievalCompleted,
    FirstRealMemoryCreated,
    InitStepFailed,
    HostedCloudHandoff,
    HostedCloudConfigured,
}

impl ActivationEvent {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InitStarted => "init_started",
            Self::LoginCompleted => "login_completed",
            Self::WorkspaceCreated => "workspace_created",
            Self::ProjectLinked => "project_linked",
            Self::CoreStarted => "core_started",
            Self::HeartbeatReceived => "heartbeat_received",
            Self::FirstIngestCompleted => "first_ingest_completed",
            Self::FirstRetrievalCompleted => "first_retrieval_completed",
            Self::FirstRealMemoryCreated => "first_real_memory_created",
            Self::InitStepFailed => "init_step_failed",
            Self::HostedCloudHandoff => "hosted_cloud_handoff",
            Self::HostedCloudConfigured => "hosted_cloud_configured",
        }
    }
}

/// Onboarding step identifiers for failure telemetry (no free-text errors).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InitStep {
    Login,
    Workspace,
    ProjectLink,
    Docker,
    CoreStart,
    Heartbeat,
    Smoke,
}

impl InitStep {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Login => "login",
            Self::Workspace => "workspace",
            Self::ProjectLink => "project_link",
            Self::Docker => "docker",
            Self::CoreStart => "core_start",
            Self::Heartbeat => "heartbeat",
            Self::Smoke => "smoke",
        }
    }
}

/// Mutable activation context accumulated during init/connect flows.
#[derive(Debug, Clone, Default)]
pub struct ActivationContext {
    pub org_id: Option<String>,
    pub project_id: Option<String>,
    pub mode: Option<&'static str>,
    pub email_hash: Option<String>,
}

impl ActivationContext {
    pub fn local() -> Self {
        Self {
            mode: Some("local"),
            ..Default::default()
        }
    }

    pub fn cloud() -> Self {
        Self {
            mode: Some("cloud"),
            ..Default::default()
        }
    }

    pub fn props(&self) -> serde_json::Map<String, serde_json::Value> {
        context_props(
            self.org_id.as_deref(),
            self.project_id.as_deref(),
            self.mode,
            self.email_hash.as_deref(),
        )
    }
}

pub fn telemetry_enabled(no_telemetry_flag: bool) -> bool {
    if no_telemetry_flag {
        return false;
    }
    !matches!(
        std::env::var("AM_TELEMETRY").ok().as_deref(),
        Some("0") | Some("false") | Some("off")
    )
}

pub fn base_props(
    extra: Option<serde_json::Map<String, serde_json::Value>>,
) -> serde_json::Map<String, serde_json::Value> {
    let mut props = extra.unwrap_or_default();
    props.insert("source".into(), "am-cli".into());
    props.insert("cli_version".into(), env!("CARGO_PKG_VERSION").into());
    props
}

pub fn context_props(
    org_id: Option<&str>,
    project_id: Option<&str>,
    mode: Option<&str>,
    email_hash: Option<&str>,
) -> serde_json::Map<String, serde_json::Value> {
    let mut props = base_props(None);
    if let Some(id) = org_id.filter(|s| !s.is_empty()) {
        props.insert("org_id".into(), id.into());
    }
    if let Some(id) = project_id.filter(|s| !s.is_empty()) {
        props.insert("project_id".into(), id.into());
    }
    if let Some(m) = mode {
        props.insert("mode".into(), m.into());
    }
    if let Some(hash) = email_hash.filter(|s| !s.is_empty()) {
        props.insert("email_hash".into(), hash.into());
    }
    props
}

pub fn capture_activation(
    event: ActivationEvent,
    properties: Option<serde_json::Map<String, serde_json::Value>>,
    no_telemetry: bool,
) {
    capture_best_effort(event, properties, no_telemetry);
}

fn capture_best_effort(
    event: ActivationEvent,
    properties: Option<serde_json::Map<String, serde_json::Value>>,
    no_telemetry: bool,
) {
    if !telemetry_enabled(no_telemetry) {
        return;
    }
    let Some(api_key) = posthog_api_key() else {
        return;
    };
    let host = std::env::var("AM_POSTHOG_HOST")
        .or_else(|_| std::env::var("NEXT_PUBLIC_POSTHOG_HOST"))
        .unwrap_or_else(|_| DEFAULT_POSTHOG_HOST.to_string());

    let distinct_id = distinct_id();
    let props = base_props(properties);

    let Some(timestamp) = occurrence_timestamp() else {
        return;
    };
    let body = CaptureBody {
        api_key,
        event: event.as_str(),
        distinct_id,
        properties: props,
        uuid: uuid::Uuid::now_v7().to_string(),
        timestamp,
    };

    let client = CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    });

    let url = format!("{}/capture/", host.trim_end_matches('/'));
    let client = client.clone();
    PENDING_CAPTURES.fetch_add(1, Ordering::AcqRel);
    tokio::spawn(async move {
        send_capture(&client, &url, &body).await;
        PENDING_CAPTURES.fetch_sub(1, Ordering::AcqRel);
    });
}

// A capture acknowledgement is not proof of final ingestion. In particular,
// PostHog can return HTTP 200 while dropping analytics due to a quota limit.
fn capture_accepted(status: reqwest::StatusCode, body: &serde_json::Value) -> bool {
    status.is_success()
        // Legacy capture implementations use integer 1; capture-rs serializes
        // CaptureResponseCode::Ok as "Ok". Neither implies final ingestion.
        && body.get("status").is_some_and(|status| {
            status.as_i64() == Some(1) || status.as_str() == Some("Ok")
        })
        && body
            .get("quota_limited")
            .is_none_or(|limits| limits.is_null() || limits.as_array().is_some_and(Vec::is_empty))
}

async fn send_capture(client: &reqwest::Client, url: &str, body: &CaptureBody) -> bool {
    send_capture_if(client, url, body, || true).await
}

async fn send_capture_if(
    client: &reqwest::Client,
    url: &str,
    body: &CaptureBody,
    allowed: impl Fn() -> bool,
) -> bool {
    for attempt in 1..=MAX_ATTEMPTS {
        if !allowed() {
            return false;
        }
        let retryable = match client
            .post(url)
            .timeout(REQUEST_TIMEOUT)
            .json(body)
            .send()
            .await
        {
            Ok(response) => {
                let status = response.status();
                if status.is_success() {
                    match response.bytes().await {
                        Ok(bytes) => {
                            return serde_json::from_slice::<serde_json::Value>(&bytes)
                                .is_ok_and(|value| capture_accepted(status, &value));
                        }
                        Err(_) => true,
                    }
                } else {
                    tracing::debug!(
                        event = body.event,
                        status = status.as_u16(),
                        "telemetry capture rejected"
                    );
                    status.is_server_error() || status == reqwest::StatusCode::TOO_MANY_REQUESTS
                }
            }
            Err(_) => {
                // Never log reqwest errors: their URL can contain credentials.
                tracing::debug!(event = body.event, "telemetry capture transport failed");
                true
            }
        };
        if !retryable || attempt == MAX_ATTEMPTS {
            return false;
        }
        // The same UUID, timestamp and distinct_id are reused for retry deduplication.
        tokio::time::sleep(RETRY_DELAY).await;
    }
    false
}

/// Wait for in-flight capture requests before process exit.
pub async fn flush_telemetry() {
    let deadline = Instant::now() + FLUSH_TIMEOUT;
    while PENDING_CAPTURES.load(Ordering::Acquire) > 0 && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

/// Classify and capture a step failure — never sends raw error text.
pub fn capture_step_failure(
    step: InitStep,
    err: impl std::fmt::Display,
    context: Option<serde_json::Map<String, serde_json::Value>>,
    no_telemetry: bool,
) {
    let error_class = classify_error(&err.to_string());
    let mut props = context.unwrap_or_else(|| base_props(None));
    props.insert("step".into(), step.as_str().into());
    props.insert("error_class".into(), error_class.as_str().into());
    capture_activation(ActivationEvent::InitStepFailed, Some(props), no_telemetry);
}

pub fn capture_email_hash(email: &str, no_telemetry: bool) -> Option<String> {
    if !telemetry_enabled(no_telemetry) {
        return None;
    }
    let mut hasher = Sha256::new();
    hasher.update(email.trim().to_lowercase().as_bytes());
    Some(hex::encode(hasher.finalize()))
}

/// Emit `first_real_memory_created` once per install when a non-smoke ingest stores data.
pub fn capture_first_real_memory_if_needed(
    memories_stored: i32,
    source_site: &str,
    context: &ActivationContext,
    profile: &crate::config::ResolvedProfile,
    no_telemetry: bool,
    generation: Option<ConsentGeneration>,
) {
    first_memory::capture(
        memories_stored,
        source_site,
        context,
        profile,
        no_telemetry,
        generation,
    );
}

/// Drop an unsent first-memory envelope on explicit opt-out; never backfill it.
pub fn apply_consent(no_telemetry: bool) {
    if !telemetry_enabled(no_telemetry) {
        first_memory::suppress();
    }
}

#[cfg(test)]
fn should_attempt_first_memory(
    memories_stored: i32,
    source_site: &str,
    enabled: bool,
    has_key: bool,
) -> bool {
    memories_stored > 0 && !is_smoke_scope(source_site) && enabled && has_key
}

pub fn is_smoke_scope(source_site: &str) -> bool {
    source_site == crate::verification::smoke::SMOKE_SOURCE_SITE
        || source_site == crate::verification::smoke::SMOKE_USER_ID
}

#[derive(Serialize)]
struct CaptureBody {
    api_key: String,
    uuid: String,
    timestamp: String,
    event: &'static str,
    distinct_id: String,
    properties: serde_json::Map<String, serde_json::Value>,
}

// Retain chrono's UTC spelling and precision for analytics occurrence times.
fn occurrence_timestamp() -> Option<String> {
    am_core_types::timestamp_serde::revision(time::OffsetDateTime::now_utc()).ok()
}

fn posthog_api_key() -> Option<String> {
    std::env::var("AM_POSTHOG_KEY")
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| {
            std::env::var("NEXT_PUBLIC_POSTHOG_KEY")
                .ok()
                .filter(|s| !s.is_empty())
        })
}

fn distinct_id() -> String {
    let _ = ensure_config_initialized();
    let fallback = format!("cli_{}", uuid_like());
    // Read and assign under one lock so concurrent invocations agree on a
    // single distinct_id instead of each writing their own.
    update_config(|cfg| {
        if let Some(id) = cfg.telemetry_distinct_id.clone() {
            return Ok(id);
        }
        let id = format!("cli_{}", uuid_like());
        cfg.telemetry_distinct_id = Some(id.clone());
        Ok(id)
    })
    .unwrap_or(fallback)
}

fn uuid_like() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{nanos:x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn suppressed_or_unconfigured_capture_never_claims_the_milestone() {
        assert!(!should_attempt_first_memory(1, "real", false, true));
        assert!(!should_attempt_first_memory(1, "real", true, false));
        assert!(!should_attempt_first_memory(0, "real", true, true));
        assert!(!should_attempt_first_memory(1, "am-cli-smoke", true, true));
        assert!(should_attempt_first_memory(1, "real", true, true));
        assert!(!telemetry_enabled(true));
    }

    #[test]
    fn acceptance_requires_acknowledgement_and_no_quota_limit() {
        use serde_json::json;
        let ok = reqwest::StatusCode::OK;
        assert!(capture_accepted(ok, &json!({"status": 1})));
        assert!(capture_accepted(ok, &json!({"status": "Ok"})));
        assert!(capture_accepted(
            ok,
            &json!({"status": "Ok", "quota_limited": []})
        ));
        assert!(capture_accepted(
            ok,
            &json!({"status": 1, "quota_limited": []})
        ));
        for body in [
            json!({}),
            json!({"status": 0}),
            json!({"status": "ok"}),
            json!({"status": "1"}),
            json!({"status": true}),
            json!({"status": "NoContent"}),
            json!({"status": "Ok", "quota_limited": ["events"]}),
            json!({"status": 1, "quota_limited": ["events"]}),
        ] {
            assert!(!capture_accepted(ok, &body));
        }
        assert!(!capture_accepted(
            reqwest::StatusCode::BAD_REQUEST,
            &json!({"status": 1})
        ));
        assert!(!capture_accepted(
            reqwest::StatusCode::INTERNAL_SERVER_ERROR,
            &json!({"status": 1})
        ));
    }

    async fn mock_capture(
        statuses: Vec<u16>,
    ) -> (
        String,
        std::sync::Arc<std::sync::Mutex<Vec<serde_json::Value>>>,
        tokio::task::JoinHandle<()>,
    ) {
        use axum::{Json, Router, routing::post};
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let records = seen.clone();
        let app = Router::new().route(
            "/capture/",
            post(move |Json(body): Json<serde_json::Value>| {
                let records = records.clone();
                let statuses = statuses.clone();
                async move {
                    let mut records = records.lock().unwrap();
                    let status = statuses[records.len().min(statuses.len() - 1)];
                    records.push(body);
                    (
                        axum::http::StatusCode::from_u16(status).unwrap(),
                        Json(serde_json::json!({"status": 1})),
                    )
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/capture/", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (url, seen, task)
    }

    fn test_body() -> CaptureBody {
        CaptureBody {
            api_key: "test-only".into(),
            uuid: uuid::Uuid::now_v7().to_string(),
            timestamp: "2026-11-18T00:00:00Z".into(),
            event: "first_real_memory_created",
            distinct_id: "cli_test".into(),
            properties: serde_json::Map::new(),
        }
    }

    #[tokio::test]
    async fn capture_transport_validates_acknowledgement_body() {
        use axum::{Router, routing::post};
        for (response, expected) in [
            (r#"{"status":"Ok"}"#, true),
            (r#"{"status":1}"#, true),
            (r#"{"status":"Ok","quota_limited":["events"]}"#, false),
            (r#"{"status":"error"}"#, false),
            ("not-json", false),
        ] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}/capture/", listener.local_addr().unwrap());
            let app = Router::new().route("/capture/", post(move || async move { response }));
            let server = tokio::spawn(async move {
                axum::serve(listener, app).await.unwrap();
            });
            assert_eq!(
                send_capture(&reqwest::Client::new(), &url, &test_body()).await,
                expected
            );
            server.abort();
        }
    }

    #[tokio::test]
    async fn retries_retryable_responses_with_identical_envelope() {
        for status in [429, 500] {
            let (url, seen, task) = mock_capture(vec![status, 200]).await;
            assert!(send_capture(&reqwest::Client::new(), &url, &test_body()).await);
            let seen = seen.lock().unwrap();
            assert_eq!(seen.len(), 2);
            assert_eq!(seen[0], seen[1]);
            task.abort();
        }
    }

    #[tokio::test]
    async fn permanent_errors_do_not_retry_and_transient_errors_are_bounded() {
        for (status, attempts) in [(400, 1), (401, 1), (500, MAX_ATTEMPTS)] {
            let (url, seen, task) = mock_capture(vec![status]).await;
            assert!(!send_capture(&reqwest::Client::new(), &url, &test_body()).await);
            assert_eq!(seen.lock().unwrap().len(), attempts);
            task.abort();
        }
    }

    #[tokio::test]
    async fn truncated_success_body_retries_the_original_envelope() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/capture/", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            let mut requests = Vec::new();
            for attempt in 0..2 {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                loop {
                    let mut chunk = [0u8; 4096];
                    let n = stream.read(&mut chunk).await.unwrap();
                    assert!(n > 0);
                    request.extend_from_slice(&chunk[..n]);
                    if let Some(end) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&request[..end]);
                        let length: usize = headers
                            .lines()
                            .find_map(|line| {
                                line.to_lowercase()
                                    .strip_prefix("content-length:")
                                    .map(|s| s.trim().parse().unwrap())
                            })
                            .unwrap();
                        if request.len() >= end + 4 + length {
                            requests.push(request[end + 4..end + 4 + length].to_vec());
                            break;
                        }
                    }
                }
                let response = if attempt == 0 {
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 99\r\nConnection: close\r\n\r\n{"
                } else {
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 12\r\nConnection: close\r\n\r\n{\"status\":1}"
                };
                stream.write_all(response.as_bytes()).await.unwrap();
                stream.shutdown().await.unwrap();
            }
            requests
        });
        assert!(send_capture(&reqwest::Client::new(), &url, &test_body()).await);
        let requests = task.await.unwrap();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0], requests[1]);
    }

    #[tokio::test]
    async fn suppression_gate_prevents_transport() {
        let (url, seen, task) = mock_capture(vec![200]).await;
        assert!(!send_capture_if(&reqwest::Client::new(), &url, &test_body(), || false).await);
        assert!(seen.lock().unwrap().is_empty());
        task.abort();
    }

    #[tokio::test]
    async fn unresponsive_capture_stays_within_exit_budget() {
        use axum::{Router, routing::post};
        assert!(REQUEST_TIMEOUT * MAX_ATTEMPTS as u32 + RETRY_DELAY < FLUSH_TIMEOUT);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/capture/", listener.local_addr().unwrap());
        let app = Router::new().route(
            "/capture/",
            post(|| async {
                std::future::pending::<()>().await;
            }),
        );
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let result = tokio::time::timeout(
            FLUSH_TIMEOUT + Duration::from_millis(500),
            send_capture(&reqwest::Client::new(), &url, &test_body()),
        )
        .await
        .expect("capture exceeded bounded retry budget");
        assert!(!result);
        server.abort();
    }

    #[tokio::test]
    async fn connection_failure_is_not_acceptance() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/capture/", listener.local_addr().unwrap());
        drop(listener);
        assert!(!send_capture(&reqwest::Client::new(), &url, &test_body()).await);
    }

    #[test]
    fn base_props_always_include_source_and_cli_version() {
        let props = base_props(None);
        assert_eq!(props.get("source").and_then(|v| v.as_str()), Some("am-cli"));
        assert!(
            props
                .get("cli_version")
                .and_then(|v| v.as_str())
                .is_some_and(|s| !s.is_empty())
        );
    }

    #[test]
    fn context_props_include_org_project_mode_and_hash() {
        let props = context_props(
            Some("org_abc"),
            Some("proj_xyz"),
            Some("local"),
            Some("deadbeef"),
        );
        assert_eq!(
            props.get("org_id").and_then(|v| v.as_str()),
            Some("org_abc")
        );
        assert_eq!(
            props.get("project_id").and_then(|v| v.as_str()),
            Some("proj_xyz")
        );
        assert_eq!(props.get("mode").and_then(|v| v.as_str()), Some("local"));
        assert_eq!(
            props.get("email_hash").and_then(|v| v.as_str()),
            Some("deadbeef")
        );
    }

    #[test]
    fn init_step_failed_event_name_is_stable() {
        assert_eq!(ActivationEvent::InitStepFailed.as_str(), "init_step_failed");
    }

    #[test]
    fn hosted_cloud_handoff_event_name_is_stable() {
        assert_eq!(
            ActivationEvent::HostedCloudHandoff.as_str(),
            "hosted_cloud_handoff"
        );
    }

    #[test]
    fn hosted_cloud_configured_event_name_is_stable() {
        assert_eq!(
            ActivationEvent::HostedCloudConfigured.as_str(),
            "hosted_cloud_configured"
        );
    }

    #[test]
    fn is_smoke_scope_detects_smoke_constants() {
        assert!(is_smoke_scope("am-cli-smoke"));
        assert!(!is_smoke_scope("cli"));
    }
}
