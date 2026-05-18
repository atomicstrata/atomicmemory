/**
 * Phase 2 — Pre-baseline-stamp schema validation (fail-closed audit).
 *
 * Audit motivation: `detectInstallState()` classifies any DB with one v1.0.x
 * sentinel table as `pre_phase_2`. Before this guard landed, the runner then
 * called `stampBaselineAsApplied()` unconditionally, recording `0001_baseline`
 * in `pgmigrations` even when the live schema was structurally invalid —
 * a stray `memories` table from an unrelated app, a partial install missing
 * `memory_claims`, or a DB whose `vector` extension had been dropped.
 *
 * The validator (`migration-baseline-validator.ts:validateBaselineSchema`)
 * runs immediately before stamping. On any structural deficiency it throws
 * `BaselineSchemaMismatch` and the migration runner's surrounding `finally`
 * releases the advisory lock without ever writing to `pgmigrations` or
 * `schema_version`.
 *
 * These tests pin the contract:
 *   - A real legacy schema is accepted (covered cross-suite by
 *     cutover-scenarios.test.ts; restated here for locality).
 *   - A partial sentinel-only schema is rejected; no bookkeeping written.
 *   - A stray `memories` table with the wrong column shape is rejected;
 *     no bookkeeping written.
 *   - A schema missing a required extension is rejected; no bookkeeping
 *     written.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  BaselineSchemaMismatch,
  migrate,
} from '../migration-api.js';
import {
  applyLegacySchema,
  useMigrationTestPool,
} from './migration-test-helpers.js';

const pool = useMigrationTestPool({ beforeEach, afterAll });

describe('Phase 2 — baseline schema validator', () => {
  it('accepts a real legacy v1.0.x schema and stamps the baseline', async () => {
    await applyLegacySchema(pool);

    await expect(migrate({ pool })).resolves.toBeDefined();

    expect(await pgmigrationsCount()).toBe(1);
    expect(await schemaVersionCount()).toBe(1);
  });

  it('rejects a partial install missing required tables', async () => {
    // Only the `memories` sentinel and its hard prerequisites exist — no
    // memory_claims, no memory_evidence, no entities. detectInstallState
    // still classifies this as pre_phase_2; the validator must catch it.
    await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
    await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await pool.query(
      `CREATE TABLE memories (
         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         user_id TEXT NOT NULL,
         content TEXT NOT NULL,
         embedding vector(768) NOT NULL
       )`,
    );

    await expectBaselineMismatchWithoutBookkeeping();
  });

  it('rejects a stray sentinel table whose columns do not match the baseline', async () => {
    // A wholly unrelated app's `memories` table happens to share the
    // canonical name but has the wrong shape (no vector embedding, no
    // user_id). The validator's column-type check must reject it.
    await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await pool.query(
      `CREATE TABLE memories (
         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         title TEXT NOT NULL,
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`,
    );

    await expectBaselineMismatchWithoutBookkeeping();
  });

  it('rejects a legacy schema that is missing the vector extension', async () => {
    await applyLegacySchema(pool);
    // Drop the extension AFTER the schema is set up so the table shapes
    // are intact but the extension probe fails. CASCADE removes the
    // pgvector-typed columns, which would in turn cause column checks to
    // fail too — both layers of the audit should surface in `missing`.
    await pool.query('DROP EXTENSION vector CASCADE');

    await expectBaselineMismatchWithoutBookkeeping();
  });

  it('reports concrete missing artifacts in the thrown error', async () => {
    await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await pool.query(
      `CREATE TABLE memories (
         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         user_id TEXT NOT NULL,
         content TEXT NOT NULL
       )`,
    );

    let captured: unknown = null;
    try {
      await migrate({ pool });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(BaselineSchemaMismatch);
    const mismatch = captured as BaselineSchemaMismatch;
    // The fixture carries only a stray `memories` shape. Confirm both the
    // missing relationship tables and the discriminating embedding column show
    // up so operators see the full picture.
    expect(mismatch.missing.some((m) => m.startsWith('table:'))).toBe(true);
    expect(mismatch.missing.some((m) => m.startsWith('column:memories.embedding')))
      .toBe(true);
  });
});

async function pgmigrationsCount(): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM pgmigrations',
  );
  return Number.parseInt(rows[0]?.count ?? '0', 10);
}

async function schemaVersionCount(): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM schema_version',
  );
  return Number.parseInt(rows[0]?.count ?? '0', 10);
}

async function expectBaselineMismatchWithoutBookkeeping(): Promise<void> {
  await expect(migrate({ pool })).rejects.toBeInstanceOf(BaselineSchemaMismatch);
  expect(await pgmigrationsExists()).toBe(false);
  expect(await schemaVersionExists()).toBe(false);
}

async function pgmigrationsExists(): Promise<boolean> {
  return tableExists('pgmigrations');
}

async function schemaVersionExists(): Promise<boolean> {
  return tableExists('schema_version');
}

async function tableExists(name: string): Promise<boolean> {
  const { rows } = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_class c JOIN pg_namespace n ON c.relnamespace = n.oid
       WHERE c.relname = $1 AND n.nspname = current_schema() AND c.relkind = 'r'
     ) AS exists`,
    [name],
  );
  return rows[0]?.exists === true;
}
