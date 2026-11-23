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
    #[serde(with = "am_core_types::timestamp_serde")]
    pub created_at: time::OffsetDateTime,
    #[serde(default, with = "am_core_types::timestamp_serde::option")]
    pub last_used_at: Option<time::OffsetDateTime>,
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
