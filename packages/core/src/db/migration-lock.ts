/**
 * Postgres advisory-lock coordination for the Phase 1 migration runner.
 *
 * Exposes a single fixed lock id and a poll-based acquire helper that uses
 * `pg_try_advisory_lock` (not the blocking `pg_advisory_lock`). The blocking
 * form offers no timeout control; the try-loop is the only shape that lets
 * library callers fail with `MigrationLockTimeout` instead of blocking a host
 * process indefinitely.
 *
 * Also owns the connection-pool helper pair so call sites that need both
 * a pool and a lock can import from a single coordination module.
 */

import pg from 'pg';
import type { Pool, PoolClient } from 'pg';

/**
 * Stable 64-bit identifier for the schema-evolution advisory lock.
 *
 * Generated once from:
 *   echo -n '@atomicmemory/core::schema-migration' | sha256sum
 * then took the first 16 hex chars and reinterpreted as a signed bigint.
 * Documented so any future collision report has context. Tests import this
 * constant directly (see core-db-phase1-tests) to assert the running
 * implementation uses the exact advertised lock id.
 */
export const MIGRATION_LOCK_ID = -3473291475947293849n;

export const DEFAULT_LOCK_TIMEOUT_MS = 60_000;
const LOCK_POLL_INTERVAL_MS = 500;

/** Thrown when the migration advisory lock cannot be acquired in time. */
export class MigrationLockTimeout extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationLockTimeout';
  }
}

export interface PoolHandle {
  pool: Pool;
  /** True when this module created the pool and must close it on exit. */
  owned: boolean;
}

export interface PoolAcquireOptions {
  databaseUrl?: string;
  pool?: Pool;
}

export function acquirePool(opts: PoolAcquireOptions): PoolHandle {
  if (opts.pool) {
    return { pool: opts.pool, owned: false };
  }
  if (!opts.databaseUrl) {
    throw new Error('databaseUrl is required when pool is not provided');
  }
  const pool = new pg.Pool({
    connectionString: opts.databaseUrl,
    max: 1,
    connectionTimeoutMillis: 30_000,
    idleTimeoutMillis: 60_000,
  });
  pool.on('error', (err) => {
    console.error('[migration-lock] Unexpected idle client error:', err.message);
  });
  return { pool, owned: true };
}

export async function releasePool(handle: PoolHandle): Promise<void> {
  if (handle.owned) {
    await handle.pool.end();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export async function acquireAdvisoryLock(
  client: PoolClient,
  lockTimeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + lockTimeoutMs;
  while (!(await tryAcquireAdvisoryLock(client))) {
    if (Date.now() >= deadline) {
      throw new MigrationLockTimeout(
        `Could not acquire migration advisory lock within ${lockTimeoutMs}ms`,
      );
    }
    await sleep(LOCK_POLL_INTERVAL_MS);
  }
}

async function tryAcquireAdvisoryLock(client: PoolClient): Promise<boolean> {
  const { rows } = await client.query<{ acquired: boolean }>(
    'SELECT pg_try_advisory_lock($1) AS acquired',
    [MIGRATION_LOCK_ID.toString()],
  );
  return rows[0]?.acquired === true;
}

export async function releaseAdvisoryLock(client: PoolClient): Promise<void> {
  await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID.toString()]);
}
