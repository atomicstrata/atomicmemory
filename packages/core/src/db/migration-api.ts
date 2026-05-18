/**
 * Public surface of the Phase 2 programmatic migration API.
 *
 * Library consumers import `migrate` / `migrationStatus` from
 * `@atomicmemory/core` (re-exported via `src/index.ts`); the legacy CLI in
 * `migrate.ts` is a thin wrapper around `migrate()`. Implementation is
 * split across:
 *   - `migration-lock.ts`     advisory lock + pool helpers + lock-id constant
 *   - `migration-schema.ts`   migrations-dir read / sha256 / package version
 *   - `migration-version.ts`  `schema_version` table reads, stamps, table probes
 *   - `migration-status.ts`   `migrationStatus()` read-only query
 *
 * Phase 2 invariants: errors are thrown, Phase 1 advisory locking remains the
 * coordination layer, and `MigrateOptions` / `MigrateResult` stay stable.
 * `ranSchemaSql` now means "this call executed the migration runner path".
 *
 * Three install states are detected and dispatched correctly:
 *       fresh           → run all migration files (baseline + successors).
 *       pre_phase_2     → fail-closed audit of the existing schema (see
 *                         `./migration-baseline-validator.ts`); on success,
 *                         ask node-pg-migrate to fake-stamp the baseline as
 *                         applied (no DDL touches existing tables), reconcile
 *                         vector dimensions, then let the framework run any
 *                         post-baseline files.
 *                         On failure, `BaselineSchemaMismatch` propagates
 *                         without writing to either bookkeeping table.
 *       phase_2_current → run only the framework-detected pending migrations.
 * Concurrent peers serialize on the advisory lock. Embedding-dimension
 * reconciliation is delegated to `reconcileEmbeddingDimension`; reconciler
 * errors propagate.
 *
 * Plan reference: docs/db/migrations.md.
 */

import type { PoolClient } from 'pg';
import { runner as runMigrations } from 'node-pg-migrate';

import {
  resolveMigrationRuntimeOptions,
  type ResolvedMigrationRuntimeOptions,
} from './migration-defaults.js';
import {
  acquireAdvisoryLock,
  acquirePool,
  DEFAULT_LOCK_TIMEOUT_MS,
  releaseAdvisoryLock,
  releasePool,
  type PoolAcquireOptions,
} from './migration-lock.js';
import {
  buildAppliedSql,
  buildSchemaNotes,
  listMigrationFilenames,
  MIGRATIONS_DIR,
  readPackageVersion,
  sha256Hex,
} from './migration-schema.js';
import {
  BASELINE_MIGRATION_NAME,
  PGMIGRATIONS_TABLE,
} from './migration-history.js';
import { detectInstallState } from './migration-install-state.js';
import {
  readLatestSchemaVersionOrAbsent,
  stampSchemaVersion,
  type SchemaVersionRow,
} from './migration-version.js';
import { validateBaselineSchema } from './migration-baseline-validator.js';
import { reconcileEmbeddingDimension } from './reconcilers.js';

// Re-export lock primitives so tests and operators can verify the exact
// advisory-lock contract without duplicating constants.
export { MIGRATION_LOCK_ID, MigrationLockTimeout } from './migration-lock.js';
export { BaselineSchemaMismatch } from './migration-baseline-validator.js';
export { MigrationHistoryMismatch } from './migration-history.js';
export {
  migrationStatus,
  type EmbeddingDimensionStatus,
  type EmbeddingDimensionStatusValue,
  type MigrationHistoryStatus,
  type MigrationStatus,
  type MigrationStatusOptions,
} from './migration-status.js';

export interface MigrateOptions extends PoolAcquireOptions {
  /**
   * Override embedding dimensions. Defaults to the validated runtime config.
   * Passed through to the post-migration reconciler.
   */
  embeddingDimensions?: number;
  /**
   * Strip HNSW pgvector indexes from the package-applied-bytes hash. Test-only
   * compatibility shim carried over from Phase 1; does NOT affect which
   * migrations run against the database.
   */
  skipVectorIndexes?: boolean;
  /**
   * Maximum time to wait for the migration advisory lock before giving up.
   * Defaults to 60_000 (60s). When exceeded, throws `MigrationLockTimeout`.
   */
  lockTimeoutMs?: number;
}

export interface MigrateResult {
  /**
   * True when this call moved the database forward — either by applying one
   * or more migration files, or by stamping the baseline as applied on a
   * pre-Phase-2 install. False only on the concurrent-peer-winner path
   * where another caller's stamp matched our intended package fingerprint
   * before we acquired the lock.
   */
  ranSchemaSql: boolean;
  /** The `schema_version` row written (or last-read) by this call. */
  schemaVersion: {
    sdkVersion: string;
    schemaSha256: string;
    appliedAt: Date;
    notes: string | null;
  };
  /**
   * True if the embedding-dimension reconciler altered any column. False when
   * the schema already matched the configured dimension. Reflects the actual
   * return value from `./reconcilers.js::reconcileEmbeddingDimension`.
   */
  reconciledEmbeddingDimension: boolean;
}

interface MigrationPlan {
  sdkVersion: string;
  embeddingDimensions: number;
  skipVectorIndexes: boolean;
  appliedSha: string;
  notes: string;
}

type ResolvedMigrateOptions = ResolvedMigrationRuntimeOptions<MigrateOptions>;

/**
 * Library entry point: bring the database to the latest migration head,
 * coordinate replicas via a Postgres advisory lock, stamp `schema_version`,
 * and reconcile embedding-dimension drift. Safe to call from any process;
 * never calls `process.exit`. See `MigrateOptions` for overrides.
 *
 * Phase 2 detail: on a pre-Phase-2 install (data tables exist but
 * `pgmigrations` does not) the baseline migration is *stamped* as applied
 * rather than re-executed, so no DDL touches existing rows. Subsequent
 * post-baseline migrations run normally.
 */
export async function migrate(opts: MigrateOptions = {}): Promise<MigrateResult> {
  const resolved = await resolveMigrateOptions(opts);
  const handle = acquirePool(resolved);
  const lockTimeoutMs = opts.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const plan = buildMigrationPlan(resolved);
  const client = await handle.pool.connect();
  try {
    return await runWithLock(client, plan, lockTimeoutMs);
  } finally {
    client.release();
    await releasePool(handle);
  }
}

async function resolveMigrateOptions(
  opts: MigrateOptions,
): Promise<ResolvedMigrateOptions> {
  return resolveMigrationRuntimeOptions(opts);
}

function buildMigrationPlan(opts: ResolvedMigrateOptions): MigrationPlan {
  const appliedSql = buildAppliedSql(
    opts.embeddingDimensions,
    opts.skipVectorIndexes,
  );
  return {
    sdkVersion: readPackageVersion(),
    embeddingDimensions: opts.embeddingDimensions,
    skipVectorIndexes: opts.skipVectorIndexes,
    appliedSha: sha256Hex(appliedSql),
    notes: buildSchemaNotes({
      skipVectorIndexes: opts.skipVectorIndexes,
      embeddingDimensions: opts.embeddingDimensions,
    }),
  };
}

async function runWithLock(
  client: PoolClient,
  plan: MigrationPlan,
  lockTimeoutMs: number,
): Promise<MigrateResult> {
  const preLockStamp = await readLatestSchemaVersionOrAbsent(client);
  await acquireAdvisoryLock(client, lockTimeoutMs);
  try {
    const postLockStamp = await readLatestSchemaVersionOrAbsent(client);
    if (postLockStamp && peerBeatUs(preLockStamp, postLockStamp, plan)) {
      return await reconcileAndReportPeerWin(client, plan, postLockStamp);
    }
    return await applyAndStamp(client, plan);
  } finally {
    await releaseAdvisoryLock(client);
  }
}

/**
 * True when a concurrent peer ran the migration framework and stamped a
 * matching `schema_version` row while we were waiting on the advisory lock.
 * Detected by: post-lock stamp matches our intended SHA + sdk version AND
 * is strictly newer than the pre-lock snapshot (or pre-lock was absent).
 * Serial re-runs where the same stamp existed both pre- and post-lock are
 * NOT treated as peer wins; they fall through to `applyAndStamp` which
 * is a no-op for migrations (framework reports nothing pending) but still
 * appends a fresh `schema_version` row for visibility.
 */
function peerBeatUs(
  preLock: SchemaVersionRow | null,
  postLock: SchemaVersionRow,
  plan: MigrationPlan,
): boolean {
  if (!stampMatchesPlan(postLock, plan)) return false;
  if (!preLock) return true;
  return postLock.applied_at.getTime() > preLock.applied_at.getTime();
}

function stampMatchesPlan(stamp: SchemaVersionRow, plan: MigrationPlan): boolean {
  return stamp.schema_sha256 === plan.appliedSha
    && stamp.sdk_version === plan.sdkVersion;
}

async function reconcileAndReportPeerWin(
  client: PoolClient,
  plan: MigrationPlan,
  peerStamp: SchemaVersionRow,
): Promise<MigrateResult> {
  // Peer beat us on migrations, but our local embedding-dim config may still
  // differ from the peer's. Run the reconciler so any pending column-type
  // change is applied (or we fail loudly via the reconciler's error).
  const reconcileResult = await reconcileEmbeddingDimension(client, plan.embeddingDimensions);
  return {
    ranSchemaSql: false,
    schemaVersion: rowToStampPayload(peerStamp),
    reconciledEmbeddingDimension: reconcileResult.reconciled,
  };
}

async function applyAndStamp(
  client: PoolClient,
  plan: MigrationPlan,
): Promise<MigrateResult> {
  const { state: installState } = await detectInstallState(client);
  console.log(
    `[migration-api] Phase 2 migrate (installState=${installState}, ` +
      `embeddingDimensions=${plan.embeddingDimensions}, ` +
      `skipVectorIndexes=${plan.skipVectorIndexes}, ` +
      `sha=${plan.appliedSha.slice(0, 12)}…)`,
  );
  if (installState === 'pre_phase_2') {
    // Fail-closed audit BEFORE any write. A partial v1.0.x install, a
    // stray sentinel table, or a missing required extension must not be
    // stamped as if it were a real baseline — that would let the framework
    // believe a broken schema is canonical. BaselineSchemaMismatch
    // propagates and the surrounding finally releases the advisory lock
    // without ever touching pgmigrations or schema_version.
    await validateBaselineSchema(client);
    await stampBaselineAsApplied(client);
  } else if (installState === 'fresh') {
    await runBaselineMigration(client);
  }
  // Reconcile immediately after the baseline exists or is stamped, before any
  // future post-baseline migration can observe baseline vector columns at the
  // frozen default dimension. The final pass after pending migrations catches
  // empty vector columns added by later migrations.
  const baselineReconcile = await reconcileEmbeddingDimension(
    client,
    plan.embeddingDimensions,
  );
  await runFrameworkMigrationsToHead(client);
  const finalReconcile = await reconcileEmbeddingDimension(client, plan.embeddingDimensions);
  const stamped = await stampSchemaVersion(client, {
    sdkVersion: plan.sdkVersion,
    schemaSha256: plan.appliedSha,
    notes: plan.notes,
  });
  return {
    ranSchemaSql: true,
    schemaVersion: rowToStampPayload(stamped),
    reconciledEmbeddingDimension:
      baselineReconcile.reconciled || finalReconcile.reconciled,
  };
}

/**
 * Pre-Phase-2 cutover path: ask node-pg-migrate to fake-stamp the baseline
 * WITHOUT executing the baseline DDL. The data tables already exist; re-running
 * `0001_baseline.sql` would either no-op (idempotent statements) or attempt to
 * revalidate constraints — neither outcome is desirable when production data is
 * sitting in those tables.
 */
async function stampBaselineAsApplied(client: PoolClient): Promise<void> {
  await runMigrationRunner(client, { file: BASELINE_MIGRATION_NAME, fake: true });
}

async function runBaselineMigration(client: PoolClient): Promise<void> {
  await runMigrationRunner(client, { file: BASELINE_MIGRATION_NAME });
}

/**
 * Drive node-pg-migrate to apply every migration file under
 * `MIGRATIONS_DIR` that is not already recorded in `pgmigrations`. We pass
 * our own checked-out client so the framework runs inside the connection
 * that holds the Phase 1 advisory lock, and disable the framework's own
 * advisory-lock layer to avoid double-locking.
 *
 * On a fresh database this applies successors after `runBaselineMigration`.
 * On a pre-Phase-2 install (after `stampBaselineAsApplied`) the framework sees
 * the baseline as already-recorded and runs only `0002_*` and later. On a
 * `phase_2_current` install it runs only the pending tail.
 *
 * `listMigrationFilenames()` is invoked first as a fail-closed precondition:
 * a missing/empty migrations directory or a missing baseline throws before
 * `node-pg-migrate` is allowed to create `pgmigrations` and stamp progress
 * against an empty DB. The previous "tolerate empty" fast path could let a
 * misbuilt package mark a DB as migrated without ever applying DDL; that
 * was the audit finding this guards against.
 */
async function runFrameworkMigrationsToHead(client: PoolClient): Promise<void> {
  await runMigrationRunner(client);
}

async function runMigrationRunner(
  client: PoolClient,
  opts: { file?: string; fake?: boolean } = {},
): Promise<void> {
  // Side-effect call: validates the shipped migration set before letting the
  // framework touch the database. Throws on missing dir / no .sql files /
  // missing 0001_baseline.sql / empty file. Return value intentionally
  // discarded — node-pg-migrate enumerates the directory itself.
  listMigrationFilenames();
  await runMigrations({
    dbClient: client,
    dir: MIGRATIONS_DIR,
    migrationsTable: PGMIGRATIONS_TABLE,
    direction: 'up',
    file: opts.file,
    fake: opts.fake,
    // We hold MIGRATION_LOCK_ID for the duration of runWithLock; disable
    // node-pg-migrate's own advisory lock so the two coordination layers
    // don't fight or accidentally double-acquire.
    noLock: true,
    // Keep each migrate() call atomic when all pending migrations support
    // transactions. A future migration that needs non-transactional DDL must
    // be a JS/TS migration that calls pgm.noTransaction().
    singleTransaction: true,
    log: forwardFrameworkLog,
  });
}

function forwardFrameworkLog(message: string): void {
  console.log(`[node-pg-migrate] ${message}`);
}

function rowToStampPayload(row: SchemaVersionRow): MigrateResult['schemaVersion'] {
  return {
    sdkVersion: row.sdk_version,
    schemaSha256: row.schema_sha256,
    appliedAt: row.applied_at,
    notes: row.notes,
  };
}
