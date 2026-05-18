# Database documentation

In-repo documentation for the PostgreSQL + pgvector layer that ships with
`@atomicmemory/core`. Public operator and contributor guidance lives here.

## Contents

- [`migrations.md`](./migrations.md) — operator and contributor reference
  for the Phase 2 versioned migration system. Covers the folder layout,
  inspection queries against `pgmigrations` and `schema_version`, the
  Scenario A/B/C lossless guarantee, the `migrate()` / `migrationStatus()`
  API surface, and the workflow for adding a new migration.
- [`changelog/`](./changelog) — provenance-only SQL files from the
  pre-Phase-2 schema evolution. Reference material, not executed at
  runtime.
