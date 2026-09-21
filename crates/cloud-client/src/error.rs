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

    #[error("authentication failed (401)")]
    Auth,

    #[error("forbidden (403; {code})")]
    Forbidden { code: String },

    #[error(
        "session has no active organization (403; no_active_organization) — run `am auth login` with an org selected, or `am init`"
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
    /// Classify a JSON server error while redacting its diagnostic excerpt.
    pub fn from_status(code: u16, body: serde_json::Value) -> Self {
        Self::from_response_body(code, &body.to_string())
    }

    /// Classify JSON or plain-text HTTP failures without discarding server diagnostics.
    pub fn from_response_body(code: u16, raw: &str) -> Self {
        let body = serde_json::from_str::<serde_json::Value>(raw).ok();
        let error_code = body
            .as_ref()
            .and_then(|body| body.get("error"))
            .and_then(|e| e.get("code"))
            .and_then(|c| c.as_str());
        if code == 403 && error_code == Some("no_active_organization") {
            return Self::NoActiveOrganization;
        }
        if code == 401 {
            return Self::Auth;
        }
        if code == 403 {
            return Self::Forbidden {
                code: crate::redact::error_excerpt(error_code.unwrap_or("forbidden")),
            };
        }
        let excerpt = crate::redact::error_excerpt(raw);
        Self::Status {
            code,
            body: match error_code {
                Some(error_code) => {
                    format!("{}: {excerpt}", crate::redact::error_excerpt(error_code))
                }
                None => excerpt,
            },
        }
    }

    /// Exit code category for CLI scripting (see `am` README).
    pub fn exit_code(&self) -> i32 {
        match self {
            Self::Auth | Self::Forbidden { .. } | Self::NoActiveOrganization => 2,
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
    fn status_preserves_code_even_when_the_excerpt_is_truncated() {
        let body = format!(
            r#"{{"detail":"{}","error":{{"code":"validation_error"}}}}"#,
            "x".repeat(2000)
        );
        let error = CloudClientError::from_response_body(422, &body);
        assert!(error.to_string().contains("validation_error"));
        assert!(error.to_string().len() < 1500);
    }

    #[test]
    fn from_status_maps_no_active_organization() {
        let err = CloudClientError::from_status(
            403,
            json!({"error": {"code": "no_active_organization", "message": "session has no active organization"}}),
        );
        assert!(matches!(err, CloudClientError::NoActiveOrganization));
        assert!(err.to_string().contains("403"));
        assert!(err.to_string().contains("no_active_organization"));
    }

    #[test]
    fn from_status_maps_generic_forbidden() {
        let err = CloudClientError::from_status(403, json!({"error": {"code": "forbidden"}}));
        assert!(matches!(
            err,
            CloudClientError::Forbidden { ref code } if code == "forbidden"
        ));
        assert!(err.to_string().contains("forbidden"));
        assert!(err.to_string().contains("403"));
    }

    #[test]
    fn from_status_maps_401_to_auth() {
        let err = CloudClientError::from_status(401, json!({"error": {"code": "unauthorized"}}));
        assert!(matches!(err, CloudClientError::Auth));
    }
}
