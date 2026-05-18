/**
 * Shared helpers for the Phase 2 cutover and DAG-sanity tests.
 *
 * Layered on top of `./migration-test-helpers.js`. Adds:
 *
 *  - `MIGRATIONS_DIR` — the planned post-cutover location of the
 *    framework-managed migration files (`src/db/migrations/`).
 *  - `PHASE2_BOOKKEEPING_TABLES` — names of the tables that legitimately
 *    differ across cutover paths and must be excluded from structural
 *    schema-equivalence diffs.
 *  - `pgmigrationsRows()` — read the `node-pg-migrate` bookkeeping table
 *    for cutover-scenario assertions. Throws (rather than silently
 *    returning `[]`) when the table is absent so the test failure points
 *    at the missing runtime instead of a misleading empty result.
 *  - `seedPhase1StampedState()` — reconstruct the post-Phase-1 shape of
 *    `schema_version` without depending on the Phase 1 implementation,
 *    so Scenario C (Phase 1 → Phase 2) can be exercised deterministically.
 *  - `structuralSnapshotExcludingBookkeeping()` — wrap
 *    `captureStructuralSnapshot` and strip the Phase 2 bookkeeping tables
 *    so equivalence checks compare user-facing schema only.
 *  - `resetPublicSchemaForReuse()` — drop+recreate `public` mid-test for
 *    suites that need to run two full migrate() cycles in one `it()`.
 *
 * Plan reference: docs/ops/db/phase-2-versioned-migrations.md.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  captureStructuralSnapshot,
  resetPublicSchema,
  type StructuralSnapshot,
} from './migration-test-helpers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Repo-relative path to the planned Phase 2 migrations directory. The
 * DAG-sanity tests read this directory; until Phase 2 lands the directory
 * does not exist and those tests will fail with a clear assertion error
 * (the test does not crash with ENOENT — see `dag-sanity.test.ts`).
 */
export const MIGRATIONS_DIR = resolve(__dirname, '../migrations');

/**
 * Bookkeeping tables whose existence and row counts intentionally differ
 * across cutover paths. Stripped from structural diffs so the user-facing
 * schema equivalence check is not polluted by framework-owned tables.
 */
const PHASE2_BOOKKEEPING_TABLES: ReadonlySet<string> = new Set([
  'pgmigrations',
  'schema_version',
]);

export interface PgMigrationsRow {
  readonly id: number;
  readonly name: string;
  readonly run_on: Date;
}

/**
 * Read every row of node-pg-migrate's `pgmigrations` bookkeeping table in
 * insertion order. Throws with a descriptive error if the table is absent
 * so a Phase 2 cutover test failing because the runtime has not yet been
 * wired surfaces a clear message instead of an empty array.
 */
export async function pgmigrationsRows(pool: pg.Pool): Promise<PgMigrationsRow[]> {
  const { rows: present } = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = current_schema() AND table_name = 'pgmigrations'
     ) AS exists`,
  );
  if (!present[0]?.exists) {
    throw new Error(
      'pgmigrationsRows: expected `pgmigrations` table to exist. ' +
        'Phase 2 migrate() must create it on first run. Has the runtime landed?',
    );
  }
  const { rows } = await pool.query<PgMigrationsRow>(
    'SELECT id, name, run_on FROM pgmigrations ORDER BY id ASC',
  );
  return rows;
}

/**
 * Reconstruct the schema_version shape and one applied row, mimicking what
 * a Phase 1-installed DB would carry into a Phase 2 upgrade. Keeps Scenario
 * C tests independent of the (about-to-be-rewritten) Phase 1 runtime path.
 *
 * The applied_at timestamp is fixed in the past so Phase 2's own stamp
 * (appended at NOW()) is unambiguously the later row.
 */
export async function seedPhase1StampedState(
  pool: pg.Pool,
  sdkVersion: string = '1.4.0-phase1-fixture',
): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_version (
      applied_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      sdk_version     TEXT        NOT NULL,
      schema_sha256   TEXT        NOT NULL,
      notes           TEXT,
      PRIMARY KEY (applied_at)
    )`);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_schema_version_applied_at
      ON schema_version (applied_at DESC)`);
  await pool.query(
    `INSERT INTO schema_version (applied_at, sdk_version, schema_sha256, notes)
     VALUES (TIMESTAMPTZ '2026-04-01 00:00:00Z', $1,
             'phase1fixture000000000000000000000000000000000000000000000000000',
             'phase1-fixture-stamp')`,
    [sdkVersion],
  );
}

/** Number of rows currently in `schema_version`. Returns 0 if the table is absent. */
export async function schemaVersionRowCount(pool: pg.Pool): Promise<number> {
  const { rows: present } = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = current_schema() AND table_name = 'schema_version'
     ) AS exists`,
  );
  if (!present[0]?.exists) return 0;
  const { rows } = await pool.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM schema_version',
  );
  return Number.parseInt(rows[0]?.count ?? '0', 10);
}

/**
 * Structural snapshot of the user-facing schema with Phase 2 bookkeeping
 * tables (`pgmigrations`, `schema_version`) and their indexes/constraints
 * stripped, so cutover-equivalence diffs compare only what consumers see.
 */
export async function structuralSnapshotExcludingBookkeeping(
  pool: pg.Pool,
): Promise<StructuralSnapshot> {
  return filterBookkeepingTables(await captureStructuralSnapshot(pool));
}

function filterBookkeepingTables(snapshot: StructuralSnapshot): StructuralSnapshot {
  const excluded = PHASE2_BOOKKEEPING_TABLES;
  return {
    tables: snapshot.tables.filter((entry) => !excluded.has(entry.name)),
    indexes: snapshot.indexes.filter((entry) => !excluded.has(entry.table)),
    checkConstraints: snapshot.checkConstraints.filter(
      (entry) => !excluded.has(entry.table),
    ),
    foreignKeys: snapshot.foreignKeys.filter((entry) => !excluded.has(entry.table)),
  };
}

/**
 * Drop and recreate the `public` schema mid-test. Used when a single
 * `it()` block needs to run two independent migrate() cycles from an empty
 * baseline (the standard `beforeEach` resets between tests, not within
 * one). Re-installs the extensions the legacy schema fixture depends on.
 */
export async function resetPublicSchemaForReuse(pool: pg.Pool): Promise<void> {
  await resetPublicSchema(pool);
}
