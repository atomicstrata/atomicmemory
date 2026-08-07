//! Organization DTOs and create/update request validation.

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct Organization {
    pub id: String,
    pub clerk_org_id: String,
    pub name: String,
    pub slug: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, validator::Validate, ToSchema)]
pub struct CreateOrgRequest {
    #[validate(length(min = 1, max = 80))]
    pub name: String,
    #[validate(length(min = 1, max = 60), regex(path = *SLUG_RE))]
    pub slug: String,
    #[validate(length(min = 1, max = 128))]
    pub clerk_org_id: String,
    /// Optional Clerk `publicMetadata.accountType` for the organization.
    pub account_type: Option<String>,
}

use std::sync::LazyLock;
pub static SLUG_RE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"^[a-z0-9][a-z0-9-]{0,58}[a-z0-9]$").unwrap());
