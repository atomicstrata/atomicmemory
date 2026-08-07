//! Standard error response shapes.

use utoipa::ToSchema;

pub const CLOUD_DOCS_URL: &str = "/docs";

pub const PROXIED_MEMORY_ROUTES: &[&str] = &[
    "GET /v1/memories/health",
    "POST /v1/memories/ingest",
    "POST /v1/memories/ingest/quick",
    "POST /v1/memories/search",
    "POST /v1/memories/search/fast",
    "GET /v1/memories/list",
    "GET /v1/memories/stats",
    "GET /v1/memories/{id}",
    "GET /v1/documents",
    "POST /v1/documents",
    "GET /v1/documents/passport-feed",
    "GET /v1/documents/{id}",
    "GET /v1/documents/without-memories",
    "POST /v1/documents/{id}/index",
    "POST /v1/documents/{id}/extraction-failure",
    "POST /v1/documents/{id}/index-failure",
    "PUT /v1/documents/{id}/raw",
    "DELETE /v1/memories/{id}",
    "DELETE /v1/documents/{id}",
    "DELETE /v1/admin/scope",
    "GET /v1/documents/limits",
    "GET /v1/documents/list",
    "GET /v1/memories/audit/recent",
    "GET /v1/memories/audit/summary",
    "GET /v1/memories/cap",
    "PUT /v1/memories/config",
    "POST /v1/memories/consolidate",
    "POST /v1/memories/decay",
    "POST /v1/memories/expand",
    "POST /v1/memories/reset-source",
    "POST /v1/memories/reconcile",
    "GET /v1/memories/reconcile/status",
    "GET /v1/memories/lessons",
    "POST /v1/memories/lessons/report",
    "GET /v1/memories/lessons/stats",
    "DELETE /v1/memories/lessons/{id}",
    "GET /v1/memories/{id}/audit",
    "POST /v1/memories/{id}/supersede",
    "POST /v1/memories/{id}/verify",
    "GET /v1/agents/conflicts",
    "PUT /v1/agents/conflicts/{id}/resolve",
    "GET /v1/storage/capabilities",
    "POST /v1/storage/artifacts",
    "GET /v1/storage/artifacts/{id}",
    "DELETE /v1/storage/artifacts/{id}",
    "GET /v1/storage/artifacts/{id}/content",
    "POST /v1/storage/artifacts/{id}/verify",
    "GET /v1/agents/trust",
    "PUT /v1/agents/trust",
    "POST /v1/agents/conflicts/auto-resolve",
];

#[derive(serde::Serialize, ToSchema)]
pub struct ErrorEnvelope {
    pub error: ErrorBody,
}

#[derive(serde::Serialize, ToSchema)]
pub struct ErrorBody {
    pub code: String,
    pub message: String,
}

#[derive(serde::Serialize, ToSchema)]
pub struct NotImplementedEnvelope {
    pub error: String,
    pub error_code: String,
    pub message: String,
    pub supported_routes: Vec<String>,
    pub documentation_url: String,
}

impl NotImplementedEnvelope {
    pub fn for_path(path: &str) -> Self {
        let supported_routes = supported_routes_for(path)
            .iter()
            .map(|route| (*route).to_string())
            .collect();
        Self {
            error: "not implemented in cloud gateway".into(),
            error_code: "not_implemented_in_cloud_gateway".into(),
            message: message_for(path),
            supported_routes,
            documentation_url: CLOUD_DOCS_URL.into(),
        }
    }
}

fn message_for(path: &str) -> String {
    if path.starts_with("/v1/documents") {
        return "This document route is not proxied by the cloud gateway yet. \
                See supported_routes for available document and memory operations."
            .into();
    }
    if path.starts_with("/v1/storage") {
        return "Storage artifact APIs are not available via the cloud gateway. \
                See supported_routes for memory operations."
            .into();
    }
    format!(
        "Route `{path}` is not implemented in the cloud gateway. \
         See supported_routes and documentation_url for available alternatives."
    )
}

fn supported_routes_for(path: &str) -> &'static [&'static str] {
    if path.starts_with("/v1/documents") {
        return &[
            "GET /v1/documents",
            "POST /v1/documents",
            "GET /v1/documents/passport-feed",
            "GET /v1/documents/{id}",
            "DELETE /v1/documents/{id}",
            "POST /v1/memories/ingest",
            "POST /v1/memories/search",
            "GET /v1/memories/list",
        ];
    }
    if path.starts_with("/v1/memories") && !path.contains("health") {
        return &[
            "POST /v1/memories/ingest",
            "POST /v1/memories/search",
            "GET /v1/memories/list",
            "GET /v1/memories/stats",
            "DELETE /v1/memories/{id}",
        ];
    }
    PROXIED_MEMORY_ROUTES
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proxied_routes_include_document_and_stats_surface() {
        assert!(PROXIED_MEMORY_ROUTES.contains(&"GET /v1/memories/stats"));
        assert!(PROXIED_MEMORY_ROUTES.contains(&"GET /v1/documents"));
        assert!(PROXIED_MEMORY_ROUTES.contains(&"POST /v1/documents"));
        assert!(PROXIED_MEMORY_ROUTES.contains(&"GET /v1/documents/passport-feed"));
        assert!(PROXIED_MEMORY_ROUTES.contains(&"GET /v1/documents/{id}"));
    }

    #[test]
    fn document_stub_hint_includes_proxied_document_routes() {
        let envelope = NotImplementedEnvelope::for_path("/v1/documents/limits");
        assert!(envelope.message.contains("document route"));
        assert!(
            envelope
                .supported_routes
                .contains(&"GET /v1/documents".to_string())
        );
        assert!(
            envelope
                .supported_routes
                .contains(&"GET /v1/documents/passport-feed".to_string())
        );
    }

    #[test]
    fn memory_stub_hint_includes_stats_route() {
        let envelope = NotImplementedEnvelope::for_path("/v1/memories/lessons");
        assert!(
            envelope
                .supported_routes
                .contains(&"GET /v1/memories/stats".to_string())
        );
    }
}
