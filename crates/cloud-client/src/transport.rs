//! Shared HTTP transport for cloud API clients.

use std::time::{Duration, Instant};

use reqwest::{Method, Url};
use serde::{Serialize, de::DeserializeOwned};
use tracing::{Instrument, debug, info_span};

use crate::error::CloudClientError;
use crate::redact::redact_secrets;

const USER_AGENT: &str = concat!("am-cloud-client/", env!("CARGO_PKG_VERSION"));
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_ERROR_BODY_BYTES: usize = 8192;

#[derive(Clone)]
pub struct HttpTransport {
    base_url: Url,
    auth_header: String,
    http: reqwest::Client,
}

impl HttpTransport {
    pub fn new(base_url: Url, bearer_token: impl Into<String>) -> Result<Self, CloudClientError> {
        let base_url = normalize_base(base_url);
        let http = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .timeout(DEFAULT_TIMEOUT)
            .build()?;
        Ok(Self {
            base_url,
            auth_header: format!("Bearer {}", bearer_token.into()),
            http,
        })
    }

    /// Set an explicit request deadline for operations with a larger work budget.
    pub fn with_timeout(mut self, timeout: Duration) -> Result<Self, CloudClientError> {
        self.http = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .timeout(timeout)
            .build()?;
        Ok(self)
    }

    pub fn base_url(&self) -> &Url {
        &self.base_url
    }

    pub async fn get<Q, R>(&self, path: &str, query: &Q) -> Result<R, CloudClientError>
    where
        Q: Serialize,
        R: DeserializeOwned,
    {
        self.send(Method::GET, path, Some(query), None::<&()>).await
    }

    pub async fn post<B, R>(&self, path: &str, body: &B) -> Result<R, CloudClientError>
    where
        B: Serialize,
        R: DeserializeOwned,
    {
        self.send(Method::POST, path, None::<&()>, Some(body)).await
    }

    pub async fn patch<B, R>(&self, path: &str, body: &B) -> Result<R, CloudClientError>
    where
        B: Serialize,
        R: DeserializeOwned,
    {
        self.send(Method::PATCH, path, None::<&()>, Some(body))
            .await
    }

    pub async fn delete<Q, R>(&self, path: &str, query: &Q) -> Result<R, CloudClientError>
    where
        Q: Serialize,
        R: DeserializeOwned,
    {
        self.send(Method::DELETE, path, Some(query), None::<&()>)
            .await
    }

    /// DELETE that discards the response body.
    ///
    /// The Cloud API answers destructive operations with `204 No Content`. This
    /// previously deserialized into a caller-chosen type, so an empty body
    /// became `serde_json::Value::Null`, failed to decode into `Project` or
    /// `ApiKey`, and the CLI reported failure for a server action that had
    /// already succeeded - the worst direction for a delete to be wrong in.
    pub async fn delete_discarding_body(&self, path: &str) -> Result<(), CloudClientError> {
        let _: serde_json::Value = self
            .send(Method::DELETE, path, None::<&()>, None::<&()>)
            .await?;
        Ok(())
    }

    pub async fn healthz(&self) -> Result<serde_json::Value, CloudClientError> {
        self.get("healthz", &NoQuery).await
    }

    async fn send<Q, B, R>(
        &self,
        method: Method,
        path: &str,
        query: Option<&Q>,
        body: Option<&B>,
    ) -> Result<R, CloudClientError>
    where
        Q: Serialize,
        B: Serialize,
        R: DeserializeOwned,
    {
        let url = self
            .base_url
            .join(path)
            .map_err(|e| CloudClientError::InvalidPath {
                path: path.to_string(),
                message: e.to_string(),
            })?;
        let span = info_span!(
            "cloud.request",
            method = %method,
            endpoint = path,
            status = tracing::field::Empty,
            latency_ms = tracing::field::Empty,
        );

        async move {
            let started = Instant::now();
            let mut req = self
                .http
                .request(method.clone(), url)
                .header(reqwest::header::AUTHORIZATION, &self.auth_header)
                .header(reqwest::header::ACCEPT, "application/json")
                .header("X-AtomicMemory-Client", USER_AGENT);

            if let Some(q) = query {
                req = req.query(q);
            }
            if let Some(b) = body {
                req = req.json(b);
            }

            let resp = req.send().await.map_err(|e| {
                if e.is_timeout() {
                    CloudClientError::Timeout
                } else {
                    CloudClientError::Network(redact_secrets(&e.without_url().to_string()))
                }
            })?;

            let status = resp.status();
            let elapsed_ms = started.elapsed().as_millis() as u64;
            tracing::Span::current().record("status", status.as_u16());
            tracing::Span::current().record("latency_ms", elapsed_ms);

            if !status.is_success() {
                // Server bodies can contain arbitrary PII. Keep them out of tracing;
                // expose only a bounded, redacted excerpt in the returned error.
                debug!(
                    status = status.as_u16(),
                    latency_ms = elapsed_ms,
                    "cloud request failed"
                );
                let body =
                    read_error_body(resp)
                        .await
                        .map_err(|error| CloudClientError::Status {
                            code: status.as_u16(),
                            body: format!(
                                "{method} {}: could not read error response: {error}",
                                redact_secrets(path)
                            ),
                        })?;
                let credential = self.auth_header.strip_prefix("Bearer ").unwrap_or("");
                let body = if credential.is_empty() {
                    body
                } else {
                    body.replace(credential, "<redacted>")
                };
                let error = CloudClientError::from_response_body(status.as_u16(), &body);
                return Err(match error {
                    CloudClientError::Status { code, body } => CloudClientError::Status {
                        code,
                        body: format!("{method} {}: {body}", redact_secrets(path)),
                    },
                    error => error,
                });
            }

            let bytes = resp.bytes().await?;
            let value: serde_json::Value = if bytes.is_empty() {
                serde_json::Value::Null
            } else {
                serde_json::from_slice(&bytes)
                    .map_err(|e| CloudClientError::Decode(redact_secrets(&e.to_string())))?
            };

            debug!(latency_ms = elapsed_ms, "cloud request ok");
            serde_json::from_value::<R>(value)
                .map_err(|e| CloudClientError::Decode(redact_secrets(&e.to_string())))
        }
        .instrument(span)
        .await
    }
}

async fn read_error_body(mut response: reqwest::Response) -> Result<String, CloudClientError> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| {
        if error.is_timeout() {
            CloudClientError::Timeout
        } else {
            CloudClientError::Network(redact_secrets(&error.without_url().to_string()))
        }
    })? {
        let remaining = MAX_ERROR_BODY_BYTES - bytes.len();
        bytes.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
        if bytes.len() == MAX_ERROR_BODY_BYTES {
            let mut body = String::from_utf8_lossy(&bytes).into_owned();
            body.push_str(" … [truncated]");
            return Ok(body);
        }
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn normalize_base(mut url: Url) -> Url {
    if !url.path().ends_with('/') {
        let mut p = url.path().to_string();
        p.push('/');
        url.set_path(&p);
    }
    url
}

#[derive(Serialize)]
struct NoQuery;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_base_appends_trailing_slash() {
        let base = Url::parse("http://localhost:8080").unwrap();
        assert!(normalize_base(base).path().ends_with('/'));
    }
}
