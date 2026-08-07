//! API key DTOs.

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ApiKey {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub prefix: String,
    pub status: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub last_used_at: Option<chrono::DateTime<chrono::Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ApiKeyWithSecret {
    #[serde(flatten)]
    pub key: ApiKey,
    pub secret: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, validator::Validate, ToSchema)]
pub struct CreateApiKeyRequest {
    #[validate(length(min = 1, max = 80))]
    pub name: String,
    #[validate(length(min = 1, max = 20))]
    pub environment: Option<String>,
}
