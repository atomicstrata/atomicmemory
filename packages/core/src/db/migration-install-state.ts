/**
 * Install-state detection for the Phase 2 migration runner.
 *
 * Keeps the main migration API focused on sequencing while this module owns
 * the catalog probes that decide whether baseline should run, be fake-stamped,
 * or be rejected as corrupt framework history.
 */

import type { PoolClient } from 'pg';

import {
  BASELINE_MIGRATION_NAME,
  MigrationHistoryMismatch,
  readMigrationHistory,
} from './migration-history.js';
import { tableExists } from './migration-version.js';

const PRE_PHASE_2_SENTINEL_TABLES = ['memories', 'episodes', 'memory_claims'] as const;

export type InstallState = 'fresh' | 'pre_phase_2' | 'phase_2_current';

export interface InstallStateInfo {
  readonly state: InstallState;
}

/**
 * Distinguish Phase 2 install states without enumerating the whole catalog.
 *
 * An empty `pgmigrations` table is recoverable. A non-empty history that lacks
 * `0001_baseline` is not safely inferable, so the runner fails closed before
 * running baseline DDL or stamping semantic package state.
 */
export async function detectInstallState(client: PoolClient): Promise<InstallStateInfo> {
  const history = await readMigrationHistory(client);
  if (!history.tableExists) {
    return stateFromSentinels(await hasPrePhase2Sentinel(client));
  }
  if (history.hasBaseline) return { state: 'phase_2_current' };
  if (history.appliedMigrationCount === 0) {
    return stateFromSentinels(await hasPrePhase2Sentinel(client));
  }
  throw new MigrationHistoryMismatch(
    `pgmigrations exists with ${history.appliedMigrationCount} row(s) but is ` +
      `missing ${BASELINE_MIGRATION_NAME}. Refusing to infer a safe cutover path.`,
  );
}

async function hasPrePhase2Sentinel(client: PoolClient): Promise<boolean> {
  for (const sentinel of PRE_PHASE_2_SENTINEL_TABLES) {
    if (await tableExists(client, sentinel)) return true;
  }
  return false;
}

function stateFromSentinels(hasSentinel: boolean): InstallStateInfo {
  return { state: hasSentinel ? 'pre_phase_2' : 'fresh' };
}
