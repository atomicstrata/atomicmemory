/**
 * Shared helpers for Phase 1 migration tests.
 *
 * Provides:
 *  - Isolated pg.Pool factories for migration tests (default pool uses max=1,
 *    which deadlocks the advisory-lock concurrency test that needs >= 2
 *    connections).
 *  - Clean-slate schema reset that drops and recreates the `public` schema so
 *    every test starts from a known baseline.
 *  - Legacy v1.0.2 schema application from the pinned fixture.
 *  - Deterministic per-table snapshots and seed helpers for the data-preservation
 *    and additive-change tests.
 *  - A pg_catalog/information_schema enumeration helper that acts as the
 *    structural equivalent of `pg_dump --schema-only` for backcompat diffing
 *    without shelling out — deterministic across Postgres versions.
 *
 * Phase 1 plan: docs/ops/db/phase-1-production-harden.md.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { config } from '../../config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const LEGACY_FIXTURE_PATH = resolve(__dirname, 'fixtures/legacy-schema.sql');

/**
 * Per-table snapshot returned by snapshotTable(). The `rows` field holds
 * deterministically ordered JSON projections so the snapshot equality
 * check is a single deep-equal.
 */
export interface TableSnapshot {
  readonly table: string;
  readonly rows: ReadonlyArray<Record<string, unknown>>;
}

/**
 * Structural snapshot of the database, modeled on `pg_dump --schema-only`
 * but built from pg_catalog so it's deterministic across pg_dump versions
 * and trivially diffable.
 */
export interface StructuralSnapshot {
  readonly tables: ReadonlyArray<{ name: string; columns: ReadonlyArray<ColumnSpec> }>;
  readonly indexes: ReadonlyArray<IndexSpec>;
  readonly checkConstraints: ReadonlyArray<CheckConstraintSpec>;
  readonly foreignKeys: ReadonlyArray<ForeignKeySpec>;
}

export interface ColumnSpec {
  readonly column: string;
  readonly dataType: string;
  readonly isNullable: boolean;
  readonly columnDefault: string | null;
}

export interface IndexSpec {
  readonly table: string;
  readonly index: string;
  readonly definition: string;
}

export interface CheckConstraintSpec {
  readonly table: string;
  readonly constraint: string;
  readonly definition: string;
}

export interface ForeignKeySpec {
  readonly table: string;
  readonly constraint: string;
  readonly definition: string;
}

/**
 * Create a pool dedicated to a migration test file. Uses max=4 so the
 * lock-concurrency test can hold the advisory lock on one connection while
 * migrate() races on another. The shared `pool.ts` pool is max=1 to avoid
 * HNSW deadlocks, which is the wrong shape for these tests.
 */
function createMigrationTestPool(): pg.Pool {
  return new pg.Pool({
    connectionString: config.databaseUrl,
    max: 4,
    connectionTimeoutMillis: 30_000,
    idleTimeoutMillis: 60_000,
  });
}

/** Lifecycle hooks accepted by useMigrationTestPool. */
export interface MigrationTestLifecycleHooks {
  beforeEach: (fn: () => Promise<void>) => void;
  afterAll: (fn: () => Promise<void>) => void;
}

/**
 * Wire up the migration-test pool with the shared lifecycle:
 *   - reset the public schema before every test so each `it` block starts
 *     against a known-empty baseline (migrations alter the schema itself);
 *   - close the pool at suite end so vitest doesn't hang on idle clients.
 * Returns the pool so individual tests can issue ad-hoc queries.
 */
export function useMigrationTestPool(hooks: MigrationTestLifecycleHooks): pg.Pool {
  const pool = createMigrationTestPool();
  hooks.beforeEach(async () => {
    await resetPublicSchema(pool);
  });
  hooks.afterAll(async () => {
    await pool.end();
  });
  return pool;
}

/**
 * Drop and recreate the `public` schema so the test starts from an empty
 * baseline. Re-installs the extensions that schema.sql relies on (vector
 * and pgcrypto) since CREATE SCHEMA does not preserve extensions.
 */
export async function resetPublicSchema(pool: pg.Pool): Promise<void> {
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
  await pool.query('CREATE SCHEMA public');
  await pool.query('GRANT ALL ON SCHEMA public TO public');
  await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
  await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
}

/**
 * Apply the pinned v1.0.2 schema fixture with {{EMBEDDING_DIMENSIONS}}
 * substituted to the configured value. The fixture must be byte-identical to
 * the schema shipped with @atomicmemory/core@1.0.2 — that is the contract
 * the backcompat test enforces.
 */
export async function applyLegacySchema(
  pool: pg.Pool,
  dims: number = config.embeddingDimensions,
): Promise<void> {
  const raw = readFileSync(LEGACY_FIXTURE_PATH, 'utf-8');
  const sql = raw.replace(/\{\{EMBEDDING_DIMENSIONS\}\}/g, String(dims));
  await pool.query(sql);
}

/** Build a deterministic unit-magnitude embedding for seeding. */
export function seedVector(seed: number, dims: number = config.embeddingDimensions): number[] {
  const values = Array.from({ length: dims }, (_, index) => Math.sin(seed * (index + 1) + 1));
  const norm = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0));
  return values.map((v) => v / norm);
}

/** Format a JS number[] as the pgvector text literal `[v1,v2,...]`. */
export function vectorLiteral(values: ReadonlyArray<number>): string {
  return `[${values.join(',')}]`;
}

/**
 * Capture a deterministic snapshot of a table for pre/post migration
 * equality assertions. Ordering is by the supplied columns so the snapshot
 * is reproducible. Uses `row_to_json` so JSONB / vector / array columns
 * serialize consistently across pg versions.
 */
export async function snapshotTable(
  pool: pg.Pool,
  table: string,
  orderBy: ReadonlyArray<string>,
): Promise<TableSnapshot> {
  if (orderBy.length === 0) {
    throw new Error(`snapshotTable(${table}): orderBy must contain at least one column`);
  }
  const orderClause = orderBy.map((column) => `"${column}" ASC`).join(', ');
  const sql = `SELECT row_to_json(t) AS row FROM "${table}" AS t ORDER BY ${orderClause}`;
  const { rows } = await pool.query<{ row: Record<string, unknown> }>(sql);
  return { table, rows: rows.map((entry) => entry.row) };
}

/** Existing-table check used by snapshot helpers and the legacy seed step. */
export async function tableExists(pool: pg.Pool, table: string): Promise<boolean> {
  const { rows } = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = current_schema() AND table_name = $1
     ) AS exists`,
    [table],
  );
  return rows[0]?.exists === true;
}

/** Read the structural shape of the current schema for backcompat diffing. */
export async function captureStructuralSnapshot(pool: pg.Pool): Promise<StructuralSnapshot> {
  return {
    tables: await captureTablesAndColumns(pool),
    indexes: await captureIndexes(pool),
    checkConstraints: await captureCheckConstraints(pool),
    foreignKeys: await captureForeignKeys(pool),
  };
}

async function captureTablesAndColumns(pool: pg.Pool): Promise<StructuralSnapshot['tables']> {
  const { rows } = await pool.query<{
    table_name: string;
    column_name: string;
    udt_name: string;
    is_nullable: 'YES' | 'NO';
    column_default: string | null;
  }>(
    `SELECT c.table_name, c.column_name, c.udt_name, c.is_nullable, c.column_default
       FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = current_schema()
        AND t.table_type = 'BASE TABLE'
      ORDER BY c.table_name, c.ordinal_position`,
  );
  const grouped = new Map<string, ColumnSpec[]>();
  for (const row of rows) {
    const list = grouped.get(row.table_name) ?? [];
    list.push({
      column: row.column_name,
      dataType: row.udt_name,
      isNullable: row.is_nullable === 'YES',
      columnDefault: row.column_default,
    });
    grouped.set(row.table_name, list);
  }
  return Array.from(grouped.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, columns]) => ({ name, columns }));
}

async function captureIndexes(pool: pg.Pool): Promise<StructuralSnapshot['indexes']> {
  const { rows } = await pool.query<{ tablename: string; indexname: string; indexdef: string }>(
    `SELECT tablename, indexname, indexdef FROM pg_indexes
      WHERE schemaname = current_schema()
      ORDER BY tablename, indexname`,
  );
  return rows.map((row) => ({ table: row.tablename, index: row.indexname, definition: row.indexdef }));
}

async function captureCheckConstraints(pool: pg.Pool): Promise<StructuralSnapshot['checkConstraints']> {
  const { rows } = await pool.query<{ table_name: string; constraint_name: string; definition: string }>(
    `SELECT cls.relname AS table_name, con.conname AS constraint_name,
            pg_get_constraintdef(con.oid) AS definition
       FROM pg_constraint con
       JOIN pg_class cls ON cls.oid = con.conrelid
       JOIN pg_namespace nsp ON nsp.oid = cls.relnamespace
      WHERE nsp.nspname = current_schema() AND con.contype = 'c'
      ORDER BY cls.relname, con.conname`,
  );
  return rows.map((row) => ({
    table: row.table_name,
    constraint: row.constraint_name,
    definition: row.definition,
  }));
}

async function captureForeignKeys(pool: pg.Pool): Promise<StructuralSnapshot['foreignKeys']> {
  const { rows } = await pool.query<{ table_name: string; constraint_name: string; definition: string }>(
    `SELECT cls.relname AS table_name, con.conname AS constraint_name,
            pg_get_constraintdef(con.oid) AS definition
       FROM pg_constraint con
       JOIN pg_class cls ON cls.oid = con.conrelid
       JOIN pg_namespace nsp ON nsp.oid = cls.relnamespace
      WHERE nsp.nspname = current_schema() AND con.contype = 'f'
      ORDER BY cls.relname, con.conname`,
  );
  return rows.map((row) => ({
    table: row.table_name,
    constraint: row.constraint_name,
    definition: row.definition,
  }));
}
