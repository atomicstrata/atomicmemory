//! Opt-out CLI activation telemetry (PostHog HTTP capture).

use std::sync::OnceLock;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::config::{ensure_config_initialized, update_config};
use crate::validation::recovery::classify_error;

const DEFAULT_POSTHOG_HOST: &str = "https://us.i.posthog.com";

static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
static PENDING_CAPTURES: AtomicUsize = AtomicUsize::new(0);

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

    let body = CaptureBody {
        api_key,
        event: event.as_str(),
        distinct_id,
        properties: props,
    };

    let client = CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    });

    let url = format!("{}/capture/", host.trim_end_matches('/'));
    let client = client.clone();
    PENDING_CAPTURES.fetch_add(1, Ordering::AcqRel);
    tokio::spawn(async move {
        let _ = client.post(url).json(&body).send().await;
        PENDING_CAPTURES.fetch_sub(1, Ordering::AcqRel);
    });
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
    no_telemetry: bool,
) {
    if memories_stored <= 0 || is_smoke_scope(source_site) {
        return;
    }
    let _ = ensure_config_initialized();
    // Claim the "first real memory" flag under the config lock so two
    // concurrent ingests cannot both observe it unset and double-report.
    let claimed = update_config(|cfg| {
        if cfg.telemetry_first_real_memory_sent == Some(true) {
            return Ok(false);
        }
        cfg.telemetry_first_real_memory_sent = Some(true);
        Ok(true)
    });
    if !matches!(claimed, Ok(true)) {
        return;
    }
    capture_activation(
        ActivationEvent::FirstRealMemoryCreated,
        Some(context.props()),
        no_telemetry,
    );
}

pub fn is_smoke_scope(source_site: &str) -> bool {
    source_site == crate::verification::smoke::SMOKE_SOURCE_SITE
        || source_site == crate::verification::smoke::SMOKE_USER_ID
}

#[derive(Serialize)]
struct CaptureBody {
    api_key: String,
    event: &'static str,
    distinct_id: String,
    properties: serde_json::Map<String, serde_json::Value>,
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
