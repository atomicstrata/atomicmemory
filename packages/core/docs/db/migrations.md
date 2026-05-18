# Migrations

`@atomicmemory/core` runs against PostgreSQL + pgvector. As of Phase 2 the
schema is composed of ordered migration files under `src/db/migrations/`,
executed by [`node-pg-migrate`](https://github.com/salsita/node-pg-migrate)
behind the same `migrate()` / `migrationStatus()` API that Phase 1 introduced.
This page is the operator- and contributor-facing reference that ships with
the package.

## Folder layout

```
src/db/
  migrations/
    0001_baseline.sql       Frozen Phase-1 schema; never edited after shipment.
    0002_<descriptive>.sql  First post-baseline migration.
    …
  migration-api.ts          migrate() / migrationStatus() entry points.
  migrate.ts                CLI shim used by `npm run migrate`.
```

After `npm run build`, the files are copied into `dist/db/migrations/` and
shipped in the published package so library consumers can run migrations
without cloning the source.

There is no `schema.sql` at runtime. The migrations folder, replayed in
order against an empty database, is the schema. To get a current schema
dump locally, replay the files against an empty database and run
`pg_dump --schema-only`.

## Inspecting state

Two tables hold migration state, on purpose:

| Table            | Maintained by                | Answers                                                  |
|------------------|------------------------------|----------------------------------------------------------|
| `pgmigrations`   | `node-pg-migrate` framework  | Which migration files have been applied, and when        |
| `schema_version` | `@atomicmemory/core`         | Which package semver this DB corresponds to              |

Inspection queries operators can run against any reachable Postgres:

```sql
-- Per-file history (one row per applied migration).
SELECT id, name, run_on FROM pgmigrations ORDER BY id;

-- Effective package version (latest row by applied_at).
SELECT sdk_version, schema_sha256, applied_at
  FROM schema_version
  ORDER BY applied_at DESC
  LIMIT 1;

-- Full Phase-1 stamp history when audit needs it.
SELECT sdk_version, schema_sha256, applied_at, notes
  FROM schema_version
  ORDER BY applied_at DESC;
```

`migrationStatus()` surfaces both tables programmatically without holding
the advisory lock:

```ts
import { migrationStatus } from '@atomicmemory/core';

const status = await migrationStatus({ pool });
// status.status                : 'no_schema' | 'unstamped' | 'up_to_date' | 'older_db' | 'newer_db'
// status.appliedMigrationCount : number  (rows in pgmigrations)
// status.latestMigrationName   : string  (name of the most recent pgmigrations row, or '' if none)
// status.appliedSdkVersion     : string | null   (latest schema_version)
// status.appliedSchemaSha      : string | null
// status.packageSdkVersion     : string          (this package's version)
// status.packageSchemaSha      : string          (current build's expected schema hash)
// status.migrationHistoryStatus: 'absent' | 'missing_baseline' | 'behind' | 'current' | 'ahead'
// status.embeddingDimension    : read-only pgvector dimension drift report
```

## The lossless guarantee

Every existing production database upgrades to Phase 2 without data loss,
without unexpected DDL, and without operator intervention. All three install
paths run inside the Phase 1 advisory-lock wrapper (`MIGRATION_LOCK_ID`
unchanged), so concurrent replica boots remain safe.

### Scenario A — Fresh install on a Phase 2 release

1. `migrate()` acquires the advisory lock.
2. `pgmigrations` does not exist; the framework creates it.
3. `0001_baseline.sql` runs against the empty database — pgvector
   extension, all tables, all indexes are created.
4. Any later migrations (`0002_*`, …) run in lexical order.
5. The embedding-dimension reconciler runs against the baseline tables
   before any post-baseline migration observes their vector dimensions.
6. Any newly added empty vector columns from later migrations are reconciled
   by a final pass.
7. A row is appended to `schema_version`.
8. The lock is released.

### Scenario B — v1.0.x install with data → Phase 2 release

1. `migrate()` acquires the advisory lock.
2. `pgmigrations` does not exist, or it exists but has no applied rows because
   a prior migration attempt stopped before stamping anything.
3. **Pre-framework check**: data tables exist (for example, `memories`,
   `memory_claims`, `episodes`) but `pgmigrations` does not. This is a
   pre-Phase-2 install.
4. The runner asks `node-pg-migrate` to create `pgmigrations` and fake-apply
   the baseline file using its own bookkeeping path.
5. **`0001_baseline` is stamped as applied without running it**. The resulting
   framework row is equivalent to:
   ```sql
   INSERT INTO pgmigrations (name, run_on) VALUES ('0001_baseline', NOW());
   ```
6. The embedding-dimension reconciler runs against the existing live schema.
   Non-empty tables that need a dimension change still raise
   `EmbeddingDimensionMismatch` rather than silently mutating live rows.
7. The framework's view now matches reality. Any post-baseline
   migrations (`0002_*`, …) run against the live schema.
8. A final reconciler pass adjusts any empty vector columns introduced by
   post-baseline migrations.
9. The runtime creates `schema_version` if needed and appends a row.
10. The lock is released.

If `pgmigrations` exists with rows but does not contain `0001_baseline`,
`migrate()` throws `MigrationHistoryMismatch`. That state is not safely
inferable: running baseline DDL could touch live tables, while stamping it
blindly could hide a corrupt framework history.

Baseline DDL does not touch existing tables. Existing rows, columns,
indexes, check constraints, and foreign keys all survive byte-for-byte.

### Scenario C — Phase 1 install with data → Phase 2 release

Identical to Scenario B except `schema_version` already exists. The
upgrade appends a new row rather than creating the table.

### Enforcement

Two test suites make the guarantee machine-checkable:

- **`baseline-schema-equivalence.test.ts`** — the CI gate. Builds a fresh
  Phase 2 schema on one DB and an upgrade-path schema (legacy `schema.sql`
  fixture applied, then Phase 2 `migrate()` invoked) on another, and
  asserts the schema-only structural snapshot is identical modulo the
  framework-bookkeeping tables (`pgmigrations`, `schema_version`).
- **The Phase 1 data-preservation suite** — carried forward unchanged.
  Seeds representative legacy rows across the core-owned tables,
  snapshots them, runs `migrate()`, and asserts every row, primary key,
  foreign-key relationship, JSON metadata field, timestamp, and
  representative vector survives the migration.

## migrate() / migrationStatus() compatibility

The public surface is signature-compatible with Phase 1.

| Symbol                       | Status                                                                |
|------------------------------|-----------------------------------------------------------------------|
| `migrate(opts?)`             | Unchanged signature; internals rewritten on top of `node-pg-migrate`. |
| `MigrateOptions`             | Unchanged.                                                            |
| `MigrateResult.ranSchemaSql` | Semantics shifted from "we ran `schema.sql`" to "this call executed the migration runner path". The Phase 1 advisory-lock-loser path still reports `false`. |
| `MigrateResult.schemaVersion`| Unchanged. The row written/read still carries `sdkVersion`, `schemaSha256`, `appliedAt`, `notes`. |
| `MigrateResult.reconciledEmbeddingDimension` | Unchanged.                                                            |
| `MigrationLockTimeout`       | Unchanged. Same constructor; same `MIGRATION_LOCK_ID`.                |
| `EmbeddingDimensionMismatch` | Unchanged.                                                            |
| `migrationStatus(opts?)`     | Unchanged signature; result gains two read-only fields.               |
| `MigrationStatus.status`     | Unchanged enum (`up_to_date` / `older_db` / `newer_db` / `unstamped` / `no_schema`). |
| `MigrationStatus.appliedMigrationCount` | **New.** Row count from `pgmigrations`.                             |
| `MigrationStatus.latestMigrationName`   | **New.** Name of the most recent `pgmigrations` row, or `''`.       |

TypeScript catches any drift in `MigrateOptions` / `MigrateResult` at build
time; `migration-api.test.ts` exercises the runtime contract.

The CLI (`atomicmemory-core migrate`, or `npm run migrate`) is unchanged
from the caller's perspective: exits `0` on success, prints a summary on
stdout, prints the error and exits `1` on failure. Replicas booting in
parallel are serialized by the advisory lock — running `migrate()` from
every replica's startup remains safe.

## Adding a new migration

Contributors add a new file under `src/db/migrations/` whenever a schema
change ships. Two strict rules:

1. **Existing migration files are immutable.** Once a file has shipped in
   any release tag, it cannot be edited, renamed, or deleted. Mutating a
   shipped baseline breaks Scenario B's "stamp without running" guarantee,
   because fresh and upgraded databases would diverge. The
   `migration-files-no-rewrite.test.ts` CI guard rejects any PR that
   touches an already-shipped filename.
2. **Filenames are strictly monotonic.** Each new file uses a higher
   `NNNN_` prefix than every existing one, no gaps. The
   `migration-files-monotonic.test.ts` guard enforces this.

Workflow for adding a migration:

```bash
# Author the migration. Phase 2 ships only SQL migrations; the build, the
# runtime fail-closed checks, and the schema-hash manifest all assume
# `.sql` files. If a future change requires conditional logic (for example,
# dim-aware DDL) the packaging path (build copy step, hash manifest, runtime
# loader) must be expanded first — do not commit a `.js`/`.ts` migration
# until that lands.
$EDITOR src/db/migrations/0002_descriptive_name.sql

# Run the full suite locally. The baseline-equivalence and DAG sanity
# tests run as part of `npm test`.
npm test

# Verify the migration applies cleanly against the test database.
npm run migrate:test

# Inspect the result.
psql "$DATABASE_URL" -c 'SELECT name, run_on FROM pgmigrations ORDER BY id'
```

For non-additive change (drop column, rename, backfill, constraint change),
write a paired `down()` so the immediate-prior state can be restored during
the deploy window. Down migrations beyond one revision are an operator
decision, not a framework feature.

## Provenance changelog

`docs/db/changelog/` holds historical SQL files that documented the
schema evolution before Phase 2 reclaimed `src/db/migrations/` as the
runtime migration folder. They are references only — runtime migration
execution does not read them. Keep them for audit, but do not assume any
relationship between filenames there and rows in `pgmigrations`.

## Design Notes

Public operator guidance belongs in this file. Prior-art comparisons and
research notes should be published only when they are ready to stand alone.
