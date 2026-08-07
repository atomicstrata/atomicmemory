//! Onboarding status DTOs returned by the Cloud onboarding endpoints.

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::orgs::Organization;
use crate::projects::Project;

#[derive(Debug, Clone, Default, Serialize, Deserialize, ToSchema)]
pub struct EnsureOnboardingRequest {
    /// When true, ensure org membership but do not auto-create the default cloud project.
    /// Used by `am init`, which creates a local project instead.
    #[serde(default)]
    pub skip_default_project: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct EnsureOnboardingResponse {
    pub org: Organization,
    pub projects: Vec<Project>,
    pub created_org: bool,
    pub created_project: bool,
}

/// Derived onboarding state machine snapshot for dashboard and CLI.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct OnboardingStatusResponse {
    pub identity_ready: bool,
    pub workspace_ready: bool,
    pub project_ready: bool,
    pub credential_ready: bool,
    pub runtime_ready: bool,
    pub linked: bool,
    pub verified: bool,
    pub activated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    pub runtime_online_count: u32,
    pub api_key_count: u32,
}
