/**
 * Read-only helpers for the node-pg-migrate bookkeeping table.
 *
 * Phase 2 keeps framework history in `pgmigrations` and semantic package
 * stamps in `schema_version`. This module centralizes the framework-history
 * probes so `migrate()` and `migrationStatus()` classify partial/corrupt
 * metadata the same way.
 */

import type { Pool, PoolClient } from 'pg';

import { tableExists } from './migration-version.js';

export const PGMIGRATIONS_TABLE = 'pgmigrations';
export const BASELINE_MIGRATION_NAME = '0001_baseline';

export interface MigrationHistory {
  readonly tableExists: boolean;
  readonly appliedMigrationCount: number;
  readonly latestMigrationName: string;
  readonly hasBaseline: boolean;
  readonly names: readonly string[];
}

export const EMPTY_MIGRATION_HISTORY: MigrationHistory = {
  tableExists: false,
  appliedMigrationCount: 0,
  latestMigrationName: '',
  hasBaseline: false,
  names: [],
};

export class MigrationHistoryMismatch extends Error {
  constructor(message: string) {
    super(`[migration-api] ${message}`);
    this.name = 'MigrationHistoryMismatch';
  }
}

export async function readMigrationHistory(
  client: Pick<Pool | PoolClient, 'query'>,
): Promise<MigrationHistory> {
  if (!(await tableExists(client, PGMIGRATIONS_TABLE))) {
    return EMPTY_MIGRATION_HISTORY;
  }
  const { rows } = await client.query<{ name: string }>(
    `SELECT name FROM ${PGMIGRATIONS_TABLE} ORDER BY id ASC`,
  );
  const names = rows.map((row) => row.name);
  return {
    tableExists: true,
    appliedMigrationCount: names.length,
    latestMigrationName: names[names.length - 1] ?? '',
    hasBaseline: names.includes(BASELINE_MIGRATION_NAME),
    names,
  };
}
