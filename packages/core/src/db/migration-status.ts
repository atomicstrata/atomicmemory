/**
 * Read-only status query for the Phase 2 migration runner.
 *
 * `migrationStatus()` answers "is this DB ahead of, behind, or level with the
 * migrations that ship in the running package?" without modifying anything.
 * Designed to be safe to expose on an admin HTTP route and to be called from
 * deploy verification scripts.
 */

import type { Pool } from 'pg';

import {
  acquirePool,
  releasePool,
  type PoolAcquireOptions,
} from './migration-lock.js';
import {
  resolveMigrationRuntimeOptions,
  type ResolvedMigrationRuntimeOptions,
} from './migration-defaults.js';
import {
  buildAppliedSql,
  listMigrationFilenames,
  readPackageVersion,
  sha256Hex,
} from './migration-schema.js';
import {
  CORE_TABLE_PROBE,
  readLatestSchemaVersion,
  tableExists,
} from './migration-version.js';
import {
  EMPTY_MIGRATION_HISTORY,
  readMigrationHistory,
  type MigrationHistory,
} from './migration-history.js';
import {
  inspectEmbeddingDimensionStatus,
  noSchemaEmbeddingStatus,
  type EmbeddingDimensionStatus as EmbeddingDimensionStatusReport,
} from './embedding-dimension-status.js';

export type {
  EmbeddingDimensionMismatchSummary,
  EmbeddingDimensionStatus,
  EmbeddingDimensionStatusValue,
} from './embedding-dimension-status.js';

export interface MigrationStatus {
  /** Latest `sdk_version` stamped in the DB, or null if unstamped. */
  appliedSdkVersion: string | null;
  /** Latest `schema_sha256` stamped in the DB, or null if unstamped. */
  appliedSchemaSha: string | null;
  /** The running package's version (from `package.json`). */
  packageSdkVersion: string;
  /** SHA-256 of the migration bytes this package would stamp. */
  packageSchemaSha: string;
  /** Number of rows in `pgmigrations`, or 0 when the table is absent. */
  appliedMigrationCount: number;
  /** Latest migration name from `pgmigrations`, or an empty string when absent. */
  latestMigrationName: string;
  /** Coarse framework-bookkeeping health for operator diagnostics. */
  migrationHistoryStatus: MigrationHistoryStatus;
  /** Read-only pgvector dimension drift report for this runtime config. */
  embeddingDimension: EmbeddingDimensionStatusReport;
  /**
   * - `up_to_date`: DB `schema_sha256` and migration history match this package.
   * - `older_db`:   DB has an earlier `sdk_version` (running `migrate()` will fix).
   * - `newer_db`:   DB has a later `sdk_version` (rolling-deploy mismatch; safe to ignore).
   * - `unstamped`:  DB has core tables but no `schema_version` row (pre-Phase-1).
   * - `no_schema`:  DB has no `@atomicmemory` tables at all (fresh).
   */
  status: 'up_to_date' | 'older_db' | 'newer_db' | 'unstamped' | 'no_schema';
}

export interface MigrationStatusOptions extends PoolAcquireOptions {
  /**
   * Override embedding dimensions used when computing `packageSchemaSha`.
   * Defaults to `config.embeddingDimensions`. Supplied so callers can compute
   * status without triggering a network probe.
   */
  embeddingDimensions?: number;
  /** Strip vector indexes when computing the package SHA. Defaults to `config.skipVectorIndexes`. */
  skipVectorIndexes?: boolean;
}

interface PackageFingerprint {
  packageSdkVersion: string;
  packageSchemaSha: string;
  embeddingDimensions: number;
  expectedMigrationCount: number;
  expectedLatestMigrationName: string;
}

export type MigrationHistoryStatus =
  | 'absent'
  | 'missing_baseline'
  | 'behind'
  | 'current'
  | 'ahead';

type ResolvedMigrationStatusOptions =
  ResolvedMigrationRuntimeOptions<MigrationStatusOptions>;

/**
 * Read-only inspection of the DB's migration state. Never modifies the
 * database. When `embeddingDimensions` is omitted, the synchronous
 * `config.embeddingDimensions` is used so this function never probes the
 * embedding provider over the network.
 */
export async function migrationStatus(
  opts: MigrationStatusOptions = {},
): Promise<MigrationStatus> {
  const resolved = await resolveMigrationStatusOptions(opts);
  const handle = acquirePool(resolved);
  const fingerprint: PackageFingerprint = {
    packageSdkVersion: readPackageVersion(),
    packageSchemaSha: sha256Hex(
      buildAppliedSql(
        resolved.embeddingDimensions,
        resolved.skipVectorIndexes,
      ),
    ),
    embeddingDimensions: resolved.embeddingDimensions,
    ...readExpectedMigrationSummary(),
  };
  try {
    return await computeStatusUsingPool(handle.pool, fingerprint);
  } finally {
    await releasePool(handle);
  }
}

async function resolveMigrationStatusOptions(
  opts: MigrationStatusOptions,
): Promise<ResolvedMigrationStatusOptions> {
  return resolveMigrationRuntimeOptions(opts);
}

async function computeStatusUsingPool(
  pool: Pool,
  fingerprint: PackageFingerprint,
): Promise<MigrationStatus> {
  if (!(await tableExists(pool, CORE_TABLE_PROBE))) {
    return absentStatus(fingerprint, 'no_schema');
  }
  const embeddingDimension = await inspectEmbeddingDimensionStatus(
    pool,
    fingerprint.embeddingDimensions,
  );
  if (!(await tableExists(pool, 'schema_version'))) {
    return absentStatus(
      fingerprint,
      'unstamped',
      await readMigrationHistory(pool),
      embeddingDimension,
    );
  }
  const latest = await readLatestSchemaVersion(pool);
  const migrationHistory = await readMigrationHistory(pool);
  if (!latest) {
    return absentStatus(fingerprint, 'unstamped', migrationHistory, embeddingDimension);
  }
  return {
    appliedSdkVersion: latest.sdk_version,
    appliedSchemaSha: latest.schema_sha256,
    packageSdkVersion: fingerprint.packageSdkVersion,
    packageSchemaSha: fingerprint.packageSchemaSha,
    appliedMigrationCount: migrationHistory.appliedMigrationCount,
    latestMigrationName: migrationHistory.latestMigrationName,
    migrationHistoryStatus: classifyMigrationHistoryStatus(
      migrationHistory,
      fingerprint,
    ),
    embeddingDimension,
    status: classifyStatus({
      appliedSdk: latest.sdk_version,
      appliedSha: latest.schema_sha256,
      packageSdk: fingerprint.packageSdkVersion,
      packageSha: fingerprint.packageSchemaSha,
      appliedMigrations: migrationHistory,
      expectedMigrations: {
        appliedMigrationCount: fingerprint.expectedMigrationCount,
        latestMigrationName: fingerprint.expectedLatestMigrationName,
      },
    }),
  };
}

function absentStatus(
  fingerprint: PackageFingerprint,
  status: 'no_schema' | 'unstamped',
  migrationHistory: MigrationHistory = EMPTY_MIGRATION_HISTORY,
  embeddingDimension: EmbeddingDimensionStatusReport = noSchemaEmbeddingStatus(
    fingerprint.embeddingDimensions,
  ),
): MigrationStatus {
  return {
    appliedSdkVersion: null,
    appliedSchemaSha: null,
    packageSdkVersion: fingerprint.packageSdkVersion,
    packageSchemaSha: fingerprint.packageSchemaSha,
    appliedMigrationCount: migrationHistory.appliedMigrationCount,
    latestMigrationName: migrationHistory.latestMigrationName,
    migrationHistoryStatus: classifyMigrationHistoryStatus(migrationHistory, fingerprint),
    embeddingDimension,
    status,
  };
}

interface MigrationSummary {
  appliedMigrationCount: number;
  latestMigrationName: string;
}

function readExpectedMigrationSummary(): Pick<
  PackageFingerprint,
  'expectedMigrationCount' | 'expectedLatestMigrationName'
> {
  const filenames = listMigrationFilenames();
  const latest = filenames[filenames.length - 1] ?? '';
  return {
    expectedMigrationCount: filenames.length,
    expectedLatestMigrationName: stripMigrationExtension(latest),
  };
}

function stripMigrationExtension(filename: string): string {
  return filename.replace(/\.[^.]+$/, '');
}

function classifyMigrationHistoryStatus(
  history: MigrationHistory,
  fingerprint: PackageFingerprint,
): MigrationHistoryStatus {
  if (!history.tableExists) return 'absent';
  if (!history.hasBaseline) return 'missing_baseline';
  const state = compareMigrationHistory(history, {
    appliedMigrationCount: fingerprint.expectedMigrationCount,
    latestMigrationName: fingerprint.expectedLatestMigrationName,
  });
  if (state === 'matches') return 'current';
  return state === 'older' ? 'behind' : 'ahead';
}

function classifyStatus(args: {
  appliedSdk: string;
  appliedSha: string;
  packageSdk: string;
  packageSha: string;
  appliedMigrations: MigrationSummary;
  expectedMigrations: MigrationSummary;
}): MigrationStatus['status'] {
  const migrationState = compareMigrationHistory(
    args.appliedMigrations,
    args.expectedMigrations,
  );
  if (args.appliedSha === args.packageSha && migrationState === 'matches') {
    return 'up_to_date';
  }
  if (migrationState === 'newer') return 'newer_db';
  if (migrationState === 'older') return 'older_db';
  return compareSemver(args.appliedSdk, args.packageSdk) > 0 ? 'newer_db' : 'older_db';
}

function compareMigrationHistory(
  applied: MigrationSummary & Partial<Pick<MigrationHistory, 'hasBaseline'>>,
  expected: MigrationSummary,
): 'matches' | 'older' | 'newer' {
  if (applied.hasBaseline === false) return 'older';
  if (
    applied.appliedMigrationCount === expected.appliedMigrationCount
    && applied.latestMigrationName === expected.latestMigrationName
  ) {
    return 'matches';
  }
  if (
    applied.appliedMigrationCount > expected.appliedMigrationCount
    || compareMigrationName(applied.latestMigrationName, expected.latestMigrationName) > 0
  ) {
    return 'newer';
  }
  return 'older';
}

function compareMigrationName(a: string, b: string): number {
  return a.localeCompare(b, undefined, {
    numeric: true,
    sensitivity: 'variant',
    ignorePunctuation: true,
  });
}

/**
 * Numeric semver comparison. Treats non-numeric / missing segments as 0.
 * Used to classify older_db vs newer_db when migration history is current but
 * schema SHAs differ; does not implement pre-release ordering.
 */
function compareSemver(a: string, b: string): number {
  return compareNumberArrays(parseSemverParts(a), parseSemverParts(b));
}

function compareNumberArrays(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const diff = numberAt(a, i) - numberAt(b, i);
    if (diff !== 0) return diff;
  }
  return 0;
}

function numberAt(arr: number[], i: number): number {
  return arr[i] ?? 0;
}

function parseSemverParts(version: string): number[] {
  return version.split('.').map(parseNumericPart);
}

function parseNumericPart(part: string): number {
  const n = Number.parseInt(part, 10);
  return Number.isFinite(n) ? n : 0;
}
