/**
 * Public migration API.
 *
 * Asserts the contract documented in docs/ops/db/phase-1-production-harden.md
 * §2 (Programmatic library API) and the tests section:
 *   - Fresh DB: migrate() returns ranSchemaSql=true, schemaVersion stamped,
 *     migrationStatus reports 'up_to_date'.
 *   - Re-run on same DB: schema_version has 2 rows, status still 'up_to_date'.
 *   - migrationStatus on an unstamped DB (drop schema_version): 'unstamped'.
 *   - migrationStatus on an empty DB: 'no_schema'.
 *
 * These tests target the API surface that claudeA/claudeB are landing in
 * `src/db/migration-api.ts`. They will fail with ERR_MODULE_NOT_FOUND
 * until that module exists; the contract here is the gate.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  migrate,
  migrationStatus,
  type MigrateResult,
  type MigrationStatus,
} from '../migration-api.js';
import { useMigrationTestPool } from './migration-test-helpers.js';

const pool = useMigrationTestPool({ beforeEach, afterAll });

describe('migrate() fresh database', () => {
  it('runs the migration path and stamps a schema_version row', async () => {
    const result: MigrateResult = await migrate({ pool });

    expect(result.ranSchemaSql).toBe(true);
    expect(result.schemaVersion.sdkVersion).toBe(currentPackageVersion());
    expect(result.schemaVersion.schemaSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.schemaVersion.appliedAt).toBeInstanceOf(Date);

    const rowCount = await schemaVersionRowCount();
    expect(rowCount).toBe(1);
  });

  it('reports up_to_date after a successful fresh migrate', async () => {
    await migrate({ pool });
    const status: MigrationStatus = await migrationStatus({ pool });

    expect(status.status).toBe('up_to_date');
    expect(status.appliedSdkVersion).toBe(currentPackageVersion());
    expect(status.appliedSchemaSha).toMatch(/^[0-9a-f]{64}$/);
    expect(status.packageSdkVersion).toBe(currentPackageVersion());
    expect(status.packageSchemaSha).toBe(status.appliedSchemaSha);
    expectBaselineMigrationCurrent(status);
    expect(status.embeddingDimension.mismatches).toEqual([]);
  });
});

describe('migrate() re-run idempotency', () => {
  it('re-running migrate appends a second schema_version row but keeps up_to_date', async () => {
    const first = await migrate({ pool });
    const second = await migrate({ pool });

    expect(first.ranSchemaSql).toBe(true);
    // Phase 2 preserves the Phase 1 "serial caller did migration work"
    // contract even when no framework migration file is pending.
    // A peer replica that loses the advisory-lock race is the only path that
    // returns ranSchemaSql=false.
    expect(second.ranSchemaSql).toBe(true);
    expect(second.schemaVersion.schemaSha256).toBe(first.schemaVersion.schemaSha256);

    const rowCount = await schemaVersionRowCount();
    expect(rowCount).toBe(2);

    const status = await migrationStatus({ pool });
    expect(status.status).toBe('up_to_date');
  });
});

describe('migrationStatus() on partial states', () => {
  it("returns 'no_schema' on an empty database with no core tables", async () => {
    const status = await migrationStatus({ pool });
    expect(status.status).toBe('no_schema');
    expect(status.appliedSdkVersion).toBeNull();
    expect(status.appliedSchemaSha).toBeNull();
    expect(status.packageSdkVersion).toBe(currentPackageVersion());
    expect(status.appliedMigrationCount).toBe(0);
    expect(status.latestMigrationName).toBe('');
    expect(status.migrationHistoryStatus).toBe('absent');
    expect(status.embeddingDimension.status).toBe('not_applicable');
  });

  it("returns 'unstamped' on a populated DB that has no schema_version table", async () => {
    await migrate({ pool });
    await pool.query('DROP TABLE schema_version');

    const status = await migrationStatus({ pool });
    expect(status.status).toBe('unstamped');
    expect(status.appliedSdkVersion).toBeNull();
    expect(status.appliedSchemaSha).toBeNull();
    expectBaselineMigrationCurrent(status);
  });

  it("returns 'older_db' when schema_version is current but pgmigrations is absent", async () => {
    await migrate({ pool });
    await pool.query('DROP TABLE pgmigrations');

    const status = await migrationStatus({ pool });
    expectOlderDbStatus(status, 0, '');
    expect(status.migrationHistoryStatus).toBe('absent');
  });

  it("returns 'older_db' when schema_version is current but migration head is stale", async () => {
    await migrate({ pool });
    await pool.query(
      `UPDATE pgmigrations SET name = '0000_previous' WHERE name = '0001_baseline'`,
    );

    const status = await migrationStatus({ pool });
    expectOlderDbStatus(status, 1, '0000_previous');
    expect(status.migrationHistoryStatus).toBe('missing_baseline');
  });

  it('reports embedding dimension drift without mutating the database', async () => {
    await migrate({ pool });
    await pool.query('CREATE TABLE drift_probe (embedding vector(3))');

    const status = await migrationStatus({ pool });

    expect(status.status).toBe('up_to_date');
    expect(status.embeddingDimension.status).toBe('mismatch');
    expect(status.embeddingDimension.mismatches).toContainEqual({
      tableName: 'drift_probe',
      columnName: 'embedding',
      currentDimension: 3,
      requiredDimension: status.embeddingDimension.requiredDimension,
    });
  });
});

function expectOlderDbStatus(
  status: Awaited<ReturnType<typeof migrationStatus>>,
  migrationCount: number,
  migrationName: string,
): void {
  expect(status.status).toBe('older_db');
  expect(status.appliedSchemaSha).toBe(status.packageSchemaSha);
  expect(status.appliedMigrationCount).toBe(migrationCount);
  expect(status.latestMigrationName).toBe(migrationName);
}

function expectBaselineMigrationCurrent(status: MigrationStatus): void {
  expect(status.appliedMigrationCount).toBe(1);
  expect(status.latestMigrationName).toBe('0001_baseline');
  expect(status.migrationHistoryStatus).toBe('current');
  expect(status.embeddingDimension.status).toBe('matches');
}

async function schemaVersionRowCount(): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM schema_version',
  );
  return Number.parseInt(rows[0]?.count ?? '0', 10);
}

function currentPackageVersion(): string {
  const packageJsonPath = fileURLToPath(new URL('../../../package.json', import.meta.url));
  const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as { version: string };
  return parsed.version;
}
