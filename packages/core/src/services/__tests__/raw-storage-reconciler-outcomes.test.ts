/**
 * Reconciler outcome tests — what each probe result writes
 * to the row. Splits out of the eligibility suite to keep both files
 * under the workspace 400-non-comment-line cap.
 *
 * Coverage:
 *   - Success: deep-merge filecoin metadata + layer-scoped last_error.
 *   - Pending probe: claim clear, attempts +1, next_check_at backoff.
 *   - Permanent failure: adapter-signaled +
 *     malformed URI both immediately mark `blob_archival_failed`;
 *     transient errors stay pending.
 *   - Retry exhaustion + late-success-at-high-attempt-count.
 *   - Guarded UPDATE mismatch (lost claim).
 *   - computeBackoffMs.
 *   - batchSize bound + head() argument spy.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { pool } from '../../db/pool.js';
import { clearDocumentTables, setupTestSchema } from '../../db/__tests__/test-fixtures.js';
import { getRawDocumentById } from '../../db/raw-document-repository.js';
import { computeBackoffMs, runOnce } from '../raw-storage-reconciler.js';
import {
  DEFAULT_DEPS,
  USER,
  deps,
  headPending,
  headRetrievable,
  makeStore,
  seedRow,
} from './raw-storage-reconciler-test-helpers.js';
import type { RawContentHeadResult } from '../../storage/raw-content-store.js';

beforeAll(async () => {
  await setupTestSchema(pool);
});

afterAll(async () => {
  await clearDocumentTables(pool);
  await pool.end();
});

beforeEach(async () => {
  await clearDocumentTables(pool);
});

describe('reconciler runOnce — success path: deep-merge + last_error', () => {
  it('deep-merges new filecoin keys without dropping existing siblings', async () => {
    const id = await seedRow({
      externalId: 'merge-1',
      rawStorageMetadata: {
        codec: { name: 'none', version: 1 },
        filecoin: {
          ipfs_cid: 'bafy-existing',
          piece_cid: 'baga-existing',
          deals: [{ deal_id: 'd1', provider: 'f1' }],
          gateway_url: 'https://w3s.link/ipfs/bafy-existing',
        },
        upload_result: { stored_status: 'pending' },
      },
    });
    const headWithConfirmed = async (): Promise<RawContentHeadResult> => ({
      exists: true,
      metadata: {
        contentLength: 0, contentType: null, contentHash: null,
        providerMetadata: {
          filecoin: { retrieval_verified_at: '2026-05-11T00:00:00.000Z', onramp_status: 'retrievable' },
        },
      },
    });
    await runOnce(deps(headWithConfirmed));
    const row = await getRawDocumentById(pool, USER, id);
    expect(row?.rawStorageStatus).toBe('blob_available');
    expect(row?.rawStorageMetadata).toEqual({
      codec: { name: 'none', version: 1 },
      filecoin: {
        ipfs_cid: 'bafy-existing',
        piece_cid: 'baga-existing',
        deals: [{ deal_id: 'd1', provider: 'f1' }],
        gateway_url: 'https://w3s.link/ipfs/bafy-existing',
        retrieval_verified_at: '2026-05-11T00:00:00.000Z',
        onramp_status: 'retrievable',
      },
      upload_result: { stored_status: 'pending' },
    });
  });

  it('clears raw_storage last_error but preserves semantic_index last_error', async () => {
    const id = await seedRow({
      externalId: 'last-error-layered',
      lastError: { layer: 'semantic_index', code: 'index_text_too_large', message: 'big', occurred_at: '2026-05-09T00:00:00.000Z' },
    });
    await runOnce(deps(headRetrievable));
    const row = await getRawDocumentById(pool, USER, id);
    expect(row?.rawStorageStatus).toBe('blob_available');
    expect(row?.lastError).toEqual({
      layer: 'semantic_index', code: 'index_text_too_large', message: 'big', occurred_at: '2026-05-09T00:00:00.000Z',
    });
  });

  it('clears raw_storage last_error when scoped to raw_storage', async () => {
    const id = await seedRow({
      externalId: 'last-error-raw',
      lastError: { layer: 'raw_storage', code: 'reconcile_probe_error', message: 'transient', occurred_at: '2026-05-09T00:00:00.000Z' },
    });
    await runOnce(deps(headRetrievable));
    const row = await getRawDocumentById(pool, USER, id);
    expect(row?.lastError).toBeNull();
  });
});

describe('reconciler runOnce — pending probe outcomes', () => {
  it('clears claim, increments attempts, sets next_check_at via backoff, preserves status + pending_since', async () => {
    const id = await seedRow({
      externalId: 'still-pending-1',
      reconcileAttempts: 2,
      pendingSinceSecondsAgo: 600,
    });
    const summary = await runOnce(deps(headPending));
    expect(summary.stillPending).toBe(1);
    const row = await getRawDocumentById(pool, USER, id);
    expect(row?.rawStorageStatus).toBe('blob_pending');
    expect(row?.rawStorageClaimId).toBeNull();
    expect(row?.rawStorageReconcileAttempts).toBe(3);
    expect(row?.rawStoragePendingSince).not.toBeNull();
    expect(row?.rawStorageNextCheckAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it('transient head() error also lands in still-pending (not archival_failed)', async () => {
    const headError = async (): Promise<RawContentHeadResult> => {
      throw new Error('gateway timeout');
    };
    const id = await seedRow({
      externalId: 'transient-error',
      reconcileAttempts: 0,
    });
    const summary = await runOnce(deps(headError));
    expect(summary.stillPending).toBe(1);
    const row = await getRawDocumentById(pool, USER, id);
    expect(row?.rawStorageStatus).toBe('blob_pending');
    expect(row?.rawStorageReconcileAttempts).toBe(1);
  });
});

describe('reconciler runOnce — permanent failure', () => {
  it('adapter-signaled per-row permanent failure → blob_archival_failed (no retry)', async () => {
    const id = await seedRow({ externalId: 'perm-fail-1', reconcileAttempts: 0 });
    const headPermanent = async (): Promise<RawContentHeadResult> => ({
      exists: false, metadata: null,
      failure: { code: 'onramp_reported_failed', message: 'cid will never become retrievable' },
    });
    const summary = await runOnce(deps(headPermanent));
    expect(summary.archivalFailed).toBe(1);
    expect(summary.stillPending).toBe(0);
    const row = await getRawDocumentById(pool, USER, id);
    expect(row?.rawStorageStatus).toBe('blob_archival_failed');
    expect(row?.lastError).toMatchObject({
      layer: 'raw_storage', code: 'onramp_reported_failed',
    });
    // Per-row permanent failure does NOT burn retries — even at
    // attempts=0 we go straight to terminal.
    expect(row?.rawStorageReconcileAttempts).toBe(0);
    expect(row?.rawStorageClaimId).toBeNull();
    expect(row?.rawStoragePendingSince).toBeNull();
  });

  it("FilecoinRawContentStore-shaped 'failed' status + malformed URI both surface as permanent", async () => {
    // Tests through the typed contract — adapter wraps the
    // Filecoin onramp's 'failed' as `failure: { code, message }`
    // and the reconciler routes it to archival_failed.
    const idA = await seedRow({ externalId: 'perm-fail-a' });
    const idB = await seedRow({ externalId: 'perm-fail-b' });
    const headPerCid = async (uri: string): Promise<RawContentHeadResult> => {
      if (uri.endsWith('-a')) {
        return { exists: false, metadata: null, failure: { code: 'onramp_reported_failed', message: 'failed' } };
      }
      return { exists: false, metadata: null, failure: { code: 'malformed_storage_uri', message: `bad uri ${uri}` } };
    };
    const summary = await runOnce(deps(headPerCid));
    expect(summary.archivalFailed).toBe(2);
    const rowA = await getRawDocumentById(pool, USER, idA);
    const rowB = await getRawDocumentById(pool, USER, idB);
    expect(rowA?.rawStorageStatus).toBe('blob_archival_failed');
    expect(rowB?.rawStorageStatus).toBe('blob_archival_failed');
    expect(rowA?.lastError).toMatchObject({ code: 'onramp_reported_failed' });
    expect(rowB?.lastError).toMatchObject({ code: 'malformed_storage_uri' });
  });

  it('global infra throw stays transient — never archives every row at once', async () => {
    // Three rows, head() throws a generic auth error for ALL of them.
    // The plan explicitly forbids permanently failing every row on a
    // global misconfiguration — these stay pending and the operator
    // gets a chance to fix the auth.
    for (let i = 0; i < 3; i += 1) {
      await seedRow({ externalId: `global-throw-${i}` });
    }
    const headThrows = async (): Promise<RawContentHeadResult> => {
      throw new Error('auth_failure: UCAN proof expired');
    };
    const summary = await runOnce(deps(headThrows));
    expect(summary.stillPending).toBe(3);
    expect(summary.archivalFailed).toBe(0);
  });
});

describe('reconciler runOnce — retry exhaustion + late-success', () => {
  it('attempts >= max AND probe pending → blob_archival_failed with raw_storage last_error', async () => {
    const id = await seedRow({
      externalId: 'exhausted-1',
      reconcileAttempts: 4,
      pendingSinceSecondsAgo: 86400,
    });
    const customDeps = { ...DEFAULT_DEPS, maxAttempts: 5, store: makeStore({ head: headPending }) };
    const summary = await runOnce(customDeps);
    expect(summary.archivalFailed).toBe(1);
    const row = await getRawDocumentById(pool, USER, id);
    expect(row?.rawStorageStatus).toBe('blob_archival_failed');
    expect(row?.lastError).toMatchObject({
      layer: 'raw_storage', code: 'reconcile_attempts_exhausted',
    });
    expect(row?.rawStoragePendingSince).toBeNull();
    expect(row?.rawStorageClaimId).toBeNull();
    expect(row?.rawStorageReconcileAttempts).toBe(0);
  });

  it('late success at high attempt count STILL promotes (rev-7 §7)', async () => {
    const id = await seedRow({
      externalId: 'late-success',
      reconcileAttempts: 99,
    });
    const customDeps = { ...DEFAULT_DEPS, maxAttempts: 5, store: makeStore({ head: headRetrievable }) };
    const summary = await runOnce(customDeps);
    expect(summary.promoted).toBe(1);
    expect(summary.archivalFailed).toBe(0);
    const row = await getRawDocumentById(pool, USER, id);
    expect(row?.rawStorageStatus).toBe('blob_available');
    expect(row?.rawStorageReconcileAttempts).toBe(0);
  });
});

describe('reconciler runOnce — guarded UPDATE mismatch', () => {
  it('lost claim during the network call yields zero promoted rows', async () => {
    const id = await seedRow({ externalId: 'lost-claim-1' });
    let raced = false;
    const racingHead = async (): Promise<RawContentHeadResult> => {
      if (!raced) {
        raced = true;
        await pool.query(
          `UPDATE raw_documents SET raw_storage_claim_id = 'stolen' WHERE id = $1`,
          [id],
        );
      }
      return {
        exists: true,
        metadata: { contentLength: 0, contentType: null, contentHash: null, providerMetadata: {} },
      };
    };
    const summary = await runOnce(deps(racingHead));
    expect(summary.claimed).toBe(1);
    expect(summary.promoted).toBe(0);
    expect(summary.lostClaim).toBe(1);
    const row = await getRawDocumentById(pool, USER, id);
    expect(row?.rawStorageStatus).toBe('blob_pending');
    expect(row?.rawStorageClaimId).toBe('stolen');
  });
});

describe('computeBackoffMs', () => {
  it('returns baseMs for attempts <= 0 (defense-in-depth)', () => {
    expect(computeBackoffMs(0, 30_000, 3_600_000)).toBe(30_000);
    expect(computeBackoffMs(-1, 30_000, 3_600_000)).toBe(30_000);
  });

  it('returns 2^attempts * baseMs for moderate attempt counts', () => {
    expect(computeBackoffMs(1, 30_000, 3_600_000)).toBe(60_000);
    expect(computeBackoffMs(2, 30_000, 3_600_000)).toBe(120_000);
    expect(computeBackoffMs(3, 30_000, 3_600_000)).toBe(240_000);
  });

  it('caps at maxMs as the exponential explodes', () => {
    expect(computeBackoffMs(20, 30_000, 3_600_000)).toBe(3_600_000);
    expect(computeBackoffMs(100, 30_000, 3_600_000)).toBe(3_600_000);
  });
});

describe('runOnce — batch + spy seams', () => {
  it("batchSize=2 + 5 eligible rows claims at most 2", async () => {
    for (let i = 0; i < 5; i += 1) {
      await seedRow({ externalId: `batch-${i}` });
    }
    const limitedDeps = { ...DEFAULT_DEPS, batchSize: 2, store: makeStore({ head: headRetrievable }) };
    const summary = await runOnce(limitedDeps);
    expect(summary.claimed).toBe(2);
    expect(summary.promoted).toBe(2);
  });

  it("passes each row's storage_uri + raw_storage_metadata hints to store.head()", async () => {
    await seedRow({
      externalId: 'spy-1',
      storageUri: 'ipfs://bafy-spy-test',
      rawStorageMetadata: { filecoin: { data_set_id: '7' } },
    });
    const headSpy = vi.fn(headRetrievable);
    await runOnce({ ...DEFAULT_DEPS, store: makeStore({ head: headSpy }) });
    expect(headSpy).toHaveBeenCalledWith(
      'ipfs://bafy-spy-test',
      { filecoin: { data_set_id: '7' } },
    );
  });
});
