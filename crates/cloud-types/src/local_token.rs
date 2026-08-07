//! Wire types for local-core JWT mint responses.

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct LocalCoreTokenResponse {
    pub access_token: String,
    pub token_type: String,
    pub expires_in: u64,
}

impl LocalCoreTokenResponse {
    pub fn new(access_token: String, expires_in: u64) -> Self {
        Self {
            access_token,
            token_type: "Bearer".to_string(),
            expires_in,
        }
    }
}
