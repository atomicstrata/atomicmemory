# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- Phase 1 migration hardening now packages a deterministic
  `dist/db/schema-sha256.json` manifest for the shipped DB schema bytes.
- Phase 2 versioned migrations. Schema is now expressed as ordered files
  under `src/db/migrations/` (shipped as `dist/db/migrations/`), executed
  by `node-pg-migrate` and tracked per-file in the `pgmigrations` table.
  The Phase 1 `schema_version` table is preserved alongside `pgmigrations`
  so operators can answer both "which migration files ran" and "which
  `@atomicmemory/core` semver this DB corresponds to".
- `migrationStatus()` surfaces two new read-only fields,
  `appliedMigrationCount` and `latestMigrationName`, sourced from
  `pgmigrations`. The existing `status` enum (`up_to_date` / `older_db` /
  `newer_db` / `unstamped` / `no_schema`) is unchanged.

### Changed
- **BREAKING**: All API endpoints are now mounted under `/v1/` (e.g. `POST /v1/memories/ingest`, `PUT /v1/agents/trust`). Update clients to prefix requests with `/v1`. The unversioned `/health` liveness probe is unchanged.
- Phase 2 removes `src/db/schema.sql`; the migrations folder is now the
  single source of truth. The build-time `dist/db/schema-sha256.json`
  manifest is preserved but now describes the ordered migration directory.
  Library and CLI surfaces are unchanged: `migrate()` and
  `migrationStatus()` keep their Phase 1 signatures, and
  `MigrateResult.ranSchemaSql` is preserved as "this call executed the
  migration runner path" (the Phase 1 semantics for the no-op-loser path
  still hold).
- Moved provenance-only SQL changelog files from `src/db/migrations/` to
  `docs/db/changelog/`. Phase 2 reclaims `src/db/migrations/` as the
  runtime migration folder.

### Migration (Phase 2 — lossless guarantee)

Three install paths reach the same end state without data loss, without
unexpected DDL, and without operator intervention. All three run inside
the same advisory-lock wrapper used by Phase 1 (`MIGRATION_LOCK_ID`
unchanged), so concurrent replica boots remain safe.

- **Scenario A — fresh install on Phase 2.** `migrate()` creates
  `pgmigrations`, runs `0001_baseline.sql` against the empty database,
  runs any later migration files, runs the embedding-dimension reconciler
  (against now-empty tables; no-op or a single `ALTER COLUMN`), and stamps
  `schema_version`.
- **Scenario B — v1.0.x with data → Phase 2.** `migrate()` detects that
  core tables exist but `pgmigrations` does not. It creates `pgmigrations`,
  **stamps `0001_baseline` as applied without executing it**, runs any
  post-baseline migrations against the live schema, runs the reconciler
  on the live (possibly populated) tables with the same Phase 1
  semantics, and inserts the first `schema_version` row. Baseline DDL
  does not touch existing tables.
- **Scenario C — Phase 1 → Phase 2.** Same as B except `schema_version`
  already exists; the upgrade appends a new row instead of creating the
  table.

Enforcement: `baseline-schema-equivalence.test.ts` (the CI gate) builds
both end states on fresh databases and asserts the schema-only structural
snapshot is identical modulo the framework-bookkeeping tables. The Phase 1
data-preservation suite is carried forward unchanged and continues to
seed legacy rows, snapshot them, run `migrate()`, and assert the rows,
primary keys, foreign keys, JSON metadata, timestamps, and representative
vector fields survive the Phase 1 → Phase 2 migration.

## [1.0.0] - 2026-04-15

### Added
- Initial extraction from atomicmemory-research prototype
- Express API server with memory ingest, search, and consolidation endpoints
- Postgres + pgvector storage backend
- Pluggable embedding providers: openai, openai-compatible, ollama, transformers (WASM)
- AUDN mutation engine (Add, Update, Delete, No-op) with fail-closed semantics
- Contradiction-safe claim versioning
- Hybrid retrieval (vector + BM25/FTS)
- Tiered context packaging
- Entity graph with spreading activation
- Docker and Railway deployment support
- 869 tests across 79 test files
- CI with GitHub Actions (typecheck, fallow, tests)
- Contributor docs (CONTRIBUTING.md, issue/PR templates)
