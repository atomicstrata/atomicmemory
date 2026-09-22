//! Readiness probes for managed `am-slm` (`/health` + `/v1/models`).

use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use serde::Deserialize;

use super::{SLM_CHAT_MODEL, SLM_EMBED_MODEL};

/// Required model advertisement for Connected Local SLM.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct RequiredModels {
    pub chat: bool,
    pub embed: bool,
}

impl RequiredModels {
    pub fn ready(self) -> bool {
        self.chat && self.embed
    }
}

#[derive(Debug, Deserialize)]
struct ModelsResponse {
    data: Vec<ModelEntry>,
}

#[derive(Debug, Deserialize)]
struct ModelEntry {
    id: String,
}

/// Probe `/health` and `/v1/models` once.
pub async fn check_ready(client: &reqwest::Client, endpoint: &str) -> Result<RequiredModels> {
    let health_url = format!("{}/health", endpoint.trim_end_matches('/'));
    let health = client
        .get(&health_url)
        .send()
        .await
        .with_context(|| format!("GET {health_url}"))?;
    if !health.status().is_success() {
        bail!("am-slm /health returned HTTP {}", health.status());
    }

    let models_url = format!("{}/v1/models", endpoint.trim_end_matches('/'));
    let response = client
        .get(&models_url)
        .send()
        .await
        .with_context(|| format!("GET {models_url}"))?;
    if !response.status().is_success() {
        bail!("am-slm /v1/models returned HTTP {}", response.status());
    }
    let body: ModelsResponse = response
        .json()
        .await
        .context("parse am-slm /v1/models JSON")?;
    let ids: Vec<&str> = body.data.iter().map(|m| m.id.as_str()).collect();
    Ok(RequiredModels {
        chat: ids.contains(&SLM_CHAT_MODEL),
        embed: ids.contains(&SLM_EMBED_MODEL),
    })
}

/// Poll until both required models are advertised, or `timeout` elapses.
pub async fn wait_until_ready(
    client: &reqwest::Client,
    endpoint: &str,
    timeout: Duration,
) -> Result<()> {
    let started = Instant::now();
    let mut last_err: Option<anyhow::Error> = None;
    while started.elapsed() < timeout {
        match check_ready(client, endpoint).await {
            Ok(models) if models.ready() => return Ok(()),
            Ok(models) => {
                last_err = Some(anyhow::anyhow!(
                    "am-slm /v1/models missing required ids (chat={} embed={} need {SLM_CHAT_MODEL} + {SLM_EMBED_MODEL})",
                    models.chat,
                    models.embed
                ));
            }
            Err(err) => last_err = Some(err),
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    Err(last_err.unwrap_or_else(|| anyhow::anyhow!("am-slm readiness timed out after {timeout:?}")))
        .context("wait for am-slm /health + /v1/models")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn required_models_ready_requires_both() {
        assert!(
            !RequiredModels {
                chat: true,
                embed: false
            }
            .ready()
        );
        assert!(
            RequiredModels {
                chat: true,
                embed: true
            }
            .ready()
        );
    }
}
