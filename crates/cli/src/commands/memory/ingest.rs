//! Ingest helpers for SDK-aligned `text` / `messages` / `verbatim` modes.

use anyhow::{Context, Result, bail};
use serde::Deserialize;
use std::io::{self, Read};

use am_core_types::CoreIngestRequest;

use super::scope::MemoryScope;

#[derive(Debug, Clone, Copy, clap::ValueEnum, Default)]
pub enum SdkIngestMode {
    #[default]
    Text,
    Messages,
    Verbatim,
}

#[derive(Debug, Clone, Copy, clap::ValueEnum)]
pub enum ContentClass {
    Summary,
    Redacted,
    Raw,
}

impl ContentClass {
    pub fn as_str(self) -> &'static str {
        match self {
            ContentClass::Summary => "summary",
            ContentClass::Redacted => "redacted",
            ContentClass::Raw => "raw",
        }
    }
}

#[derive(Debug, Deserialize)]
struct IngestMessage {
    role: String,
    content: String,
}

#[allow(clippy::too_many_arguments)]
pub async fn build_ingest_request(
    mode: SdkIngestMode,
    scope: &MemoryScope,
    source: String,
    content_class: Option<ContentClass>,
    metadata: Option<serde_json::Value>,
    text: Option<String>,
    file: Option<String>,
    stdin: bool,
) -> Result<(CoreIngestRequest, bool)> {
    let is_verbatim = matches!(mode, SdkIngestMode::Verbatim);
    // `--metadata` and `--content-class` only exist on the verbatim quick-ingest
    // wire path. They used to be accepted on every mode and then silently
    // dropped (metadata) or forwarded where the contract does not define them
    // (content class); reject them instead of losing the caller's intent.
    if !is_verbatim {
        if metadata.is_some() {
            bail!(
                "--metadata is only supported with --mode verbatim (the extraction path does not \
                 carry caller metadata); re-run with --mode verbatim to attach it"
            );
        }
        if content_class.is_some() {
            bail!(
                "--content-class is only supported with --mode verbatim (it stamps raw stored \
                 content); the extraction path classifies content itself"
            );
        }
    }
    let conversation = match mode {
        SdkIngestMode::Text | SdkIngestMode::Verbatim => {
            read_text_content(text, file, stdin).await?
        }
        SdkIngestMode::Messages => messages_to_conversation(file, stdin).await?,
    };
    let req = CoreIngestRequest {
        user_id: scope.user_id.clone(),
        source_site: source,
        conversation,
        agent_id: scope.agent_id.clone(),
        workspace_id: scope.workspace_id.clone(),
        session_id: scope.session_id.clone(),
        source_url: None,
        metadata,
        skip_extraction: is_verbatim.then_some(true),
        content_class: content_class.map(|c| c.as_str().to_string()),
        visibility: None,
        config_override: None,
    };
    Ok((req, is_verbatim))
}

async fn read_text_content(
    text: Option<String>,
    file: Option<String>,
    stdin: bool,
) -> Result<String> {
    if let Some(t) = text {
        if t.trim().is_empty() {
            bail!("no content — pass text, --file, or --stdin");
        }
        return Ok(t);
    }
    if let Some(path) = file {
        if path == "-" {
            return read_stdin().await;
        }
        let content = tokio::fs::read_to_string(&path)
            .await
            .with_context(|| format!("read file {path}"))?;
        if content.trim().is_empty() {
            bail!("ingest --file is empty");
        }
        return Ok(content);
    }
    if stdin {
        return read_stdin().await;
    }
    bail!("ingest requires text via positional, --file, or --stdin");
}

async fn messages_to_conversation(file: Option<String>, stdin: bool) -> Result<String> {
    let raw = if let Some(path) = file {
        if path == "-" {
            read_stdin().await?
        } else {
            tokio::fs::read_to_string(&path)
                .await
                .with_context(|| format!("read file {path}"))?
        }
    } else if stdin {
        read_stdin().await?
    } else {
        bail!("ingest --mode messages requires --file or --stdin with JSON");
    };
    let parsed: serde_json::Value =
        serde_json::from_str(&raw).with_context(|| "messages payload is not valid JSON")?;
    let arr = parsed
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("messages payload must be a JSON array"))?;
    let mut lines = Vec::with_capacity(arr.len());
    for item in arr {
        let msg: IngestMessage = serde_json::from_value(item.clone())
            .context("each message must be an object {role, content}")?;
        validate_role(&msg.role)?;
        if msg.content.trim().is_empty() {
            bail!("message.content must be a non-empty string");
        }
        lines.push(format!("{}: {}", msg.role, msg.content));
    }
    if lines.is_empty() {
        bail!("ingest mode messages requires at least one message");
    }
    Ok(lines.join("\n"))
}

fn validate_role(role: &str) -> Result<()> {
    match role {
        "user" | "assistant" | "system" | "tool" => Ok(()),
        other => bail!("message.role must be user|assistant|system|tool; got \"{other}\""),
    }
}

async fn read_stdin() -> Result<String> {
    let mut buf = String::new();
    io::stdin().read_to_string(&mut buf)?;
    if buf.trim().is_empty() {
        bail!("stdin received no input");
    }
    Ok(buf)
}
