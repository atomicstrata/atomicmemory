//! HTTP clients for dashboard (`/api/*`) and memory (`/v1/*`) surfaces.

use am_cloud_types::{
    ApiKey, ApiKeyWithSecret, CreateApiKeyRequest, CreateOrgRequest, CreateProjectRequest,
    EnsureOnboardingRequest, EnsureOnboardingResponse, LocalCoreTokenResponse, Memory,
    MemoryWithEvidence, OnboardingStatusResponse, Organization, Project, RuntimeSummary,
    TraceDetail, TraceSummary, UpdateProjectRequest, UsageSummary,
};
use am_core_types::{
    CoreDeleteMemoryResponse, CoreHealthResponse, CoreIngestRequest, CoreIngestResponse,
    CoreListMemoriesQuery, CoreListMemoriesResponse, CoreMemory, CoreMemoryQuery,
    CoreSearchRequest, CoreSearchResponse,
};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use validator::Validate;

use crate::error::CloudClientError;
use crate::transport::HttpTransport;

/// Dashboard project overview (`GET /api/projects/{id}/overview`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectOverview {
    pub project_id: String,
    pub stored_memories: Option<i64>,
    pub active_api_keys: i64,
    pub recent_traces: i64,
    pub usage: UsageSummary,
}

#[derive(Clone)]
pub struct DashboardClient {
    transport: HttpTransport,
}

#[derive(Clone)]
pub struct MemoryClient {
    transport: HttpTransport,
}

impl DashboardClient {
    pub fn new(base_url: Url, bearer_token: impl Into<String>) -> Result<Self, CloudClientError> {
        Ok(Self {
            transport: HttpTransport::new(base_url, bearer_token)?,
        })
    }

    pub fn base_url(&self) -> &Url {
        self.transport.base_url()
    }

    pub async fn list_orgs(&self) -> Result<Vec<Organization>, CloudClientError> {
        self.transport.get("api/orgs", &NoQuery).await
    }

    pub async fn ensure_onboarding(
        &self,
        req: &EnsureOnboardingRequest,
    ) -> Result<EnsureOnboardingResponse, CloudClientError> {
        self.transport.post("api/onboarding/ensure", req).await
    }

    pub async fn onboarding_status(
        &self,
        project_id: Option<&str>,
    ) -> Result<OnboardingStatusResponse, CloudClientError> {
        self.transport
            .get(
                "api/onboarding/status",
                &OnboardingStatusQuery {
                    project_id: project_id.map(str::to_string),
                },
            )
            .await
    }

    pub async fn create_org(
        &self,
        req: &CreateOrgRequest,
    ) -> Result<Organization, CloudClientError> {
        req.validate()
            .map_err(|e| CloudClientError::Validation(e.to_string()))?;
        self.transport.post("api/orgs", req).await
    }

    pub async fn get_org(&self, org_id: &str) -> Result<Organization, CloudClientError> {
        self.transport
            .get(&format!("api/orgs/{org_id}"), &NoQuery)
            .await
    }

    pub async fn list_projects(&self) -> Result<Vec<Project>, CloudClientError> {
        self.transport.get("api/projects", &NoQuery).await
    }

    pub async fn create_project(
        &self,
        req: &CreateProjectRequest,
    ) -> Result<Project, CloudClientError> {
        req.validate()
            .map_err(|e| CloudClientError::Validation(e.to_string()))?;
        self.transport.post("api/projects", req).await
    }

    pub async fn get_project(&self, project_id: &str) -> Result<Project, CloudClientError> {
        self.transport
            .get(&format!("api/projects/{project_id}"), &NoQuery)
            .await
    }

    pub async fn update_project(
        &self,
        project_id: &str,
        req: &UpdateProjectRequest,
    ) -> Result<Project, CloudClientError> {
        req.validate()
            .map_err(|e| CloudClientError::Validation(e.to_string()))?;
        self.transport
            .patch(&format!("api/projects/{project_id}"), req)
            .await
    }

    /// Delete a project. The API answers 204 No Content, so there is no body
    /// to return; a `Result<Project>` here made success look like a decode
    /// failure.
    pub async fn delete_project(&self, project_id: &str) -> Result<(), CloudClientError> {
        self.transport
            .delete_discarding_body(&format!("api/projects/{project_id}"))
            .await
    }

    pub async fn list_api_keys(&self, project_id: &str) -> Result<Vec<ApiKey>, CloudClientError> {
        self.transport
            .get(&format!("api/projects/{project_id}/api-keys"), &NoQuery)
            .await
    }

    pub async fn create_api_key(
        &self,
        project_id: &str,
        req: &CreateApiKeyRequest,
    ) -> Result<ApiKeyWithSecret, CloudClientError> {
        req.validate()
            .map_err(|e| CloudClientError::Validation(e.to_string()))?;
        self.transport
            .post(&format!("api/projects/{project_id}/api-keys"), req)
            .await
    }

    pub async fn rotate_api_key(
        &self,
        project_id: &str,
        key_id: &str,
    ) -> Result<ApiKeyWithSecret, CloudClientError> {
        self.transport
            .post(
                &format!("api/projects/{project_id}/api-keys/{key_id}/rotate"),
                &EmptyBody,
            )
            .await
    }

    pub async fn revoke_api_key(
        &self,
        project_id: &str,
        key_id: &str,
    ) -> Result<(), CloudClientError> {
        self.transport
            .delete_discarding_body(&format!("api/projects/{project_id}/api-keys/{key_id}"))
            .await
    }

    pub async fn list_memories(&self, project_id: &str) -> Result<Vec<Memory>, CloudClientError> {
        self.transport
            .get(&format!("api/projects/{project_id}/memories"), &NoQuery)
            .await
    }

    pub async fn get_memory(
        &self,
        project_id: &str,
        memory_id: &str,
    ) -> Result<MemoryWithEvidence, CloudClientError> {
        self.transport
            .get(
                &format!("api/projects/{project_id}/memories/{memory_id}"),
                &NoQuery,
            )
            .await
    }

    pub async fn list_traces(
        &self,
        project_id: &str,
        limit: Option<i64>,
    ) -> Result<Vec<TraceSummary>, CloudClientError> {
        self.transport
            .get(
                &format!("api/projects/{project_id}/traces"),
                &TraceListQuery { limit },
            )
            .await
    }

    pub async fn get_trace(
        &self,
        project_id: &str,
        trace_id: &str,
    ) -> Result<TraceDetail, CloudClientError> {
        self.transport
            .get(
                &format!("api/projects/{project_id}/traces/{trace_id}"),
                &NoQuery,
            )
            .await
    }

    pub async fn usage(&self, project_id: &str) -> Result<UsageSummary, CloudClientError> {
        self.transport
            .get(&format!("api/projects/{project_id}/usage"), &NoQuery)
            .await
    }

    pub async fn overview(&self, project_id: &str) -> Result<ProjectOverview, CloudClientError> {
        self.transport
            .get(&format!("api/projects/{project_id}/overview"), &NoQuery)
            .await
    }

    pub async fn healthz(&self) -> Result<serde_json::Value, CloudClientError> {
        self.transport.healthz().await
    }

    pub async fn list_runtimes(
        &self,
        project_id: &str,
    ) -> Result<Vec<RuntimeSummary>, CloudClientError> {
        self.transport
            .get(&format!("api/projects/{project_id}/runtimes"), &NoQuery)
            .await
    }

    pub async fn import_memories(
        &self,
        project_id: &str,
        req: &am_cloud_types::ImportMemoriesRequest,
    ) -> Result<am_cloud_types::ImportMemoriesReceipt, CloudClientError> {
        self.transport
            .post(&format!("api/projects/{project_id}/import"), req)
            .await
    }
}

impl MemoryClient {
    pub fn new(base_url: Url, api_key: impl Into<String>) -> Result<Self, CloudClientError> {
        Ok(Self {
            transport: HttpTransport::new(base_url, api_key)?,
        })
    }

    pub fn base_url(&self) -> &Url {
        self.transport.base_url()
    }

    pub async fn health(&self) -> Result<CoreHealthResponse, CloudClientError> {
        match self.transport.get("v1/memories/health", &NoQuery).await {
            Ok(response) => Ok(response),
            Err(CloudClientError::Status { code: 404, .. }) => {
                self.transport.get("health", &NoQuery).await
            }
            Err(err) => Err(err),
        }
    }

    pub async fn ingest(
        &self,
        req: &CoreIngestRequest,
    ) -> Result<CoreIngestResponse, CloudClientError> {
        self.transport.post("v1/memories/ingest", req).await
    }

    pub async fn ingest_quick(
        &self,
        req: &CoreIngestRequest,
    ) -> Result<CoreIngestResponse, CloudClientError> {
        self.transport.post("v1/memories/ingest/quick", req).await
    }

    pub async fn search(
        &self,
        req: &CoreSearchRequest,
    ) -> Result<CoreSearchResponse, CloudClientError> {
        self.transport.post("v1/memories/search", req).await
    }

    pub async fn search_fast(
        &self,
        req: &CoreSearchRequest,
    ) -> Result<CoreSearchResponse, CloudClientError> {
        self.transport.post("v1/memories/search/fast", req).await
    }

    pub async fn list_memories(
        &self,
        query: &CoreListMemoriesQuery,
    ) -> Result<CoreListMemoriesResponse, CloudClientError> {
        self.transport.get("v1/memories/list", query).await
    }

    pub async fn get_memory(
        &self,
        id: &str,
        query: &CoreMemoryQuery,
    ) -> Result<CoreMemory, CloudClientError> {
        self.transport
            .get(&format!("v1/memories/{id}"), query)
            .await
    }

    pub async fn delete_memory(
        &self,
        id: &str,
        query: &CoreMemoryQuery,
    ) -> Result<CoreDeleteMemoryResponse, CloudClientError> {
        self.transport
            .delete(&format!("v1/memories/{id}"), query)
            .await
    }

    /// Mint a short-lived JWT for headless access to a connected-local Core (`POST /v1/local/token`).
    pub async fn mint_local_token(&self) -> Result<LocalCoreTokenResponse, CloudClientError> {
        self.transport.post("v1/local/token", &EmptyBody).await
    }
}

#[derive(Serialize)]
struct NoQuery;

#[derive(Serialize)]
struct OnboardingStatusQuery {
    #[serde(skip_serializing_if = "Option::is_none")]
    project_id: Option<String>,
}

#[derive(Serialize)]
struct EmptyBody;

#[derive(Serialize)]
struct TraceListQuery {
    #[serde(skip_serializing_if = "Option::is_none")]
    limit: Option<i64>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use am_cloud_types::{CreateOrgRequest, ProjectType};

    #[tokio::test]
    async fn create_org_rejects_invalid_slug_before_http() {
        let client = DashboardClient::new(
            Url::parse("https://api.example.com").expect("url"),
            "test-token",
        )
        .expect("client");

        let req = CreateOrgRequest {
            name: "Test".into(),
            slug: "INVALID SLUG".into(),
            clerk_org_id: "org_123".into(),
            account_type: None,
        };

        let err = client.create_org(&req).await.expect_err("validation");
        assert!(matches!(err, CloudClientError::Validation(_)));
    }

    #[tokio::test]
    async fn create_project_rejects_missing_local_url_before_http() {
        let client = DashboardClient::new(
            Url::parse("https://api.example.com").expect("url"),
            "test-token",
        )
        .expect("client");

        let req = CreateProjectRequest {
            name: "Local".into(),
            slug: "local".into(),
            org_id: "org_1".into(),
            environment: "prod".into(),
            kind: ProjectType::Local,
            local_url: None,
        };

        let err = client.create_project(&req).await.expect_err("validation");
        assert!(matches!(err, CloudClientError::Validation(_)));
    }
}
