/**
 * CLI wrapper for the programmatic migration API.
 *
 * Library consumers should import `migrate` / `migrationStatus` from
 * `@atomicmemory/core` (re-exported via `src/index.ts`) instead of shelling
 * out. This file is intentionally a thin shim so that `process.exit` lives
 * only at the CLI boundary; `migration-api.ts` never terminates the host
 * process.
 *
 * Usage:
 *   npm run migrate        # loads .env via dotenv-cli
 *   npm run migrate:test   # loads .env.test via dotenv-cli
 *   tsx src/db/migrate.ts --lock-timeout-ms=120000
 */

import { migrate, type MigrateOptions } from './migration-api.js';

main().catch((err: unknown) => {
  console.error('[migrate] Migration failed:', err);
  process.exit(1);
});

async function main(): Promise<void> {
  const result = await migrate(parseCliOptions(process.argv.slice(2)));
  console.log(
    `[migrate] Migration complete ` +
      `(ranSchemaSql=${result.ranSchemaSql}, ` +
      `version=${result.schemaVersion.sdkVersion}, ` +
      `sha=${result.schemaVersion.schemaSha256.slice(0, 12)}…, ` +
      `reconciledEmbeddingDimension=${result.reconciledEmbeddingDimension}).`,
  );
  process.exit(0);
}

function parseCliOptions(args: string[]): MigrateOptions {
  const opts: MigrateOptions = {};
  for (const arg of args) {
    if (arg.startsWith('--lock-timeout-ms=')) {
      opts.lockTimeoutMs = parsePositiveInteger(arg, '--lock-timeout-ms=');
    } else {
      throw new Error(`[migrate] Unknown argument: ${arg}`);
    }
  }
  return opts;
}

function parsePositiveInteger(arg: string, prefix: string): number {
  const raw = arg.slice(prefix.length);
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0 || String(value) !== raw) {
    throw new Error(`[migrate] ${prefix.slice(0, -1)} must be a positive integer`);
  }
  return value;
}
