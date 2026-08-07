//! OAuth 2.0 device authorization grant (RFC 8628) wire types.

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Debug, Clone, Default, Serialize, Deserialize, ToSchema)]
pub struct DeviceAuthorizeRequest {
    #[serde(default)]
    pub client_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct DeviceAuthorizeResponse {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub verification_uri_complete: String,
    pub expires_in: u64,
    pub interval: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct DeviceTokenRequest {
    pub device_code: String,
    #[serde(default)]
    pub client_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct DeviceTokenResponse {
    pub id_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    pub token_type: String,
    pub expires_in: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct DeviceTokenErrorResponse {
    pub error: String,
    #[serde(default)]
    pub error_description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct DeviceActivateRequest {
    pub user_code: String,
    #[serde(default)]
    pub id_token: Option<String>,
    #[serde(default)]
    pub refresh_token: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct DeviceActivateResponse {
    pub activated: bool,
}
