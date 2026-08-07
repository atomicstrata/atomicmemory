//! Wire shapes for the AtomicMemory Core REST API.
//!
//! These mirror the relevant subset of `atomicmemory-core-openapi.yaml`
//! (v1.0.6). Where the upstream schema is intentionally broad
//! (`observability`, `consensus`, `lesson_check`, `scope`,
//! `config_override`, `metadata`) the field is kept as
//! `serde_json::Value` so we don't have to re-roll the entire OpenAPI
//! surface on every minor core upgrade.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
pub struct CoreHealthResponse {
    pub status: String,
    #[serde(default)]
    pub config: serde_json::Value,
}

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

/// Body for `POST /v1/memories/ingest` and `POST /v1/memories/ingest/quick`.
///
/// `user_id` is the *core-side* namespace. The cloud injects
/// `format!("project:{project_id}")` here so a single project maps to a
/// single core user (see [`am_cloud_tenancy::to_core_user_id`]).
#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
pub struct CoreIngestRequest {
    pub user_id: String,
    pub source_site: String,
    pub conversation: String,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skip_extraction: Option<bool>,
    /// Required on verbatim quick-ingest when Core raw-storage policy is active.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_class: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub visibility: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config_override: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
pub struct CoreIngestResponse {
    pub episode_id: String,
    #[serde(default)]
    pub facts_extracted: i32,
    #[serde(default)]
    pub memories_stored: i32,
    #[serde(default)]
    pub memories_updated: i32,
    #[serde(default)]
    pub memories_deleted: i32,
    #[serde(default)]
    pub memories_skipped: i32,
    #[serde(default)]
    pub composites_created: i32,
    #[serde(default)]
    pub links_created: i32,
    #[serde(default)]
    pub stored_memory_ids: Vec<String>,
    #[serde(default)]
    pub updated_memory_ids: Vec<String>,
    #[serde(default)]
    pub ingest_trace_id: Option<String>,
    /// Populated when Core ships B1 per-fact AUDN trace contract.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audn_trace: Option<CoreIngestAudnTrace>,
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
pub struct CoreSearchRequest {
    pub user_id: String,
    pub query: String,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub threshold: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_budget: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retrieval_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skip_repair: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_site: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub visibility: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub as_of: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub namespace_scope: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config_override: Option<serde_json::Value>,
}

/// A single search result. Core returns `memories: object[]` with the
/// memory body plus an optional `score`/`similarity` field whose exact
/// name varies across modes; we capture both common spellings.
#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
pub struct CoreSearchHit {
    #[serde(flatten)]
    pub memory: CoreMemory,
    #[serde(default)]
    pub score: Option<f32>,
    #[serde(default)]
    pub similarity: Option<f32>,
}

impl CoreSearchHit {
    /// Pick whichever score-like field the core happened to populate.
    pub fn best_score(&self) -> f32 {
        self.score.or(self.similarity).unwrap_or(0.0)
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
pub struct CoreSearchResponse {
    #[serde(default)]
    pub count: i32,
    #[serde(default)]
    pub memories: Vec<CoreSearchHit>,
    #[serde(default)]
    pub citations: Option<Vec<String>>,
    #[serde(default)]
    pub injection_text: Option<String>,
    #[serde(default)]
    pub specialist_answer: Option<String>,
    #[serde(default)]
    pub estimated_context_tokens: Option<i64>,
    #[serde(default)]
    pub budget_constrained: bool,
    #[serde(default)]
    pub retrieval_mode: Option<String>,
    #[serde(default)]
    pub expand_ids: Option<Vec<String>>,
    #[serde(default)]
    pub observability: Option<serde_json::Value>,
    #[serde(default)]
    pub consensus: Option<serde_json::Value>,
    #[serde(default)]
    pub lesson_check: Option<serde_json::Value>,
    #[serde(default)]
    pub tier_assignments: Option<serde_json::Value>,
    #[serde(default)]
    pub scope: Option<serde_json::Value>,
}

// ---------------------------------------------------------------------------
// List / Get / Delete
// ---------------------------------------------------------------------------

/// `GET /v1/memories/list` query string.
#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
pub struct CoreListMemoriesQuery {
    pub user_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offset: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_site: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub episode_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

/// `GET /v1/memories/{id}` / `DELETE /v1/memories/{id}` query string.
#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
pub struct CoreMemoryQuery {
    pub user_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
}

/// A core memory row. Field set is the documented stable subset; the
/// catch-all `extra` collects anything else (`metadata`, `decay_score`,
/// `links`, …) so downstream code can opt in without breaking.
#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
pub struct CoreMemory {
    pub id: String,
    pub content: String,
    #[serde(rename = "type", alias = "memory_type", default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub user_id: Option<String>,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub source_site: Option<String>,
    #[serde(default)]
    pub source_url: Option<String>,
    #[serde(default)]
    pub visibility: Option<String>,
    #[serde(default)]
    pub importance: Option<f32>,
    #[serde(default)]
    pub created_at: Option<chrono::DateTime<chrono::Utc>>,
    #[serde(default)]
    pub updated_at: Option<chrono::DateTime<chrono::Utc>>,
    #[serde(default)]
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
pub struct CoreListMemoriesResponse {
    #[serde(default)]
    pub count: i32,
    #[serde(default)]
    pub memories: Vec<CoreMemory>,
}

#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
pub struct CoreDeleteMemoryResponse {
    #[serde(default)]
    pub deleted: bool,
    #[serde(default)]
    pub id: Option<String>,
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

/// Document registry record (`GET /v1/documents/{id}`, list rows, register response).
#[derive(Debug, Clone, Default, Deserialize, Serialize, ToSchema)]
pub struct CoreDocument {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub user_id: String,
    #[serde(default)]
    pub raw_source_id: String,
    #[serde(default)]
    pub external_id: String,
    #[serde(default)]
    pub external_uri: Option<String>,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub mime_type: Option<String>,
    #[serde(default)]
    pub size_bytes: Option<f64>,
    #[serde(default)]
    pub content_hash: Option<String>,
    #[serde(default)]
    pub provider_version: Option<String>,
    #[serde(default)]
    pub source_modified_at: Option<String>,
    #[serde(default)]
    pub storage_mode: Option<String>,
    #[serde(default)]
    pub storage_uri: Option<String>,
    #[serde(default)]
    pub storage_provider: Option<String>,
    #[serde(default)]
    pub registration_status: Option<String>,
    #[serde(default)]
    pub raw_storage_status: Option<String>,
    #[serde(default)]
    pub raw_storage_metadata: Option<serde_json::Value>,
    #[serde(default)]
    pub delete_semantics: Option<String>,
    #[serde(default)]
    pub metadata: Option<serde_json::Value>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
    #[serde(default)]
    pub indexed_content_hash: Option<String>,
    #[serde(default)]
    pub indexed_at: Option<String>,
    #[serde(default)]
    pub extraction_status: Option<String>,
    #[serde(default)]
    pub semantic_index_status: Option<String>,
    #[serde(default)]
    pub last_error: Option<serde_json::Value>,
    #[serde(default)]
    pub storage_artifact_id: Option<String>,
}

/// `GET /v1/documents` query string.
#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
pub struct CoreListDocumentsQuery {
    pub user_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
pub struct CoreListDocumentsResponse {
    #[serde(default)]
    pub documents: Vec<CoreDocument>,
    #[serde(default)]
    pub next_cursor: Option<String>,
}

/// `GET /v1/documents/passport-feed` query string.
#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
pub struct CorePassportFeedQuery {
    pub user_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
pub struct CorePassportFeedResponse {
    #[serde(default)]
    pub rows: Vec<serde_json::Value>,
    #[serde(default)]
    pub next_cursor: Option<String>,
}

/// `POST /v1/documents` request body.
#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
pub struct CoreRegisterDocumentRequest {
    pub user_id: String,
    pub source_site: String,
    pub provider: String,
    pub external_id: String,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub consent_policy: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external_uri: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extraction_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retention_policy: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub semantic_index_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_modified_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub storage_mode: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
pub struct CoreRegisterDocumentResponse {
    pub created: bool,
    pub document: CoreDocument,
}

/// `GET /v1/documents/{id}` / `DELETE /v1/documents/{id}` query string.
#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
pub struct CoreDocumentQuery {
    pub user_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
pub struct CoreDeleteDocumentResponse {
    #[serde(default)]
    pub success: bool,
    #[serde(default)]
    pub already_deleted: bool,
}

/// `DELETE /v1/admin/scope` request body.
#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
pub struct CoreAdminDeleteScopeBody {
    pub user_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
pub struct CoreAdminDeleteScopeResponse {
    #[serde(default)]
    pub deleted: i64,
}

// ---------------------------------------------------------------------------
// Stats / audit
// ---------------------------------------------------------------------------

/// `GET /v1/memories/stats` query string.
#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
pub struct CoreStatsQuery {
    pub user_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
pub struct CoreRecentAuditResponse {
    #[serde(default)]
    pub events: serde_json::Value,
    #[serde(flatten)]
    pub extra: serde_json::Value,
}

#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
pub struct CoreAuditSummaryResponse {
    #[serde(flatten)]
    pub summary: serde_json::Value,
}

#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
pub struct CoreStatsResponse {
    pub count: f64,
    pub avg_importance: f64,
    #[serde(default)]
    pub source_distribution: HashMap<String, f64>,
}

// ---------------------------------------------------------------------------
// Document pipeline — new proxy endpoints
// ---------------------------------------------------------------------------

/// `GET /v1/documents/without-memories` query string.
#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
pub struct CoreListDocumentsWithoutMemoriesQuery {
    pub user_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extraction: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub semantic_index: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_storage: Option<String>,
}

/// `POST /v1/documents/{id}/index` request body.
#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
pub struct CoreIndexDocumentRequest {
    pub user_id: String,
    pub text: String,
}

/// `POST /v1/documents/{id}/index` response.
#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
pub struct CoreIndexDocumentResponse {
    pub document_id: String,
    pub indexed_content_hash: String,
    pub chunks_created: f64,
    pub memories_created: f64,
    pub idempotent_skip: bool,
    pub chunker_version: String,
    pub parser_version: String,
}

/// `POST /v1/documents/{id}/extraction-failure` request body.
#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
pub struct CoreMarkExtractionFailureRequest {
    pub user_id: String,
    pub error_code: String,
    pub error_message: String,
}

/// `POST /v1/documents/{id}/index-failure` request body.
#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
pub struct CoreMarkIndexFailureRequest {
    pub user_id: String,
    pub error_code: String,
    pub error_message: String,
}

/// Shared response for both constrained-transition routes
/// (`extraction-failure` and `index-failure`).
#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
pub struct CoreConstrainedTransitionResponse {
    pub document: CoreDocument,
    #[serde(default)]
    pub idempotent: bool,
}

/// `PUT /v1/documents/{id}/raw` query string.
#[derive(Debug, Clone, Deserialize, Serialize, ToSchema, IntoParams)]
pub struct CoreUploadRawQuery {
    pub user_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
}

/// `PUT /v1/documents/{id}/raw` response.
#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
pub struct CoreUploadRawDocumentResponse {
    pub document_id: String,
    pub storage_provider: String,
    pub storage_uri: String,
    pub content_hash: String,
    pub size_bytes: f64,
    pub raw_storage_status: String,
    pub storage_mode: String,
    #[serde(default)]
    pub raw_storage_metadata: serde_json::Value,
    #[serde(default)]
    pub delete_semantics: Option<String>,
    pub idempotent_skip: bool,
}

// ---------------------------------------------------------------------------
// Document limits + legacy list
// ---------------------------------------------------------------------------

/// `GET /v1/documents/limits` response. No request type (no query params).
#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
pub struct CoreDocumentLimitsResponse {
    pub raw_upload_max_bytes: i64,
    pub index_max_text_bytes: i64,
    pub raw_storage: serde_json::Value,
}

/// `GET /v1/documents/list` query (legacy offset-based pagination).
#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
pub struct CoreListDocumentsLegacyQuery {
    pub user_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_site: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offset: Option<String>,
}

/// `GET /v1/documents/list` response (legacy offset-based; different from CoreListDocumentsResponse).
#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
pub struct CoreListDocumentsLegacyResponse {
    #[serde(default)]
    pub count: f64,
    #[serde(default)]
    pub documents: Vec<CoreDocument>,
}

// ---------------------------------------------------------------------------
// Memory audit query types
// ---------------------------------------------------------------------------

/// `GET /v1/memories/audit/recent` query string.
#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
pub struct CoreAuditRecentQuery {
    pub user_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<String>,
}

/// `GET /v1/memories/audit/summary` query string.
#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
pub struct CoreAuditSummaryQuery {
    pub user_id: String,
}

// ---------------------------------------------------------------------------
// Memory ops, reconcile, lessons, per-record audit
// ---------------------------------------------------------------------------

/// `GET /v1/memories/cap` query string.
#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
pub struct CoreMemoryCapQuery {
    pub user_id: String,
}

/// `GET /v1/memories/cap` response.
#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
pub struct CoreMemoryCapResponse {
    pub active_memories: f64,
    pub max_memories: f64,
    pub status: String,
    pub usage_ratio: f64,
    pub recommendation: String,
}

/// `POST /v1/memories/consolidate` request body.
#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
pub struct CoreConsolidateRequest {
    pub user_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execute: Option<bool>,
}

/// `POST /v1/memories/decay` request body.
#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
pub struct CoreDecayRequest {
    pub user_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
}

/// `POST /v1/memories/expand` request body.
#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
pub struct CoreExpandRequest {
    pub user_id: String,
    pub memory_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub visibility: Option<String>,
}

/// `POST /v1/memories/expand` response.
#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
pub struct CoreExpandResponse {
    #[serde(default)]
    pub memories: Vec<CoreMemory>,
}

/// `POST /v1/memories/reset-source` request body.
#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
pub struct CoreResetBySourceRequest {
    pub user_id: String,
    pub source_site: String,
}

/// `POST /v1/memories/reset-source` response.
#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
pub struct CoreResetBySourceResponse {
    pub success: bool,
    pub deleted_memories: f64,
    pub deleted_episodes: f64,
    pub deleted_documents: f64,
}

/// `POST /v1/memories/reconcile` request body (user_id is optional at core level).
#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
pub struct CoreReconcileRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
}

/// `GET /v1/memories/reconcile/status` query string.
#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
pub struct CoreReconcileStatusQuery {
    pub user_id: String,
}

/// `GET /v1/memories/lessons` and `GET /v1/memories/lessons/stats` share this query.
#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
pub struct CoreLessonsQuery {
    pub user_id: String,
}

/// `POST /v1/memories/lessons/report` request body.
#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
pub struct CoreReportLessonRequest {
    pub user_id: String,
    pub pattern: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub severity: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_memory_ids: Option<Vec<String>>,
}

/// `POST /v1/memories/lessons/report` response.
#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
pub struct CoreReportLessonResponse {
    pub lesson_id: String,
}

/// `DELETE /v1/memories/lessons/{id}` query string.
#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
pub struct CoreLessonQuery {
    pub user_id: String,
}

/// `GET /v1/memories/{id}/audit` query string.
#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
pub struct CoreMemoryAuditQuery {
    pub user_id: String,
}

/// Cloud-facing `POST /v1/memories/{id}/supersede` request body.
/// Adapted to enterprise `POST /v1/admin/memories/{id}/correct` at the client layer.
#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
pub struct CoreSupersedeMemoryRequest {
    pub user_id: String,
    pub claim: String,
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f32>,
    /// External correlation id for the enterprise admin act (`ticket` on the wire).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ticket: Option<String>,
}

/// Cloud-facing `POST /v1/memories/{id}/verify` request body.
/// Adapted to enterprise `POST /v1/admin/memories/{id}/correct` (attestation) at the client layer.
#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
pub struct CoreVerifyMemoryRequest {
    pub user_id: String,
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ticket: Option<String>,
}

/// Enterprise `POST /v1/admin/memories/{id}/correct` wire body.
#[derive(Debug, Clone, Serialize)]
pub struct CoreAdminCorrectMemoryRequest {
    pub user_id: String,
    pub actor: String,
    pub reason: String,
    pub ticket: String,
    pub new_content: String,
}

/// `GET /v1/agents/conflicts` query string.
#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
pub struct CoreConflictsQuery {
    pub user_id: String,
}

/// Cloud-facing `PUT /v1/agents/conflicts/{id}/resolve` request body.
/// `action` is mapped to enterprise `resolution` at the client layer.
#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
pub struct CoreResolveConflictRequest {
    pub user_id: String,
    pub action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<String>,
}

/// Enterprise `PUT /v1/agents/conflicts/{id}/resolve` wire body.
#[derive(Debug, Clone, Serialize)]
pub struct CoreEnterpriseResolveConflictRequest {
    pub user_id: String,
    pub resolution: String,
}

/// Map dashboard/gateway conflict actions to enterprise resolution enums.
pub fn map_conflict_action_to_resolution(action: &str) -> Result<&'static str, String> {
    match action {
        "reject" | "keep_existing" | "keep_left" | "resolved_existing" => Ok("resolved_existing"),
        "promote" | "keep_new" | "keep_right" | "resolved_new" => Ok("resolved_new"),
        "resolve_both" | "resolved_both" => Ok("resolved_both"),
        "request_evidence" | "escalate" => Err(format!(
            "conflict action '{action}' is not supported by enterprise core"
        )),
        other => Err(format!("unknown conflict action '{other}'")),
    }
}

/// `POST /v1/agents/conflicts/auto-resolve` request body.
#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
pub struct CoreAutoResolveConflictsRequest {
    pub user_id: String,
}

/// `GET /v1/agents/trust` query string.
#[derive(Debug, Clone, Deserialize, Serialize, ToSchema, IntoParams)]
pub struct CoreAgentTrustQuery {
    pub user_id: String,
    pub agent_id: String,
}

/// `PUT /v1/agents/trust` request body.
#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
pub struct CoreSetAgentTrustRequest {
    pub user_id: String,
    pub agent_id: String,
    pub trust_level: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
}

/// Managed-mode upload query for `POST /v1/storage/artifacts`.
#[derive(Debug, Clone, Deserialize, Serialize, ToSchema, IntoParams, Default)]
pub struct CoreStorageArtifactUploadQuery {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disclose_content_hash: Option<bool>,
}

/// Managed-mode upload query for `POST /v1/storage/artifacts` (strict).
#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
pub struct CoreStorageArtifactManagedQuery {
    pub mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disclose_content_hash: Option<bool>,
}

/// `DELETE /v1/storage/artifacts/{id}` query string.
#[derive(Debug, Clone, Deserialize, Serialize, ToSchema, IntoParams)]
pub struct CoreStorageArtifactDeleteQuery {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub policy: Option<String>,
}

/// Optional per-fact AUDN trace payload from Core ingest (B1 contract).
#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
pub struct CoreIngestAudnTrace {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decision: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decision_stage: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub facts_json: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_memory_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_memory_id: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn core_stats_response_deserializes_openapi_shape() {
        let raw = serde_json::json!({
            "count": 12.0,
            "avg_importance": 0.42,
            "source_distribution": {"manual": 8.0, "extracted": 4.0}
        });
        let parsed: CoreStatsResponse = serde_json::from_value(raw).expect("deserialize stats");
        assert_eq!(parsed.count, 12.0);
        assert_eq!(parsed.avg_importance, 0.42);
        assert_eq!(parsed.source_distribution.get("manual"), Some(&8.0));
    }

    #[test]
    fn core_register_document_request_roundtrips() {
        let request = CoreRegisterDocumentRequest {
            user_id: "project:proj_1".into(),
            source_site: "site".into(),
            provider: "gdrive".into(),
            external_id: "file_1".into(),
            account_id: None,
            consent_policy: None,
            content_hash: None,
            display_name: Some("Notes".into()),
            external_uri: None,
            extraction_status: Some("pending".into()),
            metadata: None,
            mime_type: Some("text/plain".into()),
            provider_version: None,
            retention_policy: None,
            semantic_index_status: Some("pending".into()),
            size_bytes: Some(1024),
            source_modified_at: None,
            storage_mode: Some("pointer_only".into()),
        };
        let value = serde_json::to_value(&request).expect("serialize");
        let back: CoreRegisterDocumentRequest = serde_json::from_value(value).expect("deserialize");
        assert_eq!(back.external_id, "file_1");
        assert_eq!(back.display_name.as_deref(), Some("Notes"));
    }

    #[test]
    fn core_list_documents_response_defaults_empty_documents() {
        let raw = serde_json::json!({"next_cursor": null});
        let parsed: CoreListDocumentsResponse =
            serde_json::from_value(raw).expect("deserialize list");
        assert!(parsed.documents.is_empty());
        assert!(parsed.next_cursor.is_none());
    }

    #[test]
    fn map_conflict_action_to_resolution_maps_dashboard_actions() {
        assert_eq!(
            map_conflict_action_to_resolution("reject").expect("reject"),
            "resolved_existing"
        );
        assert_eq!(
            map_conflict_action_to_resolution("promote").expect("promote"),
            "resolved_new"
        );
        assert!(map_conflict_action_to_resolution("request_evidence").is_err());
        assert!(map_conflict_action_to_resolution("escalate").is_err());
    }
}
