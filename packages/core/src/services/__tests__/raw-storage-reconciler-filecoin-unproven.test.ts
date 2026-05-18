/**
 * @file Reconciler-level proof that an unproven Filecoin head does
 * NOT promote `blob_pending → blob_available`.
 *
 * The `FilecoinRawContentStore` translates the underlying
 * `FilecoinProviderClient.head` result `{exists:true, proven:false}`
 * into the generic `RawContentHeadResult{exists:false, metadata:null,
 * failure:undefined}` so the reconciler's `probeHead` returns
 * `kind: 'pending'`. This test wires the full pipe end-to-end
 * (real `FilecoinRawContentStore` + a fake
 * `FilecoinProviderClient`) and asserts that the row stays
 * `blob_pending` after a reconciler tick.
 *
 * Required: DATABASE_URL in .env.test with pgvector available.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../../db/pool.js';
import { runOnce } from '../raw-storage-reconciler.js';
import { FilecoinRawContentStore } from '../../storage/providers/filecoin/index.js';
import type {
  FilecoinHeadInput,
  FilecoinHeadResult,
} from '../../storage/providers/filecoin/provider-client.js';
import { clearDocumentTables, setupTestSchema } from '../../db/__tests__/test-fixtures.js';
import { getRawDocumentById } from '../../db/raw-document-repository.js';
import {
  DEFAULT_DEPS,
  ReconcilerFilecoinTestClientBase,
  USER,
  seedRow,
} from './raw-storage-reconciler-test-helpers.js';

class UnprovenFilecoinClient extends ReconcilerFilecoinTestClientBase {
  // Returns the "SDK saw the piece but PDP proof has not landed"
  // signal — the exact case the lifecycle-bug fix targets.
  override async head(_i: FilecoinHeadInput): Promise<FilecoinHeadResult> {
    return {
      exists: true,
      proven: false,
      providerMetadata: { piece_cid: 'baga-unproven' },
    };
  }
}

beforeAll(async () => {
  await setupTestSchema(pool);
});

beforeEach(async () => {
  await clearDocumentTables(pool);
});

afterAll(async () => {
  // Match the existing reconciler suite's teardown: wipe rows
  // before closing the pool so other test files don't see stale
  // managed-blob rows whose provider isn't registered in their
  // own deployment harness.
  await clearDocumentTables(pool);
  await pool.end();
});

describe('reconciler — Filecoin unproven head does NOT promote', () => {
  it('leaves the row at blob_pending; increments reconcile_attempts; sets next_check_at', async () => {
    const store = new FilecoinRawContentStore(new UnprovenFilecoinClient());
    const id = await seedRow({
      externalId: 'filecoin-unproven-1',
      storageProvider: 'filecoin',
      storageUri: 'filecoin://piece/baga-unproven',
      reconcileAttempts: 0,
      pendingSinceSecondsAgo: 60,
    });
    const summary = await runOnce({ ...DEFAULT_DEPS, store });
    expect(summary.stillPending).toBe(1);
    expect(summary.promoted).toBe(0);
    expect(summary.archivalFailed).toBe(0);

    const row = await getRawDocumentById(pool, USER, id);
    expect(row?.rawStorageStatus).toBe('blob_pending');
    expect(row?.rawStorageClaimId).toBeNull();
    expect(row?.rawStorageReconcileAttempts).toBe(1);
    // Backoff written so the row gets re-probed later, not on the
    // same tick.
    expect(row?.rawStorageNextCheckAt!.getTime()).toBeGreaterThan(Date.now());
  });
});
