/**
 * Shared Postgres helpers for embedding-dimension reconciler integration tests.
 *
 * The reconciler tests intentionally operate against real pgvector columns in
 * isolated schemas. Keeping the schema reset and typmod inspection in one
 * helper avoids copy-pasted catalog SQL while preserving the full database path.
 */

import pg from 'pg';
import type { afterAll, beforeAll, beforeEach } from 'vitest';

type AsyncLifecycleHook = typeof afterAll | typeof beforeAll | typeof beforeEach;

interface ReconcilerSchemaLifecycle {
  readonly afterAll: AsyncLifecycleHook;
  readonly beforeAll: AsyncLifecycleHook;
  readonly beforeEach: AsyncLifecycleHook;
  readonly pool: pg.Pool;
  readonly schema: string;
}

export function registerReconcilerSchemaLifecycle(
  lifecycle: ReconcilerSchemaLifecycle,
): void {
  lifecycle.beforeAll(async () => {
    await lifecycle.pool.query('CREATE EXTENSION IF NOT EXISTS vector');
  });
  lifecycle.beforeEach(async () => {
    await resetReconcilerTestSchema(lifecycle.pool, lifecycle.schema);
  });
  lifecycle.afterAll(async () => {
    await dropReconcilerTestSchema(lifecycle.pool, lifecycle.schema);
    await lifecycle.pool.query('RESET search_path');
    await lifecycle.pool.end();
  });
}

async function resetReconcilerTestSchema(
  pool: pg.Pool,
  schema: string,
): Promise<void> {
  const quoted = pg.escapeIdentifier(schema);
  await pool.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`);
  await pool.query(`CREATE SCHEMA ${quoted}`);
  await setReconcilerSearchPath(pool, schema);
}

async function dropReconcilerTestSchema(
  pool: pg.Pool,
  schema: string,
): Promise<void> {
  const quoted = pg.escapeIdentifier(schema);
  await pool.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`);
}

export async function setReconcilerSearchPath(
  client: pg.Pool | pg.PoolClient,
  schema: string,
): Promise<void> {
  const quoted = pg.escapeIdentifier(schema);
  await client.query(`SET search_path TO ${quoted}, public`);
}

export async function readVectorColumnDimension(
  pool: pg.Pool,
  schema: string,
  table: string,
  column: string,
): Promise<number | null> {
  const { rows } = await pool.query<{ typmod: number }>(
    `SELECT a.atttypmod AS typmod
       FROM pg_attribute a
       JOIN pg_class     c ON a.attrelid = c.oid
       JOIN pg_namespace n ON c.relnamespace = n.oid
      WHERE n.nspname = $1 AND c.relname = $2 AND a.attname = $3`,
    [schema, table, column],
  );
  return rows.length === 0 ? null : rows[0].typmod;
}
