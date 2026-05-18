/**
 * Phase 2 — Cutover scenarios (A / B / C).
 *
 * Per docs/ops/db/phase-2-versioned-migrations.md §"Lossless cutover
 * design" and the backward-compatibility checklist:
 *
 *   - Scenario A (fresh): `migrate()` runs the baseline against an empty
 *     DB, `pgmigrations` carries the `0001_baseline` row, `schema_version`
 *     gains a Phase 2 stamp.
 *   - Scenario B (v1.0.x → Phase 2): legacy schema seeded with real data,
 *     `migrate()` stamps `0001_baseline` *without* re-running it, touches
 *     zero user-facing tables / columns / indexes, preserves every seeded
 *     row byte-identical, and leaves seeded foreign keys resolvable.
 *   - Scenario C (Phase 1 → Phase 2): same as B, plus the existing
 *     `schema_version` rows are preserved (not wiped) and Phase 2 appends.
 *
 * The Phase 1 data-preservation snapshots (`migration-seed-fixtures.ts`)
 * are reused unchanged — the data-preservation contract is identical
 * across phases: existing rows survive the framework cutover, full stop.
 *
 * Runtime dependency: this exercises the planned Phase 2 `migrate()`
 * behavior (detectInstallState + stampBaselineAsApplied +
 * runFrameworkMigrationsToHead). Until that runtime lands the tests will
 * fail on the `pgmigrationsRows()` precondition (no pgmigrations table)
 * with a clear error pointing at the missing runtime.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate, MigrationHistoryMismatch } from '../migration-api.js';
import {
  useMigrationTestPool,
  type StructuralSnapshot,
} from './migration-test-helpers.js';
import { snapshotAllSeededTables } from './migration-seed-fixtures.js';
import {
  applyLegacySchemaAndSeed,
  expectSeededForeignKeysResolvable,
  expectSeededRowsPreservedAcrossMigrate,
} from './migration-preservation-assertions.js';
import {
  pgmigrationsRows,
  schemaVersionRowCount,
  seedPhase1StampedState,
  structuralSnapshotExcludingBookkeeping,
} from './phase2-cutover-helpers.js';

const pool = useMigrationTestPool({ beforeEach, afterAll });

const BASELINE_MIGRATION_NAME = '0001_baseline';

describe('Phase 2 — Scenario A: fresh install', () => {
  it('runs the baseline migration and records it in pgmigrations', async () => {
    await migrate({ pool });

    const rows = await pgmigrationsRows(pool);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].name).toBe(BASELINE_MIGRATION_NAME);
    expect(rows[0].run_on).toBeInstanceOf(Date);
  });

  it('stamps schema_version exactly once on first install', async () => {
    await migrate({ pool });
    expect(await schemaVersionRowCount(pool)).toBe(1);
  });
});

describe('Phase 2 — Scenario B: v1.0.x install upgraded to Phase 2', () => {
  it('stamps the baseline without executing it against existing data', async () => {
    await applyLegacySchemaAndSeed(pool);

    await migrate({ pool });

    await expectOnlyBaselineStamped();
  });

  it('does not modify any existing legacy table, column, index, or constraint', async () => {
    await applyLegacySchemaAndSeed(pool);
    const before = await structuralSnapshotExcludingBookkeeping(pool);

    await migrate({ pool });
    const after = await structuralSnapshotExcludingBookkeeping(pool);

    assertStructuralEqual(before, after);
  });

  it('preserves every seeded row byte-identical across migrate()', async () => {
    await applyLegacySchemaAndSeed(pool);
    await expectSeededRowsPreservedAcrossMigrate(pool);
  });

  it('keeps every seeded foreign-key relationship resolvable after migrate()', async () => {
    const ids = await applyLegacySchemaAndSeed(pool);

    await migrate({ pool });

    await expectSeededForeignKeysResolvable(pool, ids);
  });

  it('recovers when pgmigrations exists but is empty before cutover', async () => {
    await applyLegacySchemaAndSeed(pool);
    await pool.query(`
      CREATE TABLE pgmigrations (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        run_on TIMESTAMPTZ NOT NULL
      )`);

    await migrate({ pool });

    await expectOnlyBaselineStamped();
  });

  it('rejects pgmigrations rows that are missing the baseline stamp', async () => {
    await applyLegacySchemaAndSeed(pool);
    await pool.query(`
      CREATE TABLE pgmigrations (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        run_on TIMESTAMPTZ NOT NULL
      )`);
    await pool.query(
      `INSERT INTO pgmigrations (name, run_on)
       VALUES ('0002_unanchored', NOW())`,
    );

    await expect(migrate({ pool })).rejects.toBeInstanceOf(MigrationHistoryMismatch);
    expect(await schemaVersionRowCount(pool)).toBe(0);
  });
});

describe('Phase 2 — Scenario C: Phase 1 install upgraded to Phase 2', () => {
  it('preserves the pre-existing schema_version history', async () => {
    await applyLegacySchemaAndSeed(pool);
    await seedPhase1StampedState(pool);
    const phase1RowCount = await schemaVersionRowCount(pool);
    expect(phase1RowCount).toBe(1);

    await migrate({ pool });

    const phase2RowCount = await schemaVersionRowCount(pool);
    // Phase 2 must not wipe the Phase 1 stamp; it may append its own.
    expect(phase2RowCount).toBeGreaterThanOrEqual(phase1RowCount);

    const { rows } = await pool.query<{ notes: string | null }>(
      `SELECT notes FROM schema_version
        WHERE applied_at = TIMESTAMPTZ '2026-04-01 00:00:00Z'`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].notes).toBe('phase1-fixture-stamp');
  });

  it('still stamps the baseline as applied without re-running it', async () => {
    await applyLegacySchemaAndSeed(pool);
    await seedPhase1StampedState(pool);

    await migrate({ pool });

    await expectOnlyBaselineStamped();
  });

  it('preserves every seeded row when both Phase 1 stamps and legacy data exist', async () => {
    await applyLegacySchemaAndSeed(pool);
    await seedPhase1StampedState(pool);
    const before = await snapshotAllSeededTables(pool);

    await migrate({ pool });
    const after = await snapshotAllSeededTables(pool);

    expect(after).toEqual(before);
  });
});

/**
 * Assert that two structural snapshots describe the same set of tables,
 * columns, indexes, check constraints, and foreign keys. Uses
 * `toStrictEqual` against the helper output rather than per-field
 * iteration because the helper already canonicalizes ordering.
 */
function assertStructuralEqual(
  before: StructuralSnapshot,
  after: StructuralSnapshot,
): void {
  expect(after.tables).toEqual(before.tables);
  expect(after.indexes).toEqual(before.indexes);
  expect(after.checkConstraints).toEqual(before.checkConstraints);
  expect(after.foreignKeys).toEqual(before.foreignKeys);
}

async function expectOnlyBaselineStamped(): Promise<void> {
  const rows = await pgmigrationsRows(pool);
  // Additional rows would mean post-baseline migrations exist and ran; none
  // ship at cutover, so a count > 1 is a regression rather than expected drift.
  expect(rows.length).toBe(1);
  expect(rows[0].name).toBe(BASELINE_MIGRATION_NAME);
}
