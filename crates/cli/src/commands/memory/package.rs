//! `am memory package` — token-budgeted context packaging via Core search.

use anyhow::{Result, bail};
use serde::Serialize;

use am_core_types::CoreSearchRequest;

use crate::cli::GlobalOptions;
use crate::commands::client::memory_client;
use crate::commands::memory::scope::resolve_memory_scope;
use crate::envelope::EmitContext;
use crate::output::emit_command;

#[derive(Debug, Clone, Copy, clap::ValueEnum, Default)]
pub enum PackageFormat {
    #[default]
    Flat,
    Tiered,
    Structured,
}

impl PackageFormat {
    fn retrieval_mode(self) -> &'static str {
        match self {
            PackageFormat::Flat => "flat",
            PackageFormat::Tiered => "tiered",
            PackageFormat::Structured => "abstract-aware",
        }
    }

    fn label(self) -> &'static str {
        match self {
            PackageFormat::Flat => "flat",
            PackageFormat::Tiered => "tiered",
            PackageFormat::Structured => "structured",
        }
    }
}

#[derive(Debug, Clone, Copy, clap::ValueEnum)]
pub enum PackageSection {
    Header,
    Inline,
    Footer,
}

impl PackageSection {
    fn label(self) -> &'static str {
        match self {
            PackageSection::Header => "header",
            PackageSection::Inline => "inline",
            PackageSection::Footer => "footer",
        }
    }
}

#[derive(Debug, Serialize, Clone)]
pub struct PackageResponse {
    pub text: String,
    pub tokens: i64,
    pub hits: Vec<PackageHit>,
    pub budget_constrained: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct PackageHit {
    pub id: String,
    pub content: String,
    pub score: f32,
}

#[allow(clippy::too_many_arguments)]
pub async fn run_package(
    global: &GlobalOptions,
    query: String,
    token_budget: Option<i64>,
    format: Option<PackageFormat>,
    section: Option<PackageSection>,
    limit: Option<i64>,
    session: Option<String>,
    agent_id: Option<String>,
    workspace: Option<String>,
) -> Result<()> {
    if query.trim().is_empty() {
        bail!("package requires a query");
    }
    let scope = resolve_memory_scope(global, session, agent_id, workspace)?;
    let (_profile, client) = memory_client(global).await?;
    let req = CoreSearchRequest {
        user_id: scope.user_id,
        query: query.clone(),
        limit,
        threshold: None,
        token_budget,
        retrieval_mode: format.map(|f| f.retrieval_mode().to_string()),
        skip_repair: Some(true),
        source_site: None,
        agent_id: scope.agent_id,
        workspace_id: scope.workspace_id,
        session_id: scope.session_id,
        visibility: None,
        as_of: None,
        namespace_scope: scope.namespace_scope,
        config_override: None,
    };
    let resp = client.search(&req).await?;
    let budget_constrained = resp.budget_constrained;
    let hits: Vec<PackageHit> = resp
        .memories
        .iter()
        .map(|hit| PackageHit {
            id: hit.memory.id.clone(),
            content: hit.memory.content.clone(),
            score: hit.best_score(),
        })
        .collect();
    let data = PackageResponse {
        text: resp.injection_text.unwrap_or_default(),
        tokens: resp.estimated_context_tokens.unwrap_or(0),
        hits,
        budget_constrained,
    };
    let mut meta = serde_json::Map::new();
    if let Some(budget) = token_budget {
        meta.insert("token_budget".into(), budget.into());
    }
    if let Some(fmt) = format {
        meta.insert(
            "format".into(),
            serde_json::Value::String(fmt.label().into()),
        );
    }
    if let Some(sec) = section {
        meta.insert(
            "section".into(),
            serde_json::Value::String(sec.label().into()),
        );
    }
    meta.insert("budget_constrained".into(), budget_constrained.into());
    let ctx = EmitContext::new("memory package", global).with_meta(serde_json::Value::Object(meta));
    emit_command(global, &ctx, &data, Some(data.hits.len() as i32))
}
