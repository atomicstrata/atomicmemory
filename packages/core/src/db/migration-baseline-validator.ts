/**
 * Pre-Phase-2 baseline-schema validator.
 *
 * `detectInstallState()` classifies a database as `pre_phase_2` whenever a
 * single v1.0.x sentinel table exists. That probe is intentionally cheap, but
 * it is not sufficient to authorize stamping `0001_baseline` as applied:
 *
 *   - A partial v1.0.x install that crashed midway through `schema.sql` may
 *     have created `memories` but skipped `memory_claims` / `memory_evidence`.
 *   - A wholly unrelated application could have its own `memories` table with
 *     entirely different columns sharing the namespace.
 *   - The `vector` or `pgcrypto` extensions may have been dropped or never
 *     installed.
 *
 * Stamping `0001_baseline` under any of those conditions would lie to the
 * migration framework: subsequent `migrate()` calls would treat the broken
 * schema as canonical and run `0002_*` migrations on top of it, almost
 * certainly failing in confusing ways or — worse — succeeding while leaving
 * the database in an unrecoverable state.
 *
 * This module performs a fail-closed structural audit before the baseline is
 * stamped. It executes only `SELECT` statements; nothing is created, altered,
 * or dropped. On any failure it throws `BaselineSchemaMismatch` carrying a
 * concrete list of missing artifacts so the caller (and operators) can see
 * exactly what tripped the guard.
 *
 * Boundary: this validator owns the pre-stamp decision only. Install-state
 * classification (`detectInstallState`), packaging hash computation, and
 * `migrationStatus()` are owned by other modules and are not touched here.
 */

import type { PoolClient } from 'pg';

/**
 * PostgreSQL extensions that `0001_baseline.sql` requires. Both are created
 * unconditionally at the top of the baseline file, so a real v1.0.x or
 * Phase 1 database always has them. A pre_phase_2-classified database that
 * is missing either one is structurally invalid for stamping.
 */
const REQUIRED_EXTENSIONS = ['vector', 'pgcrypto'] as const;

/**
 * Tables that any genuine v1.0.x / Phase 1 install carries. The set is the
 * closure of the original-claim-storage relationships: episodes →
 * canonical_memory_objects, memories ↔ entities, and the claim/version/
 * evidence chain. A pre_phase_2-classified database missing any of these
 * is partial; refusing to stamp is the only safe response.
 *
 * Deliberately narrower than the full baseline table list — those tables are
 * the "you cannot be a real install without these" core. Optional tables
 * added in later v1.0.x point releases are validated by their column shape
 * if and only if they are present (see REQUIRED_COLUMNS comment).
 */
const REQUIRED_TABLES = [
  'episodes',
  'canonical_memory_objects',
  'memories',
  'memory_claims',
  'memory_claim_versions',
  'memory_evidence',
  'entities',
  'memory_entities',
] as const;

/**
 * Required column shapes on the canary tables. The point of this layer is to
 * reject stray tables that happen to share a name with one of our canonical
 * ones: a `memories` table created by some other application is unlikely to
 * carry a pgvector-typed `embedding` column AND a TEXT `user_id` AND a TEXT
 * `content` — and certainly not all three at once with the v1.0.x layout.
 *
 * `pgTypeName` is the value Postgres reports in `pg_type.typname` for the
 * column's declared type (`text`, `vector`, `uuid`, etc.) — the same shape
 * the existing structural-snapshot helper uses, so the catalog query is the
 * authoritative source. Columns can be NOT NULL or nullable; the column
 * shape, not the nullability constraint, is what discriminates a real
 * baseline from a stray collision.
 */
const REQUIRED_COLUMNS: ReadonlyArray<{
  table: (typeof REQUIRED_TABLES)[number];
  column: string;
  pgTypeName: string;
}> = [
  { table: 'memories', column: 'embedding', pgTypeName: 'vector' },
  { table: 'memories', column: 'user_id', pgTypeName: 'text' },
  { table: 'memories', column: 'content', pgTypeName: 'text' },
  { table: 'episodes', column: 'user_id', pgTypeName: 'text' },
  { table: 'episodes', column: 'content', pgTypeName: 'text' },
  { table: 'memory_claims', column: 'user_id', pgTypeName: 'text' },
];

/**
 * Thrown by `validateBaselineSchema` when the database fails the audit.
 *
 * `missing` carries a human-readable list of missing artifacts (`extension:<name>`,
 * `table:<name>`, `column:<table>.<column>:<expected-type>`). The caller is
 * expected to surface the error verbatim so operators can repair the schema
 * (or wipe and reinstall) before retrying `migrate()`.
 */
export class BaselineSchemaMismatch extends Error {
  constructor(public readonly missing: ReadonlyArray<string>) {
    super(
      `[migration-api] Refusing to stamp 0001_baseline as applied: ` +
        `existing schema is missing ${missing.length} required artifact(s): ` +
        `${missing.join(', ')}. ` +
        `This typically means a partial v1.0.x install, a stray table sharing a ` +
        `canonical name, or a missing PostgreSQL extension. Repair the schema ` +
        `(or DROP SCHEMA public CASCADE and re-run migrate() for a fresh install) ` +
        `and retry.`,
    );
    this.name = 'BaselineSchemaMismatch';
  }
}

/**
 * Validate that a `pre_phase_2`-classified database carries the structural
 * shape required to be a real v1.0.x / Phase 1 install. Pure reads; never
 * mutates the database. Throws `BaselineSchemaMismatch` on any failure with
 * the full list of missing artifacts; returns normally on success.
 *
 * Call this immediately before `stampBaselineAsApplied()` in the migration
 * runner so a rejected schema causes the lock to be released without writing
 * to either `pgmigrations` or `schema_version`.
 */
export async function validateBaselineSchema(client: PoolClient): Promise<void> {
  const missing: string[] = [];
  await collectMissingExtensions(client, missing);
  await collectMissingTables(client, missing);
  await collectMissingColumns(client, missing);
  if (missing.length > 0) {
    throw new BaselineSchemaMismatch(missing);
  }
}

async function collectMissingExtensions(
  client: PoolClient,
  missing: string[],
): Promise<void> {
  const { rows } = await client.query<{ extname: string }>(
    'SELECT extname FROM pg_extension WHERE extname = ANY($1::text[])',
    [REQUIRED_EXTENSIONS],
  );
  const present = new Set(rows.map((row) => row.extname));
  for (const ext of REQUIRED_EXTENSIONS) {
    if (!present.has(ext)) missing.push(`extension:${ext}`);
  }
}

async function collectMissingTables(
  client: PoolClient,
  missing: string[],
): Promise<void> {
  const { rows } = await client.query<{ relname: string }>(
    "SELECT c.relname FROM pg_class c " +
      'JOIN pg_namespace n ON c.relnamespace = n.oid ' +
      "WHERE n.nspname = current_schema() AND c.relkind = 'r' " +
      'AND c.relname = ANY($1::text[])',
    [REQUIRED_TABLES],
  );
  const present = new Set(rows.map((row) => row.relname));
  for (const table of REQUIRED_TABLES) {
    if (!present.has(table)) missing.push(`table:${table}`);
  }
}

async function collectMissingColumns(
  client: PoolClient,
  missing: string[],
): Promise<void> {
  const { rows } = await client.query<{
    relname: string;
    attname: string;
    typname: string;
  }>(
    'SELECT c.relname, a.attname, t.typname ' +
      'FROM pg_attribute a ' +
      'JOIN pg_class c ON a.attrelid = c.oid ' +
      'JOIN pg_namespace n ON c.relnamespace = n.oid ' +
      'JOIN pg_type t ON a.atttypid = t.oid ' +
      'WHERE n.nspname = current_schema() ' +
      "AND c.relkind = 'r' AND NOT a.attisdropped AND a.attnum > 0",
  );
  const observed = new Map<string, string>();
  for (const row of rows) {
    observed.set(`${row.relname}.${row.attname}`, row.typname);
  }
  for (const required of REQUIRED_COLUMNS) {
    const key = `${required.table}.${required.column}`;
    const actual = observed.get(key);
    if (actual === undefined) {
      missing.push(`column:${key}:${required.pgTypeName}`);
    } else if (actual !== required.pgTypeName) {
      missing.push(`column:${key}:${required.pgTypeName} (found ${actual})`);
    }
  }
}
