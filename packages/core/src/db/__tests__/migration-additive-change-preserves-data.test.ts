/**
 * Phase 1 — "A future additive schema change survives existing data."
 *
 * Per docs/ops/db/phase-1-production-harden.md tests section:
 *   "Use a test-only copy of schema.sql that adds one representative
 *    idempotent additive change. Start from the populated v1.0.2 fixture
 *    used by migration-data-preservation.test.ts, run the test-only
 *    migration, and assert both: the new additive schema object exists,
 *    and the seeded data snapshots are unchanged."
 *
 * Mechanics:
 *   1. Apply pinned v1.0.2 fixture and seed deterministic legacy data.
 *   2. Snapshot every seeded table.
 *   3. Run the real Phase 1 migrate() (adds schema_version).
 *   4. Apply ONE representative additive DDL — a brand-new table that
 *      cannot rewrite or touch existing rows. This stands in for "what
 *      a future Phase 1 patch would do to schema.sql." Using a new table
 *      keeps the test trivially correct: the only way the seeded data
 *      could change is if the test itself were buggy.
 *   5. Re-snapshot every seeded table and assert deep equality.
 *   6. Assert the new schema object exists.
 *
 * This is the Phase 1 answer to "will a theoretical additive DB change
 * survive existing data?" It does not bless destructive changes; the
 * first destructive migration still triggers Phase 2.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../migration-api.js';
import {
  applyLegacySchema,
  tableExists,
  useMigrationTestPool,
} from './migration-test-helpers.js';
import {
  seedLegacyFixtureData,
  snapshotAllSeededTables,
} from './migration-seed-fixtures.js';

const pool = useMigrationTestPool({ beforeEach, afterAll });

const ADDITIVE_TABLE_NAME = 'phase1_test_additive_table';
const ADDITIVE_DDL = `
  CREATE TABLE IF NOT EXISTS ${ADDITIVE_TABLE_NAME} (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    note TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_${ADDITIVE_TABLE_NAME}_created
    ON ${ADDITIVE_TABLE_NAME} (created_at DESC);
`;

describe('Phase 1 — additive schema change over populated legacy data', () => {
  it('preserves every seeded row when an additive DDL is layered on top of migrate()', async () => {
    await applyLegacySchema(pool);
    await seedLegacyFixtureData(pool);
    const before = await snapshotAllSeededTables(pool);

    await migrate({ pool });
    await pool.query(ADDITIVE_DDL);

    const after = await snapshotAllSeededTables(pool);
    expect(after).toEqual(before);
  });

  it('creates the new additive schema object', async () => {
    await applyLegacySchema(pool);
    await seedLegacyFixtureData(pool);

    await migrate({ pool });
    await pool.query(ADDITIVE_DDL);

    expect(await tableExists(pool, ADDITIVE_TABLE_NAME)).toBe(true);
    const indexExists = await indexNamePresent(`idx_${ADDITIVE_TABLE_NAME}_created`);
    expect(indexExists).toBe(true);
  });

  it('is idempotent: re-applying the additive DDL leaves seeded data unchanged', async () => {
    await applyLegacySchema(pool);
    await seedLegacyFixtureData(pool);
    const before = await snapshotAllSeededTables(pool);

    await migrate({ pool });
    await pool.query(ADDITIVE_DDL);
    await pool.query(ADDITIVE_DDL);

    const after = await snapshotAllSeededTables(pool);
    expect(after).toEqual(before);
  });
});

async function indexNamePresent(indexName: string): Promise<boolean> {
  const { rows } = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_indexes
       WHERE schemaname = current_schema() AND indexname = $1
     ) AS exists`,
    [indexName],
  );
  return rows[0]?.exists === true;
}
