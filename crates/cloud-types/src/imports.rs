//! Local → Cloud memory import DTOs.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

pub const IMPORT_SCHEMA_VERSION: i32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ExportMemoryRecord {
    pub schema_version: i32,
    pub memory_id: String,
    pub user_id: String,
    pub content: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub claim: String,
    #[serde(default)]
    pub scope: ExportMemoryScope,
    pub source_site: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<DateTime<Utc>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<DateTime<Utc>>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub evidence: Vec<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checksum: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, ToSchema)]
pub struct ExportMemoryScope {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ExportManifest {
    #[serde(rename = "type")]
    pub kind: String,
    pub schema_version: i32,
    pub exported_at: DateTime<Utc>,
    pub project_slug: String,
    pub record_count: usize,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, ToSchema)]
pub struct ImportSource {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_project_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub export_checksum: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ImportMode {
    #[default]
    Merge,
    ReplaceScope,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ImportMemoriesRequest {
    pub schema_version: i32,
    #[serde(default)]
    pub source: ImportSource,
    #[serde(default)]
    pub mode: ImportMode,
    pub records: Vec<ExportMemoryRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ImportMemoriesReceipt {
    pub batch_id: String,
    pub imported: i64,
    pub skipped: i64,
    pub failed: i64,
}

/// Canonical checksum for export/import tamper detection.
pub fn record_checksum(record: &ExportMemoryRecord) -> String {
    use sha2::{Digest, Sha256};
    let payload = serde_json::json!({
        "schema_version": record.schema_version,
        "memory_id": record.memory_id,
        "user_id": record.user_id,
        "content": record.content,
        "claim": record.claim,
        "scope": record.scope,
        "source_site": record.source_site,
    });
    let bytes = serde_json::to_vec(&payload).unwrap_or_default();
    let digest = Sha256::digest(bytes);
    format!("sha256:{}", hex::encode(digest))
}
