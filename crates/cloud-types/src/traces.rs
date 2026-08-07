//! Trace DTOs.

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct TraceSummary {
    pub id: String,
    pub project_id: String,
    pub kind: String,
    pub input_summary: String,
    pub result_count: i32,
    pub latency_ms: i32,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct RetrievalTrace {
    pub id: String,
    pub project_id: String,
    pub api_key_id: Option<String>,
    pub input_summary: String,
    pub scope: serde_json::Value,
    pub candidate_ids: serde_json::Value,
    pub included_ids: serde_json::Value,
    pub excluded_ids: serde_json::Value,
    pub ranking: serde_json::Value,
    #[serde(default)]
    pub filter_stages: serde_json::Value,
    #[serde(default)]
    pub candidates_json: serde_json::Value,
    pub result_count: i32,
    pub latency_ms: i32,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct MutationTrace {
    pub id: String,
    pub project_id: String,
    pub api_key_id: Option<String>,
    pub input_summary: String,
    pub scope: serde_json::Value,
    pub decision: String,
    pub previous_memory_id: Option<String>,
    pub new_memory_id: Option<String>,
    pub reason: Option<String>,
    pub confidence: Option<f32>,
    #[serde(default)]
    pub decision_stage: Option<String>,
    #[serde(default)]
    pub reason_code: Option<String>,
    #[serde(default)]
    pub facts_json: serde_json::Value,
    pub evidence: serde_json::Value,
    pub latency_ms: i32,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TraceDetail {
    Retrieval(RetrievalTrace),
    Mutation(MutationTrace),
}

/// Request body for connected-local trace reporting (`POST /v1/observability/traces`).
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum IngestTraceRequest {
    Mutation {
        input_summary: String,
        scope: serde_json::Value,
        decision: String,
        #[serde(default)]
        previous_memory_id: Option<String>,
        #[serde(default)]
        new_memory_id: Option<String>,
        #[serde(default)]
        reason: Option<String>,
        #[serde(default)]
        confidence: Option<f32>,
        #[serde(default)]
        decision_stage: Option<String>,
        #[serde(default)]
        reason_code: Option<String>,
        #[serde(default = "default_trace_facts_json")]
        facts_json: serde_json::Value,
        #[serde(default = "default_trace_evidence")]
        evidence: serde_json::Value,
        latency_ms: i32,
    },
    Retrieval {
        input_summary: String,
        scope: serde_json::Value,
        #[serde(default = "default_trace_json_array")]
        candidate_ids: serde_json::Value,
        #[serde(default = "default_trace_json_array")]
        included_ids: serde_json::Value,
        #[serde(default = "default_trace_json_array")]
        excluded_ids: serde_json::Value,
        #[serde(default = "default_trace_json_array")]
        ranking: serde_json::Value,
        #[serde(default = "default_trace_json_object")]
        filter_stages: serde_json::Value,
        #[serde(default = "default_trace_json_object")]
        candidates_json: serde_json::Value,
        result_count: i32,
        latency_ms: i32,
    },
}

fn default_trace_facts_json() -> serde_json::Value {
    serde_json::json!([])
}

fn default_trace_evidence() -> serde_json::Value {
    serde_json::json!({})
}

fn default_trace_json_array() -> serde_json::Value {
    serde_json::json!([])
}

fn default_trace_json_object() -> serde_json::Value {
    serde_json::json!({})
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct IngestTraceResponse {
    pub id: String,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deduplicated: Option<bool>,
}

/// Supported v2 memory operations for connected-local trace envelopes.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum TraceIngestOperation {
    #[serde(rename = "memory.ingest")]
    MemoryIngest,
    #[serde(rename = "memory.update")]
    MemoryUpdate,
    #[serde(rename = "memory.delete")]
    MemoryDelete,
    #[serde(rename = "memory.search")]
    MemorySearch,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum TraceIngestOutcome {
    Success,
    Error,
}

/// Strict connected-local trace envelope (schema version 2).
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct IngestTraceEnvelopeV2 {
    pub schema_version: u16,
    pub event_id: uuid::Uuid,
    pub core_instance_id: String,
    pub occurred_at: chrono::DateTime<chrono::Utc>,
    pub operation: TraceIngestOperation,
    pub outcome: TraceIngestOutcome,
    pub duration_ms: i32,
    #[serde(default = "default_trace_json_object")]
    pub summary: serde_json::Value,
    #[serde(default = "default_trace_json_object")]
    pub evidence: serde_json::Value,
}

/// Accepts legacy v1 kind-tagged bodies or strict v2 envelopes.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(untagged)]
pub enum IngestTraceBody {
    V2(Box<IngestTraceEnvelopeV2>),
    V1(Box<IngestTraceRequest>),
}
