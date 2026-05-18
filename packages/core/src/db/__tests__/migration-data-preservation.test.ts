/**
 * Phase 1 — Data-preservation contract.
 *
 * Per docs/ops/db/phase-1-production-harden.md tests section:
 *   "Apply v1.0.2 schema. Seed representative legacy data across the
 *    core-owned tables. Capture a pre-migration deterministic snapshot.
 *    Run Phase 1's migrate(). Re-read the same snapshots and assert they
 *    are identical — row counts, primary keys, FK values, text fields,
 *    JSON metadata, timestamps, and representative vector fields. Assert
 *    every seeded foreign key still resolves after migration."
 *
 * Snapshot strategy: deterministic per-table `row_to_json(t) ORDER BY pk`
 * queries (see migration-test-helpers.snapshotTable). FK audit is a
 * separate set of join queries that fail explicitly if any seeded relation
 * is broken — catches accidental delete-then-reinsert that a pure row
 * snapshot would also catch but with a worse failure message.
 *
 * Strictness: every seed-tracked table MUST exist in the pinned fixture
 * (verified by seedLegacyFixtureData) and MUST exist after migrate().
 * Helpers throw with the missing-table name rather than silently skipping.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../migration-api.js';
import { useMigrationTestPool } from './migration-test-helpers.js';
import {
  SEEDED_TABLE_PRIMARY_KEYS,
} from './migration-seed-fixtures.js';
import {
  applyLegacySchemaAndSeed,
  expectSeededForeignKeysResolvable,
  expectSeededRowsPreservedAcrossMigrate,
} from './migration-preservation-assertions.js';

const pool = useMigrationTestPool({ beforeEach, afterAll });

describe('Phase 1 migrate() preserves all legacy data', () => {
  it('keeps every seeded row byte-identical across the migrate() call', async () => {
    await applyLegacySchemaAndSeed(pool);
    await expectSeededRowsPreservedAcrossMigrate(pool);
  });

  it('keeps every seeded foreign-key relationship resolvable after migrate', async () => {
    const ids = await applyLegacySchemaAndSeed(pool);

    await migrate({ pool });

    await expectSeededForeignKeysResolvable(pool, ids);
  });

  it('does not silently drop or re-insert seeded rows (row counts stable per table)', async () => {
    await applyLegacySchemaAndSeed(pool);

    const beforeCounts = await countAllSeededTables();
    await migrate({ pool });
    const afterCounts = await countAllSeededTables();

    expect(afterCounts).toEqual(beforeCounts);
  });
});

async function countAllSeededTables(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const { table } of SEEDED_TABLE_PRIMARY_KEYS) {
    const { rows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "${table}"`,
    );
    counts[table] = Number.parseInt(rows[0]?.count ?? '0', 10);
  }
  return counts;
}
