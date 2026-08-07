//! Errors for the cloud HTTP client.

use thiserror::Error;

#[derive(Debug, Error)]
pub enum CloudClientError {
    #[error("invalid request: {0}")]
    Validation(String),

    #[error("invalid cloud base url: {0}")]
    InvalidBaseUrl(#[from] url::ParseError),

    #[error("http client build failed: {0}")]
    HttpClient(#[from] reqwest::Error),

    #[error("invalid path `{path}`: {message}")]
    InvalidPath { path: String, message: String },

    #[error("authentication failed (401/403)")]
    Auth,

    #[error(
        "session has no active organization — run `am auth login` with an org selected, or `am init`"
    )]
    NoActiveOrganization,

    #[error("request timed out")]
    Timeout,

    #[error("network error: {0}")]
    Network(String),

    #[error("server returned {code}: {body}")]
    Status { code: u16, body: String },

    #[error("response decode error: {0}")]
    Decode(String),
}

impl CloudClientError {
    pub fn from_status(code: u16, body: serde_json::Value) -> Self {
        let error_code = body
            .get("error")
            .and_then(|e| e.get("code"))
            .and_then(|c| c.as_str());
        if code == 403 && error_code == Some("no_active_organization") {
            return Self::NoActiveOrganization;
        }
        if code == 401 || code == 403 {
            return Self::Auth;
        }
        Self::Status {
            code,
            body: crate::redact::redact_secrets(&body.to_string()),
        }
    }

    /// Exit code category for CLI scripting (see `am` README).
    pub fn exit_code(&self) -> i32 {
        match self {
            Self::Auth | Self::NoActiveOrganization => 2,
            Self::Timeout | Self::Network(_) => 3,
            Self::Status { .. } => 4,
            Self::InvalidBaseUrl(_)
            | Self::HttpClient(_)
            | Self::InvalidPath { .. }
            | Self::Decode(_)
            | Self::Validation(_) => 1,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn from_status_maps_no_active_organization() {
        let err = CloudClientError::from_status(
            403,
            json!({"error": {"code": "no_active_organization", "message": "session has no active organization"}}),
        );
        assert!(matches!(err, CloudClientError::NoActiveOrganization));
    }

    #[test]
    fn from_status_maps_generic_forbidden_to_auth() {
        let err = CloudClientError::from_status(403, json!({"error": {"code": "forbidden"}}));
        assert!(matches!(err, CloudClientError::Auth));
    }
}
