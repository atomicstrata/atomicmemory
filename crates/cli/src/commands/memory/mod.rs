//! `am memory` — ingest, search, list, get, delete, and package memories.

mod ingest;
mod package;
pub mod scope;

use anyhow::Result;
use clap::Subcommand;

use crate::cli::GlobalOptions;
use crate::commands::client::memory_client;
use crate::config::{ProfileKind, resolve_profile};
use crate::envelope::EmitContext;
use crate::output::emit_command;
use crate::telemetry::{ActivationContext, capture_first_real_memory_if_needed};
use crate::validation::with_operation_recovery;

use ingest::{ContentClass, SdkIngestMode, build_ingest_request};
use package::{PackageFormat, PackageSection, run_package};
use scope::{NamespaceSupport, resolve_memory_scope_with};

#[derive(Debug, Subcommand)]
pub enum MemoryCommand {
    /// Ingest text into memory
    Ingest {
        #[arg(long, value_enum, default_value_t = SdkIngestMode::Text)]
        mode: SdkIngestMode,
        #[arg(long, default_value = "cli")]
        source: String,
        #[arg(long)]
        agent_id: Option<String>,
        #[arg(long, hide = true)]
        agent: Option<String>,
        #[arg(long)]
        session: Option<String>,
        #[arg(long)]
        workspace: Option<String>,
        #[arg(long)]
        file: Option<String>,
        #[arg(long)]
        stdin: bool,
        #[arg(long, value_enum)]
        content_class: Option<ContentClass>,
        #[arg(long)]
        metadata: Option<String>,
        #[arg(
            long,
            hide = true,
            help = "Legacy flag — maps to --mode verbatim (quick storage without extraction)"
        )]
        skip_extraction: bool,
        text: Option<String>,
    },
    /// Search memories
    Search {
        query: String,
        #[arg(long)]
        session: Option<String>,
        #[arg(long)]
        agent_id: Option<String>,
        #[arg(long, hide = true)]
        agent: Option<String>,
        #[arg(long)]
        limit: Option<i64>,
        #[arg(long)]
        fast: bool,
    },
    /// Build token-budgeted context for agent injection
    Package {
        query: Vec<String>,
        #[arg(long)]
        token_budget: Option<i64>,
        #[arg(long, value_enum)]
        format: Option<PackageFormat>,
        /// Placement hint for the consumer, echoed back in `meta.section`.
        /// Advisory only: it does not change the packaged text.
        #[arg(long, value_enum)]
        section: Option<PackageSection>,
        #[arg(long)]
        limit: Option<i64>,
        #[arg(long)]
        session: Option<String>,
        #[arg(long)]
        agent_id: Option<String>,
        #[arg(long, hide = true)]
        agent: Option<String>,
        #[arg(long)]
        workspace: Option<String>,
    },
    /// List memories
    List {
        #[arg(long)]
        session: Option<String>,
        #[arg(long)]
        limit: Option<i64>,
    },
    /// Get a memory by id
    Get { memory_id: String },
    /// Delete a memory by id
    Delete { memory_id: String },
}

pub async fn run(cmd: MemoryCommand, global: &GlobalOptions) -> Result<()> {
    match cmd {
        MemoryCommand::Ingest {
            mode,
            source,
            agent_id,
            agent,
            session,
            workspace,
            file,
            stdin,
            content_class,
            metadata,
            skip_extraction,
            text,
        } => {
            let effective_mode = resolve_ingest_mode(mode, skip_extraction)?;
            run_ingest(
                global,
                effective_mode,
                source,
                agent_id.or(agent),
                session,
                workspace,
                file,
                stdin,
                content_class,
                metadata,
                text,
            )
            .await
        }
        MemoryCommand::Search {
            query,
            session,
            agent_id,
            agent,
            limit,
            fast,
        } => run_search(global, query, session, agent_id.or(agent), limit, fast).await,
        MemoryCommand::Package {
            query,
            token_budget,
            format,
            section,
            limit,
            session,
            agent_id,
            agent,
            workspace,
        } => {
            run_package(
                global,
                query.join(" "),
                token_budget,
                format,
                section,
                limit,
                session,
                agent_id.or(agent),
                workspace,
            )
            .await
        }
        MemoryCommand::List { session, limit } => run_list(global, session, limit).await,
        MemoryCommand::Get { memory_id } => run_get(global, memory_id).await,
        MemoryCommand::Delete { memory_id } => run_delete(global, memory_id).await,
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_ingest(
    global: &GlobalOptions,
    mode: SdkIngestMode,
    source: String,
    agent_id: Option<String>,
    session: Option<String>,
    workspace: Option<String>,
    file: Option<String>,
    stdin: bool,
    content_class: Option<ContentClass>,
    metadata: Option<String>,
    text: Option<String>,
) -> Result<()> {
    // `CoreIngestRequest` has no namespace field, so `--scope-namespace` here
    // would be silently dropped; reject it instead.
    let scope = resolve_memory_scope_with(
        global,
        session,
        agent_id,
        workspace,
        NamespaceSupport::Unsupported,
    )?;
    let parsed_metadata = parse_metadata(metadata)?;
    let (req, is_verbatim) = build_ingest_request(
        mode,
        &scope,
        source,
        content_class,
        parsed_metadata,
        text,
        file,
        stdin,
    )
    .await?;
    let (profile, client) = memory_client(global).await?;
    let resp = if is_verbatim {
        client
            .ingest_quick(&req)
            .await
            .map_err(|e| with_operation_recovery(e.into(), "Memory ingest", profile.kind))?
    } else {
        client
            .ingest(&req)
            .await
            .map_err(|e| with_operation_recovery(e.into(), "Memory ingest", profile.kind))?
    };
    if let Ok(profile) = resolve_profile(
        global.profile.as_deref(),
        global.base_url.as_deref(),
        global.environment,
    ) {
        let actx = ActivationContext {
            project_id: profile.project_id.clone(),
            mode: Some(match profile.kind {
                ProfileKind::Local => "local",
                ProfileKind::Cloud => "cloud",
            }),
            ..Default::default()
        };
        capture_first_real_memory_if_needed(
            resp.memories_stored,
            &req.source_site,
            &actx,
            global.no_telemetry,
        );
    }
    let ctx = EmitContext::new("memory ingest", global);
    emit_command(global, &ctx, &resp, Some(resp.memories_stored))
}

async fn run_search(
    global: &GlobalOptions,
    query: String,
    session: Option<String>,
    agent_id: Option<String>,
    limit: Option<i64>,
    fast: bool,
) -> Result<()> {
    let scope =
        resolve_memory_scope_with(global, session, agent_id, None, NamespaceSupport::Supported)?;
    let (_profile, client) = memory_client(global).await?;
    let req = am_core_types::CoreSearchRequest {
        user_id: scope.user_id,
        query,
        limit,
        threshold: None,
        token_budget: None,
        retrieval_mode: None,
        skip_repair: None,
        source_site: None,
        agent_id: scope.agent_id,
        workspace_id: scope.workspace_id,
        session_id: scope.session_id,
        visibility: None,
        as_of: None,
        namespace_scope: scope.namespace_scope,
        config_override: None,
    };
    let resp = if fast {
        client.search_fast(&req).await?
    } else {
        client.search(&req).await?
    };
    let ctx = EmitContext::new("memory search", global);
    emit_command(global, &ctx, &resp, Some(resp.count))
}

async fn run_list(
    global: &GlobalOptions,
    session: Option<String>,
    limit: Option<i64>,
) -> Result<()> {
    let scope =
        resolve_memory_scope_with(global, session, None, None, NamespaceSupport::Unsupported)?;
    let (_profile, client) = memory_client(global).await?;
    let query = am_core_types::CoreListMemoriesQuery {
        user_id: scope.user_id,
        limit,
        offset: None,
        workspace_id: scope.workspace_id,
        agent_id: scope.agent_id,
        source_site: None,
        episode_id: None,
        session_id: scope.session_id,
    };
    let resp = client.list_memories(&query).await?;
    let ctx = EmitContext::new("memory list", global);
    emit_command(global, &ctx, &resp, Some(resp.count))
}

async fn run_get(global: &GlobalOptions, memory_id: String) -> Result<()> {
    let scope = resolve_memory_scope_with(global, None, None, None, NamespaceSupport::Unsupported)?;
    let (_profile, client) = memory_client(global).await?;
    let query = am_core_types::CoreMemoryQuery {
        user_id: scope.user_id,
        workspace_id: scope.workspace_id,
        agent_id: scope.agent_id,
    };
    let mem = client.get_memory(&memory_id, &query).await?;
    let ctx = EmitContext::new("memory get", global);
    emit_command(global, &ctx, &mem, None)
}

async fn run_delete(global: &GlobalOptions, memory_id: String) -> Result<()> {
    let scope = resolve_memory_scope_with(global, None, None, None, NamespaceSupport::Unsupported)?;
    let (_profile, client) = memory_client(global).await?;
    let query = am_core_types::CoreMemoryQuery {
        user_id: scope.user_id,
        workspace_id: scope.workspace_id,
        agent_id: scope.agent_id,
    };
    let resp = client.delete_memory(&memory_id, &query).await?;
    let ctx = EmitContext::new("memory delete", global);
    emit_command(global, &ctx, &resp, None)
}

pub fn command_label(cmd: &MemoryCommand) -> &'static str {
    match cmd {
        MemoryCommand::Ingest { .. } => "ingest",
        MemoryCommand::Search { .. } => "search",
        MemoryCommand::Package { .. } => "package",
        MemoryCommand::List { .. } => "list",
        MemoryCommand::Get { .. } => "get",
        MemoryCommand::Delete { .. } => "delete",
    }
}

fn resolve_ingest_mode(mode: SdkIngestMode, skip_extraction: bool) -> Result<SdkIngestMode> {
    if !skip_extraction {
        return Ok(mode);
    }
    match mode {
        SdkIngestMode::Verbatim | SdkIngestMode::Text => Ok(SdkIngestMode::Verbatim),
        SdkIngestMode::Messages => {
            anyhow::bail!(
                "--skip-extraction cannot be used with --mode messages; use --mode verbatim instead"
            )
        }
    }
}

/// Metadata keys Core reserves for its own provenance fields. Sending one is
/// rejected server-side; catching it here turns an opaque 400 into a usable
/// message. Mirrors `RESERVED_METADATA_KEYS` in
/// `packages/core/src/db/repository-types.ts` — the MCP server keeps a checked
/// mirror of the full list; this is the caller-facing subset most likely to be
/// typed by hand.
const RESERVED_METADATA_KEYS: &[&str] = &[
    "topic",
    "namespace",
    "user_id",
    "agent_id",
    "workspace_id",
    "session_id",
    "episode_id",
    "memory_type",
    "source_site",
    "source_url",
    "content_class",
    "visibility",
    "trust_score",
    "decay_score",
];

/// Core caps metadata at 32 KB.
const MAX_METADATA_BYTES: usize = 32 * 1024;

fn parse_metadata(raw: Option<String>) -> Result<Option<serde_json::Value>> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    let value: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| anyhow::anyhow!("--metadata is not valid JSON: {e}"))?;
    let object = value.as_object().ok_or_else(|| {
        anyhow::anyhow!("--metadata must be a JSON object (Core rejects scalars and arrays)")
    })?;
    let reserved: Vec<&str> = object
        .keys()
        .filter_map(|key| {
            RESERVED_METADATA_KEYS
                .iter()
                .find(|reserved| *reserved == key)
                .copied()
        })
        .collect();
    if !reserved.is_empty() {
        anyhow::bail!(
            "--metadata contains reserved key(s): {}. Core owns these provenance fields; \
             use your own key names (for example `externalId` or `dedupe_key`).",
            reserved.join(", ")
        );
    }
    if raw.len() > MAX_METADATA_BYTES {
        anyhow::bail!(
            "--metadata is {} bytes; Core caps metadata at {MAX_METADATA_BYTES} bytes",
            raw.len()
        );
    }
    Ok(Some(value))
}
