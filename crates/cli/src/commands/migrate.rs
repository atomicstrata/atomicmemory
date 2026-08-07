//! Local → Cloud memory migration commands.

use std::fs::File;
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};

/// Records per import request. The Cloud API rejects requests above this, and
/// export paginates by the same value, so the two cannot drift apart.
const IMPORT_CHUNK_SIZE: usize = 500;

use am_cloud_types::{
    ExportManifest, ExportMemoryRecord, ExportMemoryScope, IMPORT_SCHEMA_VERSION,
    ImportMemoriesRequest, ImportMode, ImportSource,
};
use am_core_types::CoreListMemoriesQuery;
use anyhow::{Context, Result, bail};
use chrono::Utc;
use clap::Subcommand;

use crate::cli::GlobalOptions;
use crate::commands::client::{dashboard_client, memory_client};
use crate::config::{resolve_profile, store_project_id};
use crate::output::{emit, message};
use crate::validation::with_operation_recovery;

#[derive(Debug, Subcommand)]
pub enum MigrateCommand {
    /// Export local Core memories to JSONL
    Export {
        /// Local project slug or id
        #[arg(long)]
        project: String,
        /// Output file path
        #[arg(long)]
        out: Option<PathBuf>,
        /// Core user namespace (default: default)
        #[arg(long, default_value = "default")]
        user_id: String,
    },
    /// Import JSONL memories into a cloud project
    Import {
        /// Path to export JSONL file
        #[arg(long)]
        file: PathBuf,
        /// Target cloud project slug or id
        #[arg(long)]
        target_project: String,
        /// Import mode (v1 supports merge only)
        #[arg(long, value_enum, default_value = "merge")]
        mode: ImportModeArg,
    },
}

#[derive(Debug, Clone, Copy, clap::ValueEnum, Default)]
pub enum ImportModeArg {
    #[default]
    Merge,
    ReplaceScope,
}

impl From<ImportModeArg> for ImportMode {
    fn from(value: ImportModeArg) -> Self {
        match value {
            ImportModeArg::Merge => ImportMode::Merge,
            ImportModeArg::ReplaceScope => ImportMode::ReplaceScope,
        }
    }
}

pub async fn run(cmd: MigrateCommand, global: &GlobalOptions) -> Result<()> {
    match cmd {
        MigrateCommand::Export {
            project,
            out,
            user_id,
        } => run_export(global, &project, out.as_deref(), &user_id).await,
        MigrateCommand::Import {
            file,
            target_project,
            mode,
        } => run_import(global, &file, &target_project, mode.into()).await,
    }
}

async fn run_export(
    global: &GlobalOptions,
    project_ref: &str,
    out: Option<&Path>,
    user_id: &str,
) -> Result<()> {
    let (_profile, dashboard) = dashboard_client(global).await?;
    let project = resolve_project(&dashboard, project_ref).await?;
    if project.kind != am_cloud_types::ProjectType::Local {
        bail!(
            "export requires a local project — got cloud project '{}'",
            project.slug
        );
    }

    store_project_id(
        &resolve_profile(
            global.profile.as_deref(),
            global.base_url.as_deref(),
            global.environment,
        )?
        .name,
        &project.id,
    )?;

    let (_resolved, client) = memory_client(global).await?;
    client
        .health()
        .await
        .map_err(|e| with_operation_recovery(e.into(), "Core health check before export"))?;

    let page_size = IMPORT_CHUNK_SIZE as i64;
    let mut offset = 0i64;
    let mut records = Vec::new();

    loop {
        let page = client
            .list_memories(&CoreListMemoriesQuery {
                user_id: user_id.to_string(),
                limit: Some(page_size),
                offset: Some(offset),
                workspace_id: None,
                agent_id: None,
                source_site: None,
                episode_id: None,
                session_id: None,
            })
            .await
            .map_err(|e| with_operation_recovery(e.into(), "Export list memories"))?;

        if page.memories.is_empty() {
            break;
        }
        let batch_len = page.memories.len();
        for memory in page.memories {
            let mut scope = ExportMemoryScope::default();
            if let Some(session) = memory.session_id.as_deref() {
                scope.user = Some(session.to_string());
            }
            if let Some(agent) = memory.agent_id.as_deref() {
                scope.agent = Some(agent.to_string());
            }
            if let Some(workspace) = memory.workspace_id.as_deref() {
                scope.workspace = Some(workspace.to_string());
            }
            let record = ExportMemoryRecord {
                schema_version: IMPORT_SCHEMA_VERSION,
                memory_id: memory.id.clone(),
                user_id: user_id.to_string(),
                content: memory.content.clone(),
                claim: memory.content.clone(),
                scope,
                source_site: memory
                    .source_site
                    .clone()
                    .unwrap_or_else(|| "migration".to_string()),
                created_at: memory.created_at,
                updated_at: memory.updated_at,
                evidence: Vec::new(),
                checksum: None,
            };
            let checksum = am_cloud_types::record_checksum(&record);
            records.push(ExportMemoryRecord {
                checksum: Some(checksum),
                ..record
            });
        }
        if batch_len < page_size as usize {
            break;
        }
        offset += page_size;
    }

    let out_path = out
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(format!("./migrate-{}.jsonl", project.slug)));

    let file = File::create(&out_path)
        .with_context(|| format!("create export file {}", out_path.display()))?;
    let mut writer = BufWriter::new(file);
    let manifest = ExportManifest {
        kind: "manifest".to_string(),
        schema_version: IMPORT_SCHEMA_VERSION,
        exported_at: Utc::now(),
        project_slug: project.slug.clone(),
        record_count: records.len(),
    };
    writeln!(writer, "{}", serde_json::to_string(&manifest)?)?;
    for record in &records {
        writeln!(writer, "{}", serde_json::to_string(record)?)?;
    }
    writer.flush()?;

    message(
        !global.quiet,
        &format!(
            "Exported {} memories to {}",
            records.len(),
            out_path.display()
        ),
    );
    emit(
        global.output,
        &serde_json::json!({
            "path": out_path,
            "record_count": records.len(),
            "project_slug": project.slug,
        }),
        global.quiet,
    )
}

async fn run_import(
    global: &GlobalOptions,
    file: &Path,
    target_project: &str,
    mode: ImportMode,
) -> Result<()> {
    let (_profile, dashboard) = dashboard_client(global).await?;
    let project = resolve_project(&dashboard, target_project).await?;
    if project.kind != am_cloud_types::ProjectType::Cloud {
        bail!(
            "import target must be a cloud project — got local project '{}'",
            project.slug
        );
    }

    let records = read_export_records(file)?;
    if records.is_empty() {
        bail!("no memory records found in export file");
    }

    // Export paginates at IMPORT_CHUNK_SIZE and accumulates every record, so a
    // multi-page export is routine - while import posted the whole file in one
    // request, which the API rejects above its per-request record cap. Every
    // migration larger than a single page failed after a successful export.
    let total = records.len();
    let chunk_count = total.div_ceil(IMPORT_CHUNK_SIZE);
    let mut imported = 0i64;
    let mut skipped = 0i64;
    let mut failed = 0i64;
    let mut batches: Vec<String> = Vec::new();

    for (index, chunk) in records.chunks(IMPORT_CHUNK_SIZE).enumerate() {
        let req = ImportMemoriesRequest {
            schema_version: IMPORT_SCHEMA_VERSION,
            source: ImportSource {
                local_project_id: None,
                export_checksum: None,
            },
            mode,
            records: chunk.to_vec(),
        };

        let receipt = dashboard
            .import_memories(&project.id, &req)
            .await
            .map_err(|e| {
                anyhow::anyhow!(
                    "{e}\nfailed on chunk {} of {chunk_count}; {imported} record(s) were already imported",
                    index + 1
                )
            })?;

        imported += receipt.imported;
        skipped += receipt.skipped;
        failed += receipt.failed;
        batches.push(receipt.batch_id);
    }

    message(
        !global.quiet,
        &format!(
            "Import complete - imported: {imported}, skipped: {skipped}, failed: {failed} ({chunk_count} batch(es))"
        ),
    );
    emit(
        global.output,
        &serde_json::json!({
            "imported": imported,
            "skipped": skipped,
            "failed": failed,
            "records": total,
            "batches": batches,
        }),
        global.quiet,
    )
}

fn read_export_records(path: &Path) -> Result<Vec<ExportMemoryRecord>> {
    let file = File::open(path).with_context(|| format!("open export file {}", path.display()))?;
    let reader = BufReader::new(file);
    let mut records = Vec::new();
    for line in reader.lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let value: serde_json::Value = serde_json::from_str(&line)?;
        if value.get("type").and_then(|v| v.as_str()) == Some("manifest") {
            continue;
        }
        let record: ExportMemoryRecord = serde_json::from_value(value)?;
        records.push(record);
    }
    Ok(records)
}

async fn resolve_project(
    client: &am_cloud_client::DashboardClient,
    id_or_slug: &str,
) -> Result<am_cloud_types::Project> {
    if id_or_slug.starts_with("proj_") {
        return client
            .get_project(id_or_slug)
            .await
            .map_err(|e| anyhow::anyhow!("{e}"));
    }
    let projects = client
        .list_projects()
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    projects
        .into_iter()
        .find(|p| p.slug == id_or_slug || p.id == id_or_slug)
        .ok_or_else(|| anyhow::anyhow!("project not found: {id_or_slug}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The Cloud API's per-request record cap. Named separately from
    /// IMPORT_CHUNK_SIZE on purpose: if someone raises the chunk size, this
    /// test fails rather than the migration failing against the live API.
    const API_MAX_RECORDS_PER_REQUEST: usize = 500;

    /// Enforced at COMPILE time, not by a test.
    ///
    /// As a runtime assertion this compared two constants, so it folded to
    /// `assert!(true)` and verified nothing - clippy's `assertions_on_constants`
    /// caught it. A const assertion fails the build instead, which is what a
    /// cap like this deserves: raising IMPORT_CHUNK_SIZE past what the API
    /// accepts should be impossible to merge, not merely tested.
    const _: () = assert!(
        IMPORT_CHUNK_SIZE <= API_MAX_RECORDS_PER_REQUEST,
        "IMPORT_CHUNK_SIZE exceeds the API's per-request record cap; every \
         migration larger than one request would fail against the live API",
    );

    /// 501 is the first size that fails without chunking.
    ///
    /// Export paginates and accumulates every record, so a multi-page export is
    /// routine, while import posted the whole file in a single request. A
    /// migration of 501 memories therefore failed after a successful export -
    /// the point where the two halves stopped agreeing.
    #[test]
    fn a_records_set_over_one_page_is_split() {
        let records: Vec<u8> = vec![0; API_MAX_RECORDS_PER_REQUEST + 1];
        let chunks: Vec<_> = records.chunks(IMPORT_CHUNK_SIZE).collect();

        assert_eq!(chunks.len(), 2, "501 records must become two requests");
        assert_eq!(chunks[0].len(), IMPORT_CHUNK_SIZE);
        assert_eq!(chunks[1].len(), 1);
        assert!(
            chunks
                .iter()
                .all(|c| c.len() <= API_MAX_RECORDS_PER_REQUEST),
            "no request may exceed the API cap",
        );
        assert_eq!(
            chunks.iter().map(|c| c.len()).sum::<usize>(),
            records.len(),
            "chunking must not drop or duplicate records",
        );
    }

    #[test]
    fn an_exact_page_is_a_single_request() {
        let records: Vec<u8> = vec![0; IMPORT_CHUNK_SIZE];
        assert_eq!(records.chunks(IMPORT_CHUNK_SIZE).count(), 1);
    }
}
