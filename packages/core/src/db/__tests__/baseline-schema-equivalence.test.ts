/**
 * Phase 2 — Baseline schema equivalence (the gate).
 *
 * Per docs/ops/db/phase-2-versioned-migrations.md § "CI guard: schema
 * equivalence" and the backward-compatibility checklist:
 *
 *   "Scenario A produces a schema byte-identical (modulo
 *    framework-bookkeeping tables) to the legacy `schema.sql`."
 *
 * The user-facing schema must be identical whether the DB was created
 * via a fresh Phase 2 install (Scenario A — runs 0001_baseline.sql) or
 * via a v1.0.x → Phase 2 upgrade (Scenario B — stamps 0001_baseline
 * without running it, applies only post-baseline migrations). Drift here
 * is the exact silent-divergence failure mode Phase 2's cutover design
 * exists to prevent, so this test is the gate: do not delete it.
 *
 * Diff strategy: pg_catalog-based structural snapshot (same shape as the
 * Phase 1 backcompat test) with the `pgmigrations` and `schema_version`
 * bookkeeping tables stripped, since they intentionally hold different
 * rows along the two paths. We do not shell out to `pg_dump` here — the
 * Phase 1 helper already proved that pg_catalog enumeration is more
 * deterministic across PG minor versions than `pg_dump` text.
 *
 * Runtime dependency: this test exercises the Phase 2 migrate() public
 * API exported from `../migration-api.js`. While the Phase 2 runtime is
 * still landing, the test will fail with a missing `pgmigrations` table
 * or a schema-equivalence mismatch. When Phase 2 lands, the test must pass
 * without modification.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../migration-api.js';
import {
  applyLegacySchema,
  useMigrationTestPool,
} from './migration-test-helpers.js';
import {
  resetPublicSchemaForReuse,
  structuralSnapshotExcludingBookkeeping,
} from './phase2-cutover-helpers.js';

const pool = useMigrationTestPool({ beforeEach, afterAll });

describe('Phase 2 — baseline schema equivalence', () => {
  it('fresh install reaches the same user-facing schema as a v1.0.x → Phase 2 upgrade', async () => {
    // Scenario A: fresh Phase 2 install. migrate() runs 0001_baseline
    // (and any later migrations) against the empty database.
    await migrate({ pool });
    const fresh = await structuralSnapshotExcludingBookkeeping(pool);

    // Mid-test reset so Scenario B starts from a clean DB without
    // breaking the suite-level `beforeEach` (which only fires between
    // tests). resetPublicSchemaForReuse also re-installs `vector` and
    // `pgcrypto`, which legacy schema.sql expects.
    await resetPublicSchemaForReuse(pool);

    // Scenario B: v1.0.x install upgraded by Phase 2 migrate(). The
    // legacy fixture sets up the pre-Phase-1 schema; migrate() must
    // detect this as `pre_phase_2` and stamp 0001_baseline without
    // re-running it against the existing tables.
    await applyLegacySchema(pool);
    await migrate({ pool });
    const upgraded = await structuralSnapshotExcludingBookkeeping(pool);

    expect(upgraded).toEqual(fresh);
  });

  it('both cutover paths produce a non-empty user-facing schema', async () => {
    // Guard against the false-positive "two empty snapshots are equal".
    // If the equivalence test ever started seeing zero tables on both
    // sides, it would silently pass. This sub-test asserts a meaningful
    // floor: every cutover path must end up with the legacy core tables.
    await migrate({ pool });
    const fresh = await structuralSnapshotExcludingBookkeeping(pool);
    const tableNames = new Set(fresh.tables.map((entry) => entry.name));

    for (const required of ['memories', 'episodes', 'memory_claims']) {
      expect(tableNames.has(required)).toBe(true);
    }
  });
});
