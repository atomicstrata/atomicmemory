/**
 * `schema_version` table operations for the Phase 2 migration runner.
 *
 * Owns reads (latest stamp), writes (insert new stamp), and the
 * fresh-install detection probes (`tableExists`,
 * `readLatestSchemaVersionOrAbsent`). Kept separate from the public migration
 * API so the table contract is one cohesive surface that tests and the
 * status query can pull from independently of `migrate()`.
 */

import type { Pool, PoolClient } from 'pg';

/**
 * Tables created by v1.0.x; used by `migrationStatus()` to distinguish
 * "fresh database" from "DB exists but predates Phase 1 stamping".
 */
export const CORE_TABLE_PROBE = 'episodes';

/** Postgres SQLSTATE for `undefined_table`. */
const UNDEFINED_TABLE_SQLSTATE = '42P01';

export interface SchemaVersionRow {
  sdk_version: string;
  schema_sha256: string;
  applied_at: Date;
  notes: string | null;
}

async function ensureSchemaVersionTable(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_version (
      applied_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      sdk_version     TEXT        NOT NULL,
      schema_sha256   TEXT        NOT NULL,
      notes           TEXT,
      PRIMARY KEY (applied_at)
    )`);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_schema_version_applied_at
      ON schema_version (applied_at DESC)`);
}

export async function tableExists(
  client: Pick<Pool | PoolClient, 'query'>,
  tableName: string,
): Promise<boolean> {
  const { rows } = await client.query<{ exists: boolean }>(
    'SELECT EXISTS (' +
      "  SELECT 1 FROM pg_class c JOIN pg_namespace n ON c.relnamespace = n.oid " +
      "  WHERE c.relname = $1 AND n.nspname = current_schema() AND c.relkind = 'r'" +
      ') AS exists',
    [tableName],
  );
  return rows[0]?.exists === true;
}

export async function readLatestSchemaVersion(
  client: Pick<Pool | PoolClient, 'query'>,
): Promise<SchemaVersionRow | null> {
  const { rows } = await client.query<SchemaVersionRow>(
    'SELECT sdk_version, schema_sha256, applied_at, notes FROM schema_version ' +
      'ORDER BY applied_at DESC LIMIT 1',
  );
  return rows[0] ?? null;
}

/**
 * Variant of `readLatestSchemaVersion` that returns `null` instead of
 * throwing when the `schema_version` table itself does not exist. Used at
 * the pre-lock snapshot point and inside the lock so a fresh install does
 * not require a separate `tableExists` round-trip. Any error other than
 * `undefined_table` (SQLSTATE 42P01) is propagated.
 */
export async function readLatestSchemaVersionOrAbsent(
  client: Pick<Pool | PoolClient, 'query'>,
): Promise<SchemaVersionRow | null> {
  try {
    return await readLatestSchemaVersion(client);
  } catch (err: unknown) {
    if (isUndefinedTableError(err)) return null;
    throw err;
  }
}

function isUndefinedTableError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  return code === UNDEFINED_TABLE_SQLSTATE;
}

export async function stampSchemaVersion(
  client: PoolClient,
  payload: { sdkVersion: string; schemaSha256: string; notes: string | null },
): Promise<SchemaVersionRow> {
  await ensureSchemaVersionTable(client);
  const { rows } = await client.query<SchemaVersionRow>(
    'INSERT INTO schema_version (sdk_version, schema_sha256, notes) ' +
      'VALUES ($1, $2, $3) ' +
      'RETURNING sdk_version, schema_sha256, applied_at, notes',
    [payload.sdkVersion, payload.schemaSha256, payload.notes],
  );
  if (!rows[0]) {
    throw new Error('[migration-version] INSERT INTO schema_version returned no rows');
  }
  return rows[0];
}
