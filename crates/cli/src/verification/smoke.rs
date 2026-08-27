//! Ephemeral ingest → search → delete round-trip for onboarding verification.

use std::time::Duration;

use am_cloud_client::MemoryClient;
use am_core_types::{CoreIngestRequest, CoreMemoryQuery, CoreSearchRequest};
use anyhow::{Context, Result, bail};
use serde::Serialize;

use crate::cli::GlobalOptions;
use crate::commands::client::{memory_client_for_profile, resolve_ctx};
use crate::telemetry::{ActivationEvent, capture_activation};
use crate::validation::with_operation_recovery;

pub const SMOKE_USER_ID: &str = "am-cli-smoke";
pub const SMOKE_SOURCE_SITE: &str = "am-cli-smoke";

/// Backoff between search attempts while waiting for the ingested marker.
///
/// Ingest and search are separate calls, and indexing is not guaranteed to be
/// synchronous, so a single immediate search can miss a memory that is about to
/// become retrievable. Bounded retry keeps the check honest — it still fails
/// when retrieval is genuinely broken — without failing onboarding on ordinary
/// indexing lag. Total added wait is under four seconds, and the entire retry
/// loop shares one `SmokeOptions::timeout` deadline.
const SEARCH_RETRY_DELAYS: [Duration; 4] = [
    Duration::from_millis(250),
    Duration::from_millis(500),
    Duration::from_millis(1000),
    Duration::from_millis(2000),
];

#[derive(Debug, Clone, Serialize)]
pub struct SmokeResult {
    pub verified: bool,
    pub ingest_trace_id: Option<String>,
    pub memory_ids_cleaned: Vec<String>,
    pub marker: String,
}

#[derive(Debug, Clone, Copy)]
pub struct SmokeOptions {
    pub timeout: Duration,
}

impl Default for SmokeOptions {
    fn default() -> Self {
        Self {
            timeout: Duration::from_secs(45),
        }
    }
}

/// Optional PostHog context for smoke telemetry (no marker/content in props).
#[derive(Debug, Clone, Default)]
pub struct SmokeTelemetry {
    pub no_telemetry: bool,
    pub props: Option<serde_json::Map<String, serde_json::Value>>,
}

/// Create a tagged ephemeral memory, retrieve it, then delete all residue.
pub async fn run_memory_smoke(
    global: &GlobalOptions,
    opts: SmokeOptions,
    telemetry: Option<SmokeTelemetry>,
) -> Result<SmokeResult> {
    let profile = resolve_ctx(global)
        .await
        .context("resolve profile for smoke test")?;
    // Building the client is where a missing or withheld credential surfaces.
    // Returning that straight through `?` gave it only generic context, so the
    // profile-aware playbook this function installs below never applied to the
    // most likely failure.
    let client = memory_client_for_profile(&profile)
        .await
        .map_err(|err| with_operation_recovery(err, "Memory smoke client", profile.kind))?;
    run_memory_smoke_with_client(client, opts, telemetry)
        .await
        .map_err(|err| with_operation_recovery(err, "Memory smoke", profile.kind))
}

async fn run_memory_smoke_with_client(
    client: MemoryClient,
    opts: SmokeOptions,
    telemetry: Option<SmokeTelemetry>,
) -> Result<SmokeResult> {
    let marker = format!("am-cli-smoke-{}", uuid_like_marker());

    let ingest_req = smoke_ingest_request(&marker);

    let ingest = tokio::time::timeout(opts.timeout, client.ingest_quick(&ingest_req))
        .await
        .context("smoke ingest timed out")??;

    if let Some(tel) = telemetry.as_ref() {
        capture_activation(
            ActivationEvent::FirstIngestCompleted,
            tel.props.clone(),
            tel.no_telemetry,
        );
    }

    let mut memory_ids = ingest.stored_memory_ids.clone();
    if memory_ids.is_empty() && !ingest.updated_memory_ids.is_empty() {
        memory_ids = ingest.updated_memory_ids.clone();
    }

    let search_req = CoreSearchRequest {
        user_id: SMOKE_USER_ID.into(),
        query: marker.clone(),
        limit: Some(5),
        threshold: None,
        token_budget: None,
        retrieval_mode: None,
        skip_repair: None,
        source_site: Some(SMOKE_SOURCE_SITE.into()),
        agent_id: None,
        workspace_id: None,
        session_id: Some(SMOKE_USER_ID.into()),
        visibility: None,
        as_of: None,
        namespace_scope: None,
        config_override: None,
    };

    // One overall deadline for the whole retry loop. A per-attempt timeout
    // would let a slow-but-alive backend consume timeout × attempts (minutes)
    // where a single attempt used to fail at `opts.timeout`; the backoff
    // schedule exists for indexing lag, not for a degraded backend.
    let retrieval: Result<bool> = tokio::time::timeout(opts.timeout, async {
        let mut attempt = 0usize;
        loop {
            let search = client.search_fast(&search_req).await?;

            if search
                .memories
                .iter()
                .any(|hit| hit.memory.content.contains(&marker))
            {
                return Ok(true);
            }

            let Some(delay) = SEARCH_RETRY_DELAYS.get(attempt) else {
                return Ok(false);
            };
            tokio::time::sleep(*delay).await;
            attempt += 1;
        }
    })
    .await
    .map_err(|_| anyhow::anyhow!("smoke search timed out"))
    .and_then(|result| result);

    // Clean up before reporting the outcome. The ingested memory exists
    // whether or not retrieval worked, so returning the verification error
    // first would leave the smoke marker behind in the user's Core.
    let query = CoreMemoryQuery {
        user_id: SMOKE_USER_ID.into(),
        workspace_id: None,
        agent_id: None,
    };

    let mut cleaned = Vec::new();
    for id in &memory_ids {
        if client.delete_memory(id, &query).await.is_ok() {
            cleaned.push(id.clone());
        }
    }

    let found = retrieval?;
    if !found {
        bail!("smoke verification failed — memory not retrieved (search returned no marker match)");
    }

    Ok(SmokeResult {
        verified: found,
        ingest_trace_id: ingest.ingest_trace_id,
        memory_ids_cleaned: cleaned,
        marker,
    })
}

fn smoke_ingest_request(marker: &str) -> CoreIngestRequest {
    CoreIngestRequest {
        user_id: SMOKE_USER_ID.into(),
        source_site: SMOKE_SOURCE_SITE.into(),
        conversation: format!("CLI onboarding smoke marker: {marker}"),
        agent_id: None,
        workspace_id: None,
        session_id: Some(SMOKE_USER_ID.into()),
        source_url: None,
        metadata: None,
        skip_extraction: Some(true),
        content_class: Some("summary".into()),
        visibility: None,
        config_override: None,
    }
}

fn uuid_like_marker() -> String {
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
    use crate::config::ProfileKind;

    #[test]
    fn smoke_constants_are_stable() {
        assert_eq!(SMOKE_USER_ID, "am-cli-smoke");
        assert_eq!(SMOKE_SOURCE_SITE, "am-cli-smoke");
    }

    #[test]
    fn smoke_ingest_request_stamps_verbatim_content_class() {
        let req = smoke_ingest_request("marker-abc");
        assert_eq!(req.skip_extraction, Some(true));
        assert_eq!(req.content_class.as_deref(), Some("summary"));
        assert!(req.conversation.contains("marker-abc"));
    }

    #[test]
    fn smoke_wires_recovery_into_client_construction() {
        // The formatter test below passes even if run_memory_smoke never calls
        // it. Pin the wiring: the client-construction path must carry recovery
        // text, which is where a missing credential actually fails.
        let src = include_str!("smoke.rs");
        let body = src
            .split("pub async fn run_memory_smoke(")
            .nth(1)
            .expect("run_memory_smoke present");
        let body = &body[..body.find("\nasync fn ").unwrap_or(body.len())];
        assert!(
            body.contains("memory_client_for_profile"),
            "client must be built from the resolved profile"
        );
        assert_eq!(
            body.matches("with_operation_recovery").count(),
            2,
            "both client construction and the smoke run must install recovery"
        );
    }

    #[test]
    fn smoke_recovery_uses_client_profile_kind_without_re_resolve() {
        let err = with_operation_recovery(
            anyhow::anyhow!("http 401 unauthorized"),
            "Memory smoke",
            ProfileKind::Local,
        );
        let msg = err.to_string();
        assert!(!msg.contains("am init --project"));
        assert!(msg.contains("am instance"));
    }
}
