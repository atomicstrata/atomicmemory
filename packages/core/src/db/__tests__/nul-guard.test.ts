/**
 * @file Unit tests for the pg query-layer NUL backstop (`db/nul-guard.ts`). A
 * fake pool/client captures calls so no real database is required. NUL is built
 * via fromCharCode so this source file carries no raw NUL byte.
 */

import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { installNulGuard, NulByteParameterError } from '../nul-guard.js';

const NUL = String.fromCharCode(0);

function fakePool(): {
  pool: pg.Pool;
  poolQuery: ReturnType<typeof vi.fn>;
  clientQuery: ReturnType<typeof vi.fn>;
} {
  const poolQuery = vi.fn(async () => ({ rows: [] }));
  const clientQuery = vi.fn(async () => ({ rows: [] }));
  const client = { query: clientQuery, release: vi.fn() };
  const pool = { query: poolQuery, connect: vi.fn(async () => client) } as unknown as pg.Pool;
  return { pool, poolQuery, clientQuery };
}

describe('installNulGuard — pool.query', () => {
  it('guards query-only pool doubles without connect()', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const pool = { query } as unknown as pg.Pool;
    installNulGuard(pool);
    await expect(pool.query('SELECT 1 WHERE user_id=$1', [`u${NUL}`])).rejects.toBeInstanceOf(
      NulByteParameterError,
    );
    await pool.query('SELECT 1 WHERE user_id=$1', ['clean']);
    expect(query).toHaveBeenCalledOnce();
  });

  it('rejects a NUL in a positional text parameter', async () => {
    const { pool } = fakePool();
    installNulGuard(pool);
    await expect(pool.query('SELECT 1 WHERE user_id=$1', [`u${NUL}`])).rejects.toBeInstanceOf(
      NulByteParameterError,
    );
  });

  it('rejects a NUL in an object (jsonb) parameter value OR key', async () => {
    const { pool } = fakePool();
    installNulGuard(pool);
    await expect(pool.query('INSERT', [{ k: `v${NUL}` }])).rejects.toBeInstanceOf(NulByteParameterError);
    await expect(pool.query('INSERT', [{ [`k${NUL}`]: 'v' }])).rejects.toBeInstanceOf(
      NulByteParameterError,
    );
  });

  it('passes clean parameters through and skips a Buffer (bytea) with a 0x00 byte', async () => {
    const { pool, poolQuery } = fakePool();
    installNulGuard(pool);
    await pool.query('SELECT 1 WHERE user_id=$1', ['clean']);
    await pool.query('INSERT', [Buffer.from([0x01, 0x00, 0x02])]);
    expect(poolQuery).toHaveBeenCalledTimes(2);
  });
});

describe('installNulGuard — connect() client (transactions) + idempotency', () => {
  it('rejects a NUL in a parameter bound on a pooled client', async () => {
    const { pool } = fakePool();
    installNulGuard(pool);
    const client = await pool.connect();
    await expect(client.query('UPDATE memories SET user_id=$1', [`x${NUL}`])).rejects.toBeInstanceOf(
      NulByteParameterError,
    );
  });

  it('is idempotent — a second install does not double-wrap or change behavior', async () => {
    const { pool, poolQuery } = fakePool();
    installNulGuard(pool);
    installNulGuard(pool);
    await pool.query('SELECT 1', ['ok']);
    expect(poolQuery).toHaveBeenCalledOnce();
  });
});
