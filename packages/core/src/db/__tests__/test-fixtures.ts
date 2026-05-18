/**
 * Shared test fixture factories for database-layer tests.
 *
 * Re-exports shared fixtures from the central test-fixtures module
 * and adds database-specific helpers (schema setup, vector generation).
 */

import type pg from 'pg';
import { config } from '../../config.js';

import { MemoryRepository } from '../memory-repository.js';
import { ClaimRepository } from '../claim-repository.js';
import { MemoryService } from '../../services/memory-service.js';
import { migrate } from '../migration-api.js';

export { createSearchResult, createMemoryRow } from '../../services/__tests__/test-fixtures.js';

const REQUIRED_TEST_SCHEMA_TABLES = [
  'memories',
  'episodes',
  'canonical_memory_objects',
  'memory_claims',
  'memory_claim_versions',
  'memory_evidence',
  'entities',
  'memory_entities',
  'raw_sources',
  'raw_documents',
  'document_chunks',
  'storage_artifacts',
] as const;

const DOCUMENT_TABLE_DELETE_ORDER = [
  'document_chunks',
  'memory_evidence',
  'memory_claim_versions',
  'memory_claims',
  'memory_links',
  'memories',
  'raw_documents',
  'storage_artifacts',
  'raw_sources',
] as const;

/** Lifecycle hooks accepted by test context factories. */
interface TestLifecycleHooks {
  beforeAll: (fn: () => Promise<void>) => void;
  beforeEach?: (fn: () => Promise<void>) => void;
  afterAll: (fn: () => Promise<void>) => void;
}

/** Register the shared schema-setup and pool-teardown hooks. */
function registerLifecycleHooks(pool: pg.Pool, hooks: TestLifecycleHooks, cleanupFn?: () => Promise<void>) {
  hooks.beforeAll(async () => { await setupTestSchema(pool); });
  if (cleanupFn) hooks.beforeEach?.(cleanupFn);
  hooks.afterAll(async () => { await pool.end(); });
}

/**
 * Create standard integration test repos and lifecycle hooks.
 * Call within a describe() block; returns repo and claimRepo for use in tests.
 */
export function createIntegrationTestContext(pool: pg.Pool, hooks: Required<TestLifecycleHooks>) {
  const repo = new MemoryRepository(pool);
  const claimRepo = new ClaimRepository(pool);
  registerLifecycleHooks(pool, hooks, async () => { await claimRepo.deleteAll(); await repo.deleteAll(); });
  return { repo, claimRepo };
}

/**
 * Create a memory-only integration test context with lifecycle hooks.
 * Simpler variant of createIntegrationTestContext for tests that
 * do not need a ClaimRepository.
 */
export function createMemoryTestContext(pool: pg.Pool, hooks: Required<TestLifecycleHooks>) {
  const repo = new MemoryRepository(pool);
  registerLifecycleHooks(pool, hooks, async () => { await repo.deleteAll(); });
  return { repo };
}

/**
 * Create integration test context that includes a MemoryService.
 * Used by integration tests that need the full ingest/search pipeline.
 */
export function createServiceTestContext(pool: pg.Pool, hooks: TestLifecycleHooks) {
  const repo = new MemoryRepository(pool);
  const claimRepo = new ClaimRepository(pool);
  const service = new MemoryService(repo, claimRepo);
  registerLifecycleHooks(pool, hooks, async () => { await claimRepo.deleteAll(); await repo.deleteAll(); });
  return { repo, claimRepo, service };
}

/**
 * Return the memories.embedding vector(N) dimension in pgvector's
 * atttypmod encoding, or null if the table does not exist or the
 * column has no typmod set. Used to detect dim drift before re-running
 * the idempotent base schema.
 */
async function readEmbeddingColumnDim(pool: pg.Pool): Promise<number | null> {
  const { rows } = await pool.query<{ typmod: number }>(
    `SELECT atttypmod AS typmod
     FROM pg_attribute a
     JOIN pg_class c ON a.attrelid = c.oid
     WHERE c.relname = 'memories' AND a.attname = 'embedding'`,
  );
  if (rows.length === 0) return null;
  return rows[0].typmod > 0 ? rows[0].typmod : null;
}

/**
 * Apply migrations to a test database pool.
 *
 * The migration baseline is idempotent, but the reconciler refuses to alter
 * populated vector columns with the wrong dimension. When a test DB was
 * previously initialized with a different EMBEDDING_DIMENSIONS, drop and
 * recreate the public schema before running migrations so the empty-schema
 * reconciler can safely align column dimensions.
 *
 * Phase 2 also fails closed on partial pre-framework schemas. That is the
 * production-safe behavior, but this shared test helper owns its database and
 * can deterministically reset a stale partial schema left by an interrupted or
 * cross-suite test run.
 */
export async function setupTestSchema(pool: pg.Pool): Promise<void> {
  const existingDim = await readEmbeddingColumnDim(pool);
  if (
    (existingDim !== null && existingDim !== config.embeddingDimensions)
    || (await hasPartialTestSchema(pool))
  ) {
    await resetPublicSchema(pool);
  }
  await migrate({ pool });
}

async function hasPartialTestSchema(pool: pg.Pool): Promise<boolean> {
  const existing = await existingRequiredTestTables(pool);
  if (existing.size === 0) return false;
  return REQUIRED_TEST_SCHEMA_TABLES.some((table) => !existing.has(table));
}

async function existingRequiredTestTables(pool: pg.Pool): Promise<Set<string>> {
  const { rows } = await pool.query<{ table_name: string }>(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_name = ANY($1::text[])`,
    [REQUIRED_TEST_SCHEMA_TABLES],
  );
  return new Set(rows.map((row) => row.table_name));
}

async function resetPublicSchema(pool: pg.Pool): Promise<void> {
  await pool.query(`
    DROP SCHEMA IF EXISTS public CASCADE;
    CREATE SCHEMA public;
    GRANT ALL ON SCHEMA public TO public;
    CREATE EXTENSION IF NOT EXISTS vector;
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
  `);
}

/**
 * Wipe the document-pipeline tables. Used by document tests to keep
 * their `beforeEach` cleanup identical without duplicating the SQL.
 *
 * Order: chunks → memories → documents → storage_artifacts → sources
 * (FK direction). The memories wipe is included because Phase 2
 * indexing materializes provenance-linked memories. `storage_artifacts`
 * MUST come AFTER `raw_documents` because `raw_documents.storage_artifact_id`
 * REFERENCES `storage_artifacts(id)` — clearing the parent first would
 * violate the FK.
 */
export async function clearDocumentTables(pool: pg.Pool): Promise<void> {
  for (const table of DOCUMENT_TABLE_DELETE_ORDER) {
    await pool.query(`DELETE FROM ${table}`);
  }
}

/**
 * Generate a basis (one-hot) vector where the `seed`-th coordinate is 1
 * and the rest are 0. Used by temporal-state and contradictions tests
 * that want pairwise-orthogonal seed vectors with cheap-to-reason cosine
 * similarities (1 with self, 0 with every other seed). `unitVector` is
 * preferred when a smoothly-varying unit vector is what the test needs.
 */
export function basisVector(seed: number, dim: number = config.embeddingDimensions): number[] {
  return Array.from({ length: dim }, (_, index) => (index === seed ? 1 : 0));
}

/** Generate a deterministic unit vector from a seed. */
export function unitVector(seed: number): number[] {
  const values = Array.from(
    { length: config.embeddingDimensions },
    (_, index) => Math.sin(seed * (index + 1)),
  );
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  return values.map((value) => value / norm);
}

/** Offset a base vector deterministically for near-duplicate testing. */
export function offsetVector(base: number[], seed: number, scale: number): number[] {
  const values = base.map((value, index) => value + Math.cos(seed * (index + 1)) * scale);
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  return values.map((value) => value / norm);
}
