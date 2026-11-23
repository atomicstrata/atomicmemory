//! Memory DTOs.

use am_core_types::CoreMemory;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct Memory {
    pub id: String,
    pub project_id: String,
    pub claim: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub status: String,
    pub trust_score: f32,
    pub scope: serde_json::Value,
    pub source_type: String,
    #[serde(with = "am_core_types::observation_serde")]
    #[schema(value_type = String, format = DateTime)]
    pub created_at: tz::UtcDateTime,
    #[serde(with = "am_core_types::observation_serde")]
    #[schema(value_type = String, format = DateTime)]
    pub updated_at: tz::UtcDateTime,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct MemoryWithEvidence {
    #[serde(flatten)]
    pub memory: Memory,
    pub evidence: Vec<Evidence>,
}

fn normalize_memory_kind(raw: Option<String>) -> String {
    match raw {
        Some(s) if !s.is_empty() => s.replace('_', "-"),
        _ => "fact".to_string(),
    }
}

fn map_memory_status(raw: Option<String>) -> String {
    match raw.as_deref() {
        Some("needs_clarification") => "low-trust".to_string(),
        Some("active") => "active".to_string(),
        Some(s) if !s.is_empty() => s.to_string(),
        _ => "active".to_string(),
    }
}

/// Map memory observations without losing represented leap seconds; clock failures stay explicit.
pub fn core_memory_to_memory(
    core: CoreMemory,
    project_id: &str,
) -> Result<Memory, am_core_types::timestamp_serde::ParseError> {
    let mut scope = serde_json::Map::new();
    if let Some(s) = core.session_id.as_deref() {
        scope.insert("user".into(), serde_json::Value::String(s.to_string()));
    }
    if let Some(s) = core.workspace_id.as_deref() {
        scope.insert("workspace".into(), serde_json::Value::String(s.to_string()));
    }
    if let Some(s) = core.agent_id.as_deref() {
        scope.insert("agent".into(), serde_json::Value::String(s.to_string()));
    }
    let now =
        tz::UtcDateTime::now().map_err(|_| am_core_types::timestamp_serde::ParseError::Invalid)?;
    Ok(Memory {
        id: core.id,
        project_id: project_id.to_string(),
        claim: core.content,
        kind: normalize_memory_kind(core.kind),
        status: map_memory_status(core.status),
        trust_score: core.importance.unwrap_or(1.0),
        scope: serde_json::Value::Object(scope),
        source_type: core.source_site.unwrap_or_else(|| "core".to_string()),
        created_at: core.created_at.unwrap_or(now),
        updated_at: core
            .updated_at
            .unwrap_or_else(|| core.created_at.unwrap_or(now)),
    })
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct Evidence {
    pub id: String,
    pub source_type: String,
    pub source_uri: Option<String>,
    pub raw_excerpt: Option<String>,
    pub author_type: Option<String>,
    pub confidence: Option<f32>,
    #[serde(with = "am_core_types::observation_serde")]
    #[schema(value_type = String, format = DateTime)]
    pub created_at: tz::UtcDateTime,
}

/// Decode evidence timestamps without replacing valid legacy observations with the current time.
pub fn evidence_from_core_metadata(
    metadata: &serde_json::Value,
) -> Result<Vec<Evidence>, am_core_types::timestamp_serde::ParseError> {
    let now =
        tz::UtcDateTime::now().map_err(|_| am_core_types::timestamp_serde::ParseError::Invalid)?;
    let mut out = Vec::new();

    if let Some(items) = metadata.get("evidence").and_then(|v| v.as_array()) {
        for (idx, item) in items.iter().enumerate() {
            out.push(map_evidence_item(item, idx, now)?);
        }
    }

    if out.is_empty()
        && let Some(items) = metadata.get("links").and_then(|v| v.as_array())
    {
        for (idx, item) in items.iter().enumerate() {
            out.push(map_evidence_item(item, idx, now)?);
        }
    }

    Ok(out)
}

fn map_evidence_item(
    item: &serde_json::Value,
    idx: usize,
    now: tz::UtcDateTime,
) -> Result<Evidence, am_core_types::timestamp_serde::ParseError> {
    let created_at = match item.get("created_at").and_then(|value| value.as_str()) {
        // Metadata historically used strict RFC3339, unlike saved DTO serde's
        // extended-year grammar. Keep that fallback boundary unchanged.
        Some(value)
            if value.as_bytes().get(4) == Some(&b'-')
                && value.as_bytes()[..4].iter().all(u8::is_ascii_digit) =>
        {
            match am_core_types::observation_serde::parse(value) {
                Ok(at) => at,
                // Preserve the existing free-form metadata fallback. Valid leap
                // observations are native values and never take this path.
                Err(am_core_types::timestamp_serde::ParseError::Invalid) => now,
                Err(error) => return Err(error),
            }
        }
        _ => now,
    };
    let id = item
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or(&format!("evidence_{idx}"))
        .to_string();
    Ok(Evidence {
        id,
        source_type: item
            .get("source_type")
            .or_else(|| item.get("type"))
            .and_then(|v| v.as_str())
            .unwrap_or("core")
            .to_string(),
        source_uri: item
            .get("source_uri")
            .or_else(|| item.get("uri"))
            .and_then(|v| v.as_str())
            .map(str::to_string),
        raw_excerpt: item
            .get("raw_excerpt")
            .or_else(|| item.get("excerpt"))
            .or_else(|| item.get("quote"))
            .and_then(|v| v.as_str())
            .map(str::to_string),
        author_type: item
            .get("author_type")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        confidence: item
            .get("confidence")
            .and_then(|v| v.as_f64())
            .map(|v| v as f32),
        created_at,
    })
}

pub fn scope_hash(scope: &serde_json::Value) -> String {
    use sha2::{Digest, Sha256};
    let canonical = canonicalize(scope);
    let mut h = Sha256::new();
    h.update(canonical.as_bytes());
    let out = h.finalize();
    hex::encode(&out[..8])
}

fn canonicalize(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::Object(map) => {
            let mut entries: Vec<_> = map.iter().collect();
            entries.sort_by(|a, b| a.0.cmp(b.0));
            let inner: Vec<String> = entries
                .into_iter()
                .map(|(k, v)| format!("{:?}:{}", k, canonicalize(v)))
                .collect();
            format!("{{{}}}", inner.join(","))
        }
        serde_json::Value::Array(arr) => {
            let inner: Vec<String> = arr.iter().map(canonicalize).collect();
            format!("[{}]", inner.join(","))
        }
        other => other.to_string(),
    }
}
