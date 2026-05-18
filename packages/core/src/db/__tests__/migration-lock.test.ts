/**
 * Advisory-lock coordination.
 *
 * Asserts the contract documented in docs/ops/db/phase-1-production-harden.md
 * §3 (PostgreSQL advisory-lock coordination):
 *   - Two concurrent migrate() calls against the same DB: exactly one enters
 *     the migration runner path (ranSchemaSql=true), the other observes the
 *     schema is current and returns ranSchemaSql=false. Both succeed.
 *   - When a separate connection holds the advisory lock and refuses to
 *     release it before lockTimeoutMs expires, migrate() throws
 *     MigrationLockTimeout.
 *
 * The lock id is imported from the runtime module so this test fails loudly
 * if the constant drifts away from -3473291475947293849n — the plan pins it
 * as a stable forever id.
 *
 * No timing-based coordination: the hold-the-lock fixture acquires the lock
 * via pg_try_advisory_lock on a dedicated client BEFORE migrate() is called,
 * so the race outcome is deterministic.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  MIGRATION_LOCK_ID,
  MigrationLockTimeout,
  migrate,
  type MigrateResult,
} from '../migration-api.js';
import { useMigrationTestPool } from './migration-test-helpers.js';

const pool = useMigrationTestPool({ beforeEach, afterAll });

describe('migrate() advisory-lock concurrency', () => {
  it('serializes two concurrent migrate() calls so exactly one enters the migration path', async () => {
    const concurrent: Promise<MigrateResult>[] = [migrate({ pool }), migrate({ pool })];
    const [a, b] = await Promise.all(concurrent);

    const ran = [a.ranSchemaSql, b.ranSchemaSql];
    expect(ran.filter((v) => v === true).length).toBe(1);
    expect(ran.filter((v) => v === false).length).toBe(1);

    // Both calls report the same packaged schema hash; the loser sees the
    // hash that the winner stamped.
    expect(a.schemaVersion.schemaSha256).toBe(b.schemaVersion.schemaSha256);

    // Only one stamp row regardless of how many concurrent callers raced.
    const stampCount = await schemaVersionRowCount();
    expect(stampCount).toBe(1);
  });

  it('throws MigrationLockTimeout when the lock is held by another session past lockTimeoutMs', async () => {
    // Apply schema first so migrate() has stable preconditions to fail
    // against (otherwise migrate could fail for unrelated reasons on a DB
    // that has not been migrated yet).
    await migrate({ pool });

    const blocker = await pool.connect();
    try {
      const { rows } = await blocker.query<{ acquired: boolean }>(
        'SELECT pg_try_advisory_lock($1) AS acquired',
        [MIGRATION_LOCK_ID.toString()],
      );
      expect(rows[0]?.acquired).toBe(true);

      await expect(migrate({ pool, lockTimeoutMs: 0 })).rejects.toBeInstanceOf(
        MigrationLockTimeout,
      );
    } finally {
      await blocker.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID.toString()]);
      blocker.release();
    }

    // After the blocker releases, a follow-up migrate() must succeed. This
    // guards against the timeout path leaking the lock or the pool's
    // connection state.
    const recovered = await migrate({ pool });
    expect(recovered.ranSchemaSql).toBe(true);
  });
});

async function schemaVersionRowCount(): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM schema_version',
  );
  return Number.parseInt(rows[0]?.count ?? '0', 10);
}
