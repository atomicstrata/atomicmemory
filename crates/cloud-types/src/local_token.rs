//! Wire types for local-core JWT mint request/response.

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use validator::Validate;

/// Body for `POST /v1/local/token`.
///
/// Must serialize as a JSON **object**. A unit/`()`/`Option::None` body becomes
/// JSON `null`, which the Cloud API rejects with 422
/// (`expected struct LocalTokenRequest`).
#[derive(Debug, Clone, Serialize, Deserialize, Validate, ToSchema)]
pub struct LocalTokenRequest {
    /// Clerk user id (`sub`) of the project member bound into the Core JWT.
    #[validate(length(min = 1, max = 256))]
    pub memory_user_id: String,
}

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

#[cfg(test)]
mod tests {
    use super::*;
    use validator::Validate;

    #[test]
    fn local_token_request_serializes_as_object_never_null() {
        let req = LocalTokenRequest {
            memory_user_id: "user_clerk_abc".into(),
        };
        let value = serde_json::to_value(&req).expect("serialize");
        assert!(value.is_object(), "must be a JSON object, got {value}");
        assert_eq!(value["memory_user_id"], "user_clerk_abc");
        assert!(!value.is_null());
    }

    #[test]
    fn local_token_request_rejects_empty_memory_user_id() {
        let req = LocalTokenRequest {
            memory_user_id: String::new(),
        };
        assert!(req.validate().is_err());
    }

    #[test]
    fn unit_struct_documents_null_body_regression() {
        // The pre-fix mint path posted a unit struct; serde_json emits null.
        #[derive(Serialize)]
        struct EmptyBody;
        let value = serde_json::to_value(&EmptyBody).expect("serialize");
        assert!(value.is_null());
    }
}
