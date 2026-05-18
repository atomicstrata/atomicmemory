/**
 * Shared assertions for migration data-preservation tests.
 *
 * Phase 1 and Phase 2 both promise that legacy rows survive migration without
 * byte-level drift. These helpers keep that contract expressed once while each
 * scenario test still controls when stamps or framework state are added.
 */

import { expect } from 'vitest';
import pg from 'pg';
import { migrate } from '../migration-api.js';
import { applyLegacySchema } from './migration-test-helpers.js';
import {
  auditForeignKeys,
  seedLegacyFixtureData,
  snapshotAllSeededTables,
  type SeedIds,
} from './migration-seed-fixtures.js';

export async function applyLegacySchemaAndSeed(pool: pg.Pool): Promise<SeedIds> {
  await applyLegacySchema(pool);
  return seedLegacyFixtureData(pool);
}

export async function expectSeededRowsPreservedAcrossMigrate(
  pool: pg.Pool,
): Promise<void> {
  const before = await snapshotAllSeededTables(pool);
  await migrate({ pool });
  const after = await snapshotAllSeededTables(pool);
  expect(after).toEqual(before);
}

export async function expectSeededForeignKeysResolvable(
  pool: pg.Pool,
  ids: SeedIds,
): Promise<void> {
  const audit = await auditForeignKeys(pool, ids);
  expect(audit.memoryEpisodeMatches).toBe(true);
  expect(audit.claimVersionClaimMatches).toBe(true);
  expect(audit.claimVersionMemoryMatches).toBe(true);
  expect(audit.evidenceClaimVersionMatches).toBe(true);
  expect(audit.memoryEntityMemoryMatches).toBe(true);
  expect(audit.memoryEntityEntityMatches).toBe(true);
  expect(audit.rawDocumentSourceMatches).toBe(true);
  expect(audit.documentChunkDocumentMatches).toBe(true);
}
