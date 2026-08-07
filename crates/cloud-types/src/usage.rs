//! Usage DTOs.

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct UsageSummary {
    pub project_id: String,
    pub ingest_requests: i64,
    pub search_requests: i64,
    pub package_requests: i64,
    pub embedding_operations: i64,
    pub provider_calls: i64,
    /// Memory count from core. `None` when core is unreachable — render as
    /// "Unavailable" rather than a misleading 0.
    pub stored_memories: Option<i64>,
    pub stored_traces: i64,
    #[serde(default)]
    pub tokens_processed: i64,
    #[serde(default)]
    pub storage_bytes: i64,
}

/// One day of request-volume counts for the usage chart.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct UsageSeriesPoint {
    /// UTC calendar day, formatted `YYYY-MM-DD`.
    pub date: String,
    pub ingest_requests: i64,
    pub search_requests: i64,
    pub package_requests: i64,
}
