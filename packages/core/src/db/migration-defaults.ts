/**
 * Lazy runtime-config defaults for Phase 1 migration entry points.
 *
 * The DB migration modules are intentionally not static consumers of the
 * module-level `config` singleton. That keeps them compatible with the
 * config-threading ratchet while still letting `migrate()` and
 * `migrationStatus()` default to startup-validated config when callers do
 * not pass explicit options.
 */

import type { RuntimeConfig } from '../config.js';

export interface MigrationRuntimeDefaults {
  databaseUrl: string;
  embeddingDimensions: number;
  skipVectorIndexes: boolean;
}

export interface MigrationRuntimeOptions {
  pool?: unknown;
  databaseUrl?: string;
  embeddingDimensions?: number;
  skipVectorIndexes?: boolean;
}

export type ResolvedMigrationRuntimeOptions<T extends MigrationRuntimeOptions> = T & {
  embeddingDimensions: number;
  skipVectorIndexes: boolean;
};

async function loadMigrationRuntimeDefaults(): Promise<MigrationRuntimeDefaults> {
  const { config } = await import('../config.js');
  return pickMigrationRuntimeDefaults(config);
}

export async function resolveMigrationRuntimeOptions<T extends MigrationRuntimeOptions>(
  opts: T,
): Promise<ResolvedMigrationRuntimeOptions<T>> {
  const defaults = needsRuntimeDefaults(opts)
    ? await loadMigrationRuntimeDefaults()
    : null;
  return {
    ...opts,
    databaseUrl: opts.databaseUrl ?? defaults?.databaseUrl,
    embeddingDimensions: opts.embeddingDimensions
      ?? requireDefaults(defaults).embeddingDimensions,
    skipVectorIndexes: opts.skipVectorIndexes
      ?? requireDefaults(defaults).skipVectorIndexes,
  };
}

function pickMigrationRuntimeDefaults(config: RuntimeConfig): MigrationRuntimeDefaults {
  return {
    databaseUrl: config.databaseUrl,
    embeddingDimensions: config.embeddingDimensions,
    skipVectorIndexes: config.skipVectorIndexes,
  };
}

function needsRuntimeDefaults(opts: MigrationRuntimeOptions): boolean {
  return (!opts.pool && !opts.databaseUrl)
    || opts.embeddingDimensions === undefined
    || opts.skipVectorIndexes === undefined;
}

function requireDefaults(
  defaults: MigrationRuntimeDefaults | null,
): MigrationRuntimeDefaults {
  if (!defaults) {
    throw new Error('migration runtime defaults were not loaded');
  }
  return defaults;
}
