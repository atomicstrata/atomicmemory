/**
 * Database connection pool for Postgres+pgvector.
 * Reads DATABASE_URL from environment (loaded by dotenv-cli).
 */

import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required');
}

// max=1 prevents pgvector HNSW index deadlocks: the index takes
// AccessExclusiveLock during INSERT and AccessShareLock during SELECT.
// With multiple connections these can deadlock across backend processes.
export const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  max: 1,
  connectionTimeoutMillis: 30_000,
  idleTimeoutMillis: 60_000,
});

pool.on('error', (err) => {
  console.error('[pool] Unexpected idle client error:', err.message);
});
