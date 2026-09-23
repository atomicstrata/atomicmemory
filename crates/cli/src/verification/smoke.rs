//! Ephemeral extraction/ingest → embedding search → cleanup for onboarding verification.

use std::time::Duration;

use am_cloud_client::MemoryClient;
use am_core_types::{CoreIngestRequest, CoreMemoryQuery, CoreSearchRequest};
use anyhow::{Context, Result, bail};
use serde::Serialize;
use tokio::time::Instant;

use crate::cli::GlobalOptions;
use crate::commands::client::{memory_client_for_profile, resolve_ctx};
use crate::config::ProfileKind;
use crate::telemetry::{ActivationEvent, capture_activation};
use crate::validation::with_operation_recovery;

/// Dedicated local-admin namespace for ephemeral CLI verification.
pub const SMOKE_USER_ID: &str = "am-cli-smoke";
/// Source tag used to isolate smoke retrieval.
pub const SMOKE_SOURCE_SITE: &str = "am-cli-smoke";

const FULL_SMOKE_TIMEOUT: Duration = Duration::from_secs(120);
const CLEANUP_RESERVE: Duration = Duration::from_secs(15);
/// Bounded indexing-lag retries share the ingest/retrieval operation deadline.
const SEARCH_RETRY_DELAYS: [Duration; 4] = [
    Duration::from_millis(250),
    Duration::from_millis(500),
    Duration::from_millis(1000),
    Duration::from_millis(2000),
];

/// Successful pipeline evidence, emitted only after every cleanup succeeds.
#[derive(Debug, Clone, Serialize)]
pub struct SmokeResult {
    pub verified: bool,
    pub mode: SmokeMode,
    pub facts_extracted: i32,
    pub ingest_trace_id: Option<String>,
    pub memory_ids_cleaned: Vec<String>,
    pub marker: String,
}

/// Pipeline exercised by an onboarding smoke.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SmokeMode {
    /// Existing OpenAI-compatible verbatim ingest and embedding retrieval.
    Quick,
    /// SLM extraction followed by embedding retrieval.
    FullExtraction,
}

/// Deadline and pipeline selected by the command boundary.
#[derive(Debug, Clone, Copy)]
pub struct SmokeOptions {
    /// Total operation budget, including the reserved cleanup window.
    pub timeout: Duration,
    pub mode: SmokeMode,
}

impl Default for SmokeOptions {
    fn default() -> Self {
        Self {
            timeout: Duration::from_secs(45),
            mode: SmokeMode::Quick,
        }
    }
}

impl SmokeOptions {
    /// Full extraction with a bounded budget for local model inference.
    pub fn full_extraction() -> Self {
        Self {
            timeout: FULL_SMOKE_TIMEOUT,
            mode: SmokeMode::FullExtraction,
        }
    }
}

/// Optional PostHog context for smoke telemetry (no marker/content in props).
#[derive(Debug, Clone, Default)]
pub struct SmokeTelemetry {
    pub no_telemetry: bool,
    pub props: Option<serde_json::Map<String, serde_json::Value>>,
}

/// Create a tagged ephemeral memory, retrieve it, then delete all known residue.
pub async fn run_memory_smoke(
    global: &GlobalOptions,
    opts: SmokeOptions,
    telemetry: Option<SmokeTelemetry>,
) -> Result<SmokeResult> {
    let profile = resolve_ctx(global)
        .await
        .context("resolve profile for smoke test")?;
    let (client, identity) = memory_client_for_profile(&profile).await.map_err(|err| {
        smoke_recovery(
            err,
            "Memory smoke client",
            profile.kind,
            &profile.name,
            opts.mode,
        )
    })?;
    // Connected Local identity (Clerk `sub`) must bind into the smoke namespace
    // whenever a session is present — including managed CORE_API_KEY HTTP auth.
    // Key-only paths without a session keep the dedicated smoke namespace.
    let smoke_user = identity
        .as_ref()
        .map_or(SMOKE_USER_ID, |identity| identity.user.as_str());
    run_memory_smoke_with_client(client, opts, telemetry, smoke_user)
        .await
        .map_err(|err| smoke_recovery(err, "Memory smoke", profile.kind, &profile.name, opts.mode))
}

fn smoke_recovery(
    err: anyhow::Error,
    operation: &str,
    kind: ProfileKind,
    profile: &str,
    mode: SmokeMode,
) -> anyhow::Error {
    if mode == SmokeMode::Quick {
        return with_operation_recovery(err, operation, kind);
    }
    let profile = super::receipt::shell_argument(profile);
    anyhow::anyhow!(
        "{operation} failed: {err:#}\n\nCheck the selected profile's SLM extraction and embedding services, then run `am --profile {profile} doctor --smoke`."
    )
}

async fn run_memory_smoke_with_client(
    client: MemoryClient,
    opts: SmokeOptions,
    telemetry: Option<SmokeTelemetry>,
    user_id: &str,
) -> Result<SmokeResult> {
    let deadline = Instant::now() + opts.timeout;
    // Reserve cleanup time inside the single overall budget so failed or timed-out
    // retrieval still gets a bounded chance to remove all known ingested records.
    let pipeline_deadline = deadline - CLEANUP_RESERVE.min(opts.timeout / 4);
    let client = client.with_timeout(opts.timeout)?;
    let marker = format!("am-cli-smoke-{}", uuid::Uuid::now_v7());
    let ingest_req = smoke_ingest_request(&marker, opts.mode, user_id);
    let ingest = tokio::time::timeout_at(pipeline_deadline, async {
        match opts.mode {
            SmokeMode::Quick => client.ingest_quick(&ingest_req).await,
            SmokeMode::FullExtraction => client.ingest(&ingest_req).await,
        }
    })
    .await
    .context("smoke ingest timed out; storage may have occurred without a response")??;

    if let Some(tel) = telemetry.as_ref() {
        capture_activation(
            ActivationEvent::FirstIngestCompleted,
            tel.props.clone(),
            tel.no_telemetry,
        );
    }
    let mut memory_ids = Vec::new();
    for id in ingest
        .stored_memory_ids
        .iter()
        .chain(&ingest.updated_memory_ids)
    {
        if !memory_ids.contains(id) {
            memory_ids.push(id.clone());
        }
    }
    let retrieval = if opts.mode == SmokeMode::FullExtraction && ingest.facts_extracted <= 0 {
        Err(anyhow::anyhow!(
            "smoke extraction failed — no facts extracted"
        ))
    } else if memory_ids.is_empty() {
        Err(anyhow::anyhow!(
            "smoke ingest returned no memory IDs; extraction and cleanup cannot be verified"
        ))
    } else {
        tokio::time::timeout_at(
            pipeline_deadline,
            retrieve_marker(&client, &marker, &memory_ids, opts.mode, user_id),
        )
        .await
        .map_err(|_| anyhow::anyhow!("smoke search timed out"))
        .and_then(|result| result)
    };
    let cleanup = cleanup_memories(&client, &memory_ids, deadline, user_id).await;
    let cleaned = match (retrieval, cleanup) {
        (Ok(()), Ok(cleaned)) => cleaned,
        (Err(retrieval), Ok(_)) => return Err(retrieval),
        (Ok(()), Err(cleanup)) => return Err(cleanup),
        (Err(retrieval), Err(cleanup)) => bail!("{retrieval:#}; {cleanup:#}"),
    };
    Ok(SmokeResult {
        verified: true,
        mode: opts.mode,
        facts_extracted: ingest.facts_extracted,
        ingest_trace_id: ingest.ingest_trace_id,
        memory_ids_cleaned: cleaned,
        marker,
    })
}

async fn retrieve_marker(
    client: &MemoryClient,
    marker: &str,
    memory_ids: &[String],
    mode: SmokeMode,
    user_id: &str,
) -> Result<()> {
    let search_req = CoreSearchRequest {
        user_id: user_id.into(),
        query: marker.into(),
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
    let mut attempt = 0usize;
    loop {
        // Fast search still embeds the query; it omits only optional LLM stages.
        let search = client.search_fast(&search_req).await?;
        if search.memories.iter().any(|hit| {
            memory_ids.contains(&hit.memory.id)
                && (mode == SmokeMode::FullExtraction || hit.memory.content.contains(marker))
        }) {
            return Ok(());
        }
        let Some(delay) = SEARCH_RETRY_DELAYS.get(attempt) else {
            bail!("smoke verification failed — ingested memory not retrieved");
        };
        tokio::time::sleep(*delay).await;
        attempt += 1;
    }
}

async fn cleanup_memories(
    client: &MemoryClient,
    memory_ids: &[String],
    deadline: Instant,
    user_id: &str,
) -> Result<Vec<String>> {
    let query = CoreMemoryQuery {
        user_id: user_id.into(),
        workspace_id: None,
        agent_id: None,
    };
    let mut cleaned = Vec::new();
    let mut failures = Vec::new();
    for id in memory_ids {
        match tokio::time::timeout_at(deadline, client.delete_memory(id, &query)).await {
            // Core returns `{ "success": true }` (SuccessResponseSchema). Older
            // fixtures/proxies may send `{ "deleted": true }`. Either confirms.
            Ok(Ok(result)) if result.confirmed() => cleaned.push(id.clone()),
            Ok(Ok(_)) => failures.push(format!("{id}: deletion was not confirmed")),
            Ok(Err(err)) => failures.push(format!("{id}: {err}")),
            Err(_) => failures.push(format!("{id}: cleanup timed out")),
        }
    }
    if !failures.is_empty() {
        bail!(
            "smoke cleanup failed; remaining memory IDs: {}",
            failures.join("; ")
        );
    }
    Ok(cleaned)
}

fn smoke_ingest_request(marker: &str, mode: SmokeMode, user_id: &str) -> CoreIngestRequest {
    let quick = mode == SmokeMode::Quick;
    CoreIngestRequest {
        user_id: user_id.into(),
        source_site: SMOKE_SOURCE_SITE.into(),
        conversation: if quick {
            format!("CLI onboarding smoke marker: {marker}")
        } else {
            format!("My preferred project codename is {marker}. Please remember this preference.")
        },
        agent_id: None,
        workspace_id: None,
        session_id: Some(SMOKE_USER_ID.into()),
        source_url: None,
        metadata: None,
        skip_extraction: Some(quick),
        content_class: quick.then(|| "summary".into()),
        visibility: None,
        config_override: None,
    }
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
        let req = smoke_ingest_request("marker-abc", SmokeMode::Quick, SMOKE_USER_ID);
        assert_eq!(req.skip_extraction, Some(true));
        assert_eq!(req.content_class.as_deref(), Some("summary"));
        assert!(req.conversation.contains("marker-abc"));
    }

    #[test]
    fn full_extraction_recovery_uses_selected_profile_without_openai_advice() {
        let err = smoke_recovery(
            anyhow::anyhow!("authentication failed"),
            "Memory smoke",
            ProfileKind::Local,
            "local project",
            SmokeMode::FullExtraction,
        );
        let msg = err.to_string();
        assert!(msg.contains("am --profile 'local project' doctor --smoke"));
        assert!(msg.contains("SLM"));
        assert!(!msg.contains("OPENAI_API_KEY"));
    }
}

#[cfg(test)]
#[path = "smoke_http_tests.rs"]
mod http_tests;
