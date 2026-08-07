//! Connected-local runtime registry wire types.

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use validator::Validate;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum RuntimePresence {
    Online,
    Offline,
}

#[derive(Debug, Clone, Serialize, Deserialize, Validate, ToSchema)]
pub struct RuntimeHeartbeatRequest {
    #[validate(length(min = 1, max = 512))]
    pub core_instance_id: String,
    #[validate(length(max = 128))]
    pub core_version: String,
    #[validate(length(max = 128))]
    pub connector_version: String,
    pub capabilities: Vec<String>,
    #[validate(length(max = 2048), url)]
    pub local_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct RuntimeHeartbeatResponse {
    pub runtime_id: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct RuntimeSummary {
    pub id: String,
    pub project_id: String,
    pub core_instance_id: String,
    pub name: Option<String>,
    pub runtime_type: String,
    pub presence: RuntimePresence,
    pub capabilities: Vec<String>,
    pub core_version: Option<String>,
    pub connector_version: Option<String>,
    pub last_heartbeat_at: Option<chrono::DateTime<chrono::Utc>>,
    pub revoked_at: Option<chrono::DateTime<chrono::Utc>>,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}
