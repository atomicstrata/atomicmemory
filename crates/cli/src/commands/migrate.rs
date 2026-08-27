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
use crate::commands::client::{
    dashboard_client, dashboard_client_for_export, emit_cloud_export_warning_if_needed,
    memory_client_for_profile,
};
use crate::config::{
    resolve_profile, resolve_profile_with_export_identity, store_local_export_project_id,
};
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
    // Resolve exactly once, before the first await, and build every client
    // from that one profile. Each additional resolution reopens config.toml,
    // and `am config profile use` can land in the gap — most easily across the
    // dashboard round trip below. The old code resolved for the dashboard, ran
    // a network lookup, then resolved again for memory, checking only kind and
    // not identity. Two Local profiles passed that check, so project A was
    // bound while profile B's memories were exported.
    // One config read yields both the resolved profile and the raw identity
    // for the store's in-lock check. A separate re-load for the capture left a
    // filesystem-level gap where another process could swap the profile, so
    // the resolution described A while the identity described B — and the
    // locked store then accepted B and wrote A's project into it. Raw fields,
    // not resolved ones: resolved base_url can carry a --base-url override and
    // memory_base_url is derived.
    let (client_profile, expected_profile) = resolve_profile_with_export_identity(
        global.profile.as_deref(),
        global.base_url.as_deref(),
        global.environment,
    )?;
    // Same-generation stored kind; the warning helper needs it to classify.
    emit_cloud_export_warning_if_needed(global, expected_profile.entry.kind, &client_profile);
    if client_profile.kind != crate::config::ProfileKind::Local {
        bail!(
            "export requires an active Connected Local profile — active profile '{}' is Cloud",
            client_profile.name
        );
    }

    let dashboard = dashboard_client_for_export(&client_profile, &expected_profile).await?;
    let project = resolve_project(&dashboard, project_ref).await?;
    if project.kind != am_cloud_types::ProjectType::Local {
        bail!(
            "export requires a local project — got cloud project '{}'",
            project.slug
        );
    }

    store_local_export_project_id(&client_profile.name, &expected_profile, &project.id)?;

    // Refresh after our own write, pinned to the resolved NAME rather than the
    // ambient default. The write above sets the profile's project_id, and API
    // key selection only returns a stored key when the key's persisted project
    // binding matches the resolved one — so the pre-write snapshot reports no
    // key at all for a profile that had no project_id yet (the state left by
    // `am key create --project <id> --save`, which binds the credential without
    // touching the profile). Re-resolving by name keeps the cross-profile race
    // closed while letting the command see the mutation it just made.
    let pinned_profile = client_profile;
    let client_profile = resolve_profile(
        Some(&pinned_profile.name),
        global.base_url.as_deref(),
        global.environment,
    )?;
    if let Some(field) = export_profile_replaced(&pinned_profile, &client_profile) {
        bail!(
            "profile '{}' was replaced during export ({field} changed) — rerun `am migrate export`",
            pinned_profile.name
        );
    }
    let client = memory_client_for_profile(&client_profile).await?;
    client.health().await.map_err(|e| {
        with_operation_recovery(
            e.into(),
            "Core health check before export",
            client_profile.kind,
        )
    })?;

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
            .map_err(|e| {
                with_operation_recovery(e.into(), "Export list memories", client_profile.kind)
            })?;

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

/// Report which identity field changed when the named profile was replaced.
///
/// Pinning the name is not enough on its own: `am config profile add` inserts
/// over an existing entry, so Local A can become a different Local B under the
/// same name while the kind check still passes, and export would read B's Core
/// for a project chosen through A's dashboard session.
///
/// Deliberately excludes `project_id` and `api_key`. Export writes the project
/// binding itself, and that write is what makes a project-bound key resolvable,
/// so both legitimately differ between the snapshot and the refresh. Comparing
/// them would reject the very flow the refresh exists to support.
fn export_profile_replaced(
    before: &crate::config::ResolvedProfile,
    after: &crate::config::ResolvedProfile,
) -> Option<&'static str> {
    if before.name != after.name {
        return Some("name");
    }
    if before.kind != after.kind {
        return Some("kind");
    }
    if before.base_url != after.base_url {
        return Some("base_url");
    }
    if before.memory_base_url != after.memory_base_url {
        return Some("local_url");
    }
    None
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
    use crate::config::{
        ConfigStore, DEFAULT_CLOUD_URL, ExpectedExportProfile, ProfileConfig, ProfileKind,
        ResolvedProfile, default_config_for_test, store_local_export_project_id_in,
    };

    #[test]
    fn export_detects_same_name_profile_replacement() {
        // `am config profile add` inserts over an existing name, so pinning the
        // name alone still let Local A become a different Local B mid-export.
        let base = |name: &str, kind, base_url: &str, mem: &str| ResolvedProfile {
            name: name.into(),
            base_url: base_url.into(),
            kind,
            project_id: None,
            memory_base_url: mem.into(),
            api_key: None,
            oauth: None,
        };
        let before = base(
            "local",
            ProfileKind::Local,
            "https://api.x/",
            "http://127.0.0.1:17350",
        );
        assert_eq!(export_profile_replaced(&before, &before), None);

        let swapped_core = base(
            "local",
            ProfileKind::Local,
            "https://api.x/",
            "http://127.0.0.1:9999",
        );
        assert_eq!(
            export_profile_replaced(&before, &swapped_core),
            Some("local_url")
        );
        let swapped_cloud = base(
            "local",
            ProfileKind::Local,
            "https://evil.example/",
            "http://127.0.0.1:17350",
        );
        assert_eq!(
            export_profile_replaced(&before, &swapped_cloud),
            Some("base_url")
        );
        let swapped_kind = base(
            "local",
            ProfileKind::Cloud,
            "https://api.x/",
            "http://127.0.0.1:17350",
        );
        assert_eq!(
            export_profile_replaced(&before, &swapped_kind),
            Some("kind")
        );
    }

    #[test]
    fn export_replacement_check_ignores_what_the_export_itself_writes() {
        // Regression guard. Export persists the project binding, and that write
        // is what makes a project-bound key resolvable, so project_id and
        // api_key differ between snapshot and refresh by design. An earlier
        // attempt at pinning rejected exactly this and broke `am key create
        // --project <id> --save` followed by export.
        let before = ResolvedProfile {
            name: "local".into(),
            base_url: "https://api.x/".into(),
            kind: ProfileKind::Local,
            project_id: None,
            memory_base_url: "http://127.0.0.1:17350".into(),
            api_key: None,
            oauth: None,
        };
        let after = ResolvedProfile {
            project_id: Some("proj_a".into()),
            api_key: Some("amc_resolved_after_write".into()),
            ..before.clone()
        };
        assert_eq!(export_profile_replaced(&before, &after), None);
    }

    #[test]
    fn export_resolves_the_active_profile_exactly_once() {
        // Structural, not behavioural: a two-Local-profile test would need an
        // injectable resolver, which `resolve_profile_and_warn` is not. What it
        // does catch is a second resolution being reintroduced, which is the
        // whole defect — the old code resolved for the dashboard, awaited a
        // network lookup, then resolved again for memory and compared only
        // kind, so two Local profiles passed and B's memories were exported
        // under A's project.
        //
        // The downstream half needs no test: dashboard_client_for_profile and
        // memory_client_for_profile take no GlobalOptions, so they have nothing
        // to resolve from and the compiler enforces it.
        let src = include_str!("migrate.rs");
        let body = src
            .split("async fn run_export(")
            .nth(1)
            .expect("run_export present");
        let body = &body[..body.find("\nasync fn ").unwrap_or(body.len())];
        let ambient = body
            .matches("resolve_profile_with_export_identity(")
            .count()
            + body.matches("resolve_profile_and_warn(").count()
            + body.matches("resolve_ctx(").count()
            + body.matches("dashboard_client(").count()
            + body.matches("memory_client(").count();
        assert_eq!(
            ambient, 1,
            "run_export must consult the ambient default profile exactly once"
        );
        // The resolution and the store's expected identity must come from ONE
        // config read. A separate load_config for the capture reopens the
        // cross-process window where the resolved profile describes A while
        // the identity describes its same-name replacement B.
        assert!(
            !body.contains("load_config("),
            "run_export must not re-read config.toml outside the combined resolver"
        );
        // Refreshing after our own write is required — the project binding it
        // persists is what makes the stored key resolvable. It must be pinned
        // to the already-resolved name, never re-read from the default.
        let refresh = body
            .split("resolve_profile(")
            .nth(1)
            .expect("post-write refresh present");
        let args = &refresh[..refresh.find("?;").unwrap_or(refresh.len().min(200))];
        assert!(
            args.contains("Some(&pinned_profile.name)"),
            "post-write refresh must be pinned to the snapshot's name, not the default"
        );
        // And that resolution must precede the dashboard round trip.
        let resolve_at = body
            .find("resolve_profile_with_export_identity(")
            .expect("resolution present");
        let dashboard_at = body
            .find("dashboard_client_for_export(")
            .expect("dashboard build present");
        assert!(
            resolve_at < dashboard_at,
            "resolution must happen before the first await"
        );
    }

    #[test]
    fn export_rejects_cloud_profile_without_mutating_project_id() {
        let dir = tempfile::tempdir().unwrap();
        let store = ConfigStore::at(dir.path().join("config.toml"));
        let mut cfg = default_config_for_test();
        cfg.default_profile = Some("cloud".into());
        cfg.profiles.insert(
            "cloud".into(),
            ProfileConfig {
                base_url: Some(DEFAULT_CLOUD_URL.into()),
                kind: ProfileKind::Cloud,
                project_id: Some("proj_before".into()),
                hosted_cloud_managed: Some(true),
                ..Default::default()
            },
        );
        store
            .update(|config| {
                *config = cfg;
                Ok(())
            })
            .unwrap();

        let err = store_local_export_project_id_in(
            &store,
            "cloud",
            &ExpectedExportProfile::capture(&store.load().unwrap(), "cloud").unwrap(),
            "proj_after",
        )
        .unwrap_err();
        assert!(err.to_string().contains("Connected Local"));
        assert_eq!(
            store.load().unwrap().profiles["cloud"]
                .project_id
                .as_deref(),
            Some("proj_before")
        );
    }

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
