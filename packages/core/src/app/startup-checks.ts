/**
 * Startup guard functions run before the HTTP server accepts traffic.
 *
 * Extracted from `server.ts` so tests can exercise individual checks and
 * future startup guards can be added without growing the server bootstrap
 * module. Phase 1A of the rearchitecture.
 */

import pg from 'pg';
import type { CoreRuntimeConfig } from './runtime-container.js';

/**
 * Result of an embedding dimension check against the `memories.embedding`
 * column. `ok=false` means the process should exit before serving traffic.
 */
export interface EmbeddingDimensionCheckResult {
  ok: boolean;
  dbDims: number | null;
  configDims: number;
  message: string;
}

/**
 * Verify DB embedding column dimensions match the configured embedding size.
 * Catches the "expected N dimensions, not M" class of errors at startup,
 * which would otherwise surface as opaque insert failures during ingest.
 *
 * This function never throws or exits — it returns a structured result so
 * the caller decides how to react (log + exit at boot, throw in tests).
 */
export async function checkEmbeddingDimensions(
  pool: pg.Pool,
  config: CoreRuntimeConfig,
): Promise<EmbeddingDimensionCheckResult> {
  const { rows } = await pool.query<{ typmod: number }>(
    `SELECT atttypmod AS typmod
     FROM pg_attribute a
     JOIN pg_class c ON a.attrelid = c.oid
     WHERE c.relname = 'memories' AND a.attname = 'embedding'`,
  );

  if (rows.length === 0) {
    return {
      ok: false,
      dbDims: null,
      configDims: config.embeddingDimensions,
      message: 'memories.embedding column not found — run npm run migrate first',
    };
  }

  const dbDims = rows[0].typmod > 0 ? rows[0].typmod : null;

  if (dbDims !== null && dbDims !== config.embeddingDimensions) {
    return {
      ok: false,
      dbDims,
      configDims: config.embeddingDimensions,
      message:
        `DB vector column is ${dbDims} dimensions but EMBEDDING_DIMENSIONS=${config.embeddingDimensions}. ` +
        `Fix: set EMBEDDING_DIMENSIONS=${dbDims} or run 'npm run migrate' to recreate the schema.`,
    };
  }

  return {
    ok: true,
    dbDims,
    configDims: config.embeddingDimensions,
    message: `Embedding dimensions OK: config=${config.embeddingDimensions}, DB=${dbDims ?? 'unset'}`,
  };
}
