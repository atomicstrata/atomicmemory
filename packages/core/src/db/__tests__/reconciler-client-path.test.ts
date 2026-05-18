/**
 * Regression test for `isPool()` in `reconcilers.ts`.
 *
 * `migrate()` invokes `reconcileEmbeddingDimension` with a checked-out
 * `pg.PoolClient` (the connection that holds the Phase 1 advisory lock).
 * The original `isPool()` only checked for `.connect`, which both `pg.Pool`
 * and `pg.PoolClient` expose, so the reconciler misidentified the client
 * as a pool and called `executor.connect()` on it. `pg.Client.connect()`
 * throws `Client has already been connected. You cannot reuse a client.`
 * whenever the client is already connected — which it always is when it
 * came from `pool.connect()`.
 *
 * This test reproduces migrate()'s call site directly: check out a client
 * from a pool and pass it to `reconcileEmbeddingDimension`. On the old
 * code, the reconciler's `withClient` path threw on the embedded
 * `executor.connect()`. With the fix (`isPool` additionally rejects
 * anything with a `.release` method), the same call alters the column
 * cleanly and returns the expected `ReconcileResult`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../pool.js';
import { reconcileEmbeddingDimension } from '../reconcilers.js';
import {
  readVectorColumnDimension,
  registerReconcilerSchemaLifecycle,
  setReconcilerSearchPath,
} from './reconciler-test-helpers.js';

const TEST_SCHEMA = 'reconciler_client_path_test_schema';
const TABLE_NAME = 'reconciler_client_path_t';

describe('reconcileEmbeddingDimension via checked-out PoolClient', () => {
  registerReconcilerSchemaLifecycle({
    afterAll,
    beforeAll,
    beforeEach,
    pool,
    schema: TEST_SCHEMA,
  });

  it('alters a mismatched empty column when the executor is an already-connected PoolClient', async () => {
    await pool.query(
      `CREATE TABLE ${TABLE_NAME} (id serial PRIMARY KEY, embedding vector(4))`,
    );

    const client = await pool.connect();
    try {
      await setReconcilerSearchPath(client, TEST_SCHEMA);
      const result = await reconcileEmbeddingDimension(client, 8);
      expect(result.reconciled).toBe(true);
      expect(result.alteredColumns).toEqual([
        { tableName: TABLE_NAME, columnName: 'embedding' },
      ]);
    } finally {
      client.release();
    }

    expect(
      await readVectorColumnDimension(pool, TEST_SCHEMA, TABLE_NAME, 'embedding'),
    ).toBe(8);
  });
});
