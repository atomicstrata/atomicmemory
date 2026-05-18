/**
 * Phase 8.6 — failure-mode integration tests.
 *
 * Each test exercises ONE end-to-end failure path and asserts BOTH
 * the DB-state contract AND the Phase 8.5 observability event
 * stream. Splitting "state" and "events" across separate test files
 * (the existing reconciler / upload-pipeline suites do this) is
 * useful for unit scope, but the failure-mode coverage the plan
 * requires explicitly cross-cuts those concerns: a crash-resume,
 * stale-claim recovery, scheduler rejection, or verification
 * failure is only correct if BOTH the row reaches its terminal
 * state AND the observability event the runbook documents fires
 * with the right shape.
 *
 * Failure modes covered (in plan §Phase 8.6):
 *   1. Crash-resume `β→β2` (blob_uploading + storage_uri NULL):
 *      same-bytes retry runs reclaim+upload, no orphaned bytes.
 *   2. Crash-resume `β2→γ` (blob_uploading + storage_uri NOT NULL):
 *      same-bytes retry runs Phase γ alone; zero re-encode + zero
 *      re-put (the strict unconditional invariant — finalize must
 *      never re-upload because the URI is durable).
 *   3. Stale-claim recovery: a `blob_pending` row whose worker died
 *      mid-claim is reclaimed; the new claim emits
 *      `filecoin.reconcile.stale_claim_recovered` AND clears the
 *      old claim_id on the row.
 *   4. Scheduler rejection: `runOnce` rejecting with a planted
 *      credential surfaces as a `filecoin.reconcile.failure` event
 *      whose `errorMessage` is sanitized.
 *   5. Retrieval verification: `hash_verify` mismatch flips the
 *      row to `blob_archival_failed` AND emits both
 *      `filecoin.retrieval.verification_failed` and the matching
 *      `filecoin.reconcile.archival_failed` event end-to-end.
 *
 * The route-level large-payload boundary (413) lives in
 * `src/routes/__tests__/document-raw-large-payload.test.ts` so the
 * HTTP-layer body-parser limit can be exercised through a real
 * Express app without dragging the service-layer fixtures into a
 * cross-layer test file.
 */

import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { pool } from '../../db/pool.js';
import { getRawDocumentById } from '../../db/raw-document-repository.js';
import { uploadRawDocument } from '../document-upload.js';
import { runOnce } from '../raw-storage-reconciler.js';
import {
  startReconciler,
} from '../raw-storage-reconciler-scheduler.js';
import { logReconcilerError } from '../filecoin-observability.js';
import { NoopRawContentCodec } from '../../storage/codecs/noop-codec.js';
import type {
  RawContentGetResult,
  RawContentHeadResult,
  RawContentStore,
  StoredRawContent,
} from '../../storage/raw-content-store.js';
import {
  DEFAULT_DEPS,
  USER,
  headRetrievable,
  seedRow,
} from './raw-storage-reconciler-test-helpers.js';
import {
  captureFilecoinEvents,
  findFilecoinEvent,
  registerEmptyDocument,
  useDocumentTestLifecycle,
} from './filecoin-event-test-helpers.js';
import { TEST_STORAGE_KEY_HMAC_SECRET } from '../../__tests__/helpers/storage-key-test-secret.js';

useDocumentTestLifecycle();

const PAYLOAD = Buffer.from('phase 8.6 failure-mode payload bytes', 'utf8');
const CFG = { rawStoragePrefix: 'phase86', rawStorageMode: 'managed_blob' as const, storageKeyHmacSecret: TEST_STORAGE_KEY_HMAC_SECRET };

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

interface FakeFilecoinStore extends RawContentStore {
  putCalls: number;
  getReturnsBytes?: Buffer;
}

function makeFilecoinStore(opts: {
  putStatus?: 'stored' | 'pending';
  getBytes?: Buffer;
  headReturns?: () => Promise<RawContentHeadResult>;
}): FakeFilecoinStore {
  const store: FakeFilecoinStore = {
    provider: 'filecoin',
    capabilities: {
      addressing: 'content', retrievalConsistency: 'eventual',
      deleteSemantics: 'tombstone', supportsHead: true, supportsGet: true,
    },
    putCalls: 0,
    async put({ key, body }): Promise<StoredRawContent> {
      store.putCalls += 1;
      return {
        storageUri: `ipfs://bafy-${key}`,
        storageProvider: 'filecoin',
        contentHash: sha256Hex(body),
        sizeBytes: body.length,
        status: opts.putStatus ?? 'stored',
        providerMetadata: { filecoin: { ipfs_cid: `bafy-${key}` } },
      };
    },
    async get(): Promise<RawContentGetResult> {
      const bytes = opts.getBytes ?? Buffer.alloc(0);
      return {
        body: bytes,
        metadata: {
          contentLength: bytes.length, contentType: null,
          contentHash: sha256Hex(bytes), providerMetadata: {},
        },
      };
    },
    head: opts.headReturns ?? headRetrievable,
    async delete() { return { deleted: true, semantics: 'tombstoned' }; },
  };
  return store;
}

// `registerEmptyDocument(USER, externalId)` lives in
// `filecoin-event-test-helpers.ts` — re-used here instead of
// duplicating the upsert+register pattern.
const seedRegisteredDoc = (id: string): Promise<string> => registerEmptyDocument(USER, id);

describe('Phase 8.6 — crash-resume β→β2 (no URI durable)', () => {
  it('same-bytes retry takes the reclaim-and-upload branch + emits start/accept', async () => {
    const id = await seedRegisteredDoc('crash-beta-1');
    // Phase α succeeded then process died before Phase β2 wrote the
    // URI. Row carries the plaintext hash/size and a stale claim_id
    // but NO storage_uri.
    //
    // SCOPE: this test exercises ONLY the post-crash DB-state branch.
    // It does NOT simulate a provider-side put that completed before
    // the crash; the duplicate-byte / orphan-billing risk in the
    // narrow "β succeeded → β2 didn't" window depends on whether the
    // Storacha onramp is content-addressed-idempotent. That
    // operational concern is documented in Phase 3a's discovery notes
    // + the runbook (rev-13 §3, rev-8 §1) — NOT proven by this test.
    await pool.query(
      `UPDATE raw_documents SET raw_storage_status='blob_uploading',
         raw_storage_claim_id='abandoned', raw_storage_claimed_at=NOW(),
         content_hash=$1, size_bytes=$2 WHERE id=$3`,
      [sha256Hex(PAYLOAD), PAYLOAD.length, id],
    );
    const store = makeFilecoinStore({ putStatus: 'stored' });
    const { events, restore } = captureFilecoinEvents();
    try {
      const result = await uploadRawDocument(pool, store, new NoopRawContentCodec(), CFG, {
        userId: USER, documentId: id, body: PAYLOAD,
      });
      expect(result.rawStorageStatus).toBe('blob_available');
    } finally {
      restore();
    }
    // The retry classifies as `reclaimAndUpload` and runs β+β2+γ
    // ONCE. The single `put` call here is the retry's put — the
    // hypothetical prior put (if any) is out of scope.
    expect(store.putCalls).toBe(1);
    const row = await getRawDocumentById(pool, USER, id);
    expect(row?.rawStorageStatus).toBe('blob_available');
    // No duplicate `raw_documents` rows leaked from the retry path.
    const rowCount = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM raw_documents WHERE id = $1`, [id],
    );
    expect(rowCount.rows[0]!.n).toBe('1');
    expect(findFilecoinEvent(events, 'filecoin.upload.started')).toBeDefined();
    expect(findFilecoinEvent(events, 'filecoin.upload.accepted')).toBeDefined();
  });
});

describe('Phase 8.6 — crash-resume β2→γ (URI already durable)', () => {
  it('same-bytes retry runs Phase γ alone — ZERO re-encode, ZERO re-put', async () => {
    const id = await seedRegisteredDoc('crash-beta2-1');
    // Phase β2 succeeded then process died before Phase γ flipped
    // the status. Row carries the URI + persisted upload_result
    // sidecar; finalize-recovery MUST skip β + β2 entirely.
    await pool.query(
      `UPDATE raw_documents SET raw_storage_status='blob_uploading',
         raw_storage_claim_id='abandoned', raw_storage_claimed_at=NOW(),
         storage_mode='managed_blob', storage_uri='ipfs://bafy-resume',
         storage_provider='filecoin', content_hash=$1, size_bytes=$2,
         raw_storage_metadata=$3::jsonb WHERE id=$4`,
      [
        sha256Hex(PAYLOAD), PAYLOAD.length,
        JSON.stringify({
          codec: { name: 'none', version: 1 },
          filecoin: { ipfs_cid: 'bafy-resume' },
          upload_result: { stored_status: 'stored' },
        }),
        id,
      ],
    );
    const codec = new NoopRawContentCodec();
    const encodeSpy = vi.spyOn(codec, 'encode');
    const store = makeFilecoinStore({});
    const { events, restore } = captureFilecoinEvents();
    try {
      const result = await uploadRawDocument(pool, store, codec, CFG, {
        userId: USER, documentId: id, body: PAYLOAD,
      });
      expect(result.rawStorageStatus).toBe('blob_available');
      expect(result.storageUri).toBe('ipfs://bafy-resume');
    } finally {
      restore();
    }
    // Strict invariant — URI durability means we MUST NOT re-upload.
    expect(encodeSpy).not.toHaveBeenCalled();
    expect(store.putCalls).toBe(0);
    expect(findFilecoinEvent(events, 'filecoin.upload.accepted')).toBeDefined();
  });
});

describe('Phase 8.6 — stale-claim recovery (claim_id non-NULL, claimed_at stale)', () => {
  it('reclaims row, emits stale_claim_recovered, clears prior claim_id', async () => {
    const id = await seedRow({
      externalId: 'stale-claim-recovery',
      claimId: 'dead-worker',
      claimedAtSecondsAgo: 7200,
      reconcileAttempts: 1,
    });
    const { events, restore } = captureFilecoinEvents();
    try {
      const summary = await runOnce({
        ...DEFAULT_DEPS,
        store: makeFilecoinStore({ headReturns: headRetrievable }),
      });
      expect(summary.claimed).toBe(1);
      expect(summary.promoted).toBe(1);
    } finally {
      restore();
    }
    const row = await getRawDocumentById(pool, USER, id);
    expect(row?.rawStorageStatus).toBe('blob_available');
    expect(row?.rawStorageClaimId).toBeNull();
    const recovered = findFilecoinEvent(events, 'filecoin.reconcile.stale_claim_recovered');
    expect(recovered).toBeDefined();
    expect(recovered!.detail.documentId).toBe(id);
    expect(typeof recovered!.detail.claimId).toBe('string');
    expect(recovered!.detail.claimId).not.toBe('dead-worker');
  });
});

describe('Phase 8.6 — scheduler rejection routes through logReconcilerError', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('emits filecoin.reconcile.failure with sanitized errorMessage', async () => {
    // Stub a pool whose `connect()` rejects with a credential-shaped
    // string so the central sanitizer's allowlist redaction is
    // exercised through the live scheduler → onError → logReconcilerError
    // wire chain. Uses fake timers so the test never sleeps.
    const planted = 'did:key:z6MkpZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ';
    const err = Object.assign(new Error(`auth failure for ${planted}`), { code: 'auth_failure' });
    const fakePool = {
      query: vi.fn(),
      connect: vi.fn(async () => { throw err; }),
    } as unknown as pg.Pool;
    const { events, restore } = captureFilecoinEvents();
    const scheduler = startReconciler({
      ...DEFAULT_DEPS, pool: fakePool,
      store: makeFilecoinStore({}),
      intervalMs: 100,
      onError: logReconcilerError,
    });
    try {
      // Advance through one tick interval. The rejected runOnce
      // resolves microtasks via `.catch(onError).finally(...)`;
      // `advanceTimersByTimeAsync` flushes microtasks between
      // virtual-ticks so the onError emission lands before assert.
      await vi.advanceTimersByTimeAsync(150);
    } finally {
      // Stopping clears the interval and awaits the in-flight tick.
      await scheduler.stop();
      restore();
    }
    const failure = findFilecoinEvent(events, 'filecoin.reconcile.failure');
    expect(failure).toBeDefined();
    expect(failure!.detail.errorCode).toBe('auth_failure');
    expect(failure!.detail.errorMessage as string).not.toContain(planted);
    expect(failure!.detail.errorMessage as string).toContain('[REDACTED');
  });
});

describe('Phase 8.6 — hash_verify mismatch end-to-end', () => {
  it('flips row to blob_archival_failed AND emits verification_failed + archival_failed', async () => {
    const id = await seedRow({
      externalId: 'verify-mismatch-e2e',
      contentHash: sha256Hex(PAYLOAD),
      rawStorageMetadata: { codec: { name: 'none', version: 1 } },
    });
    // Adapter returns bytes whose decoded hash WILL NOT match the
    // row's plaintext `content_hash` — permanent failure.
    const store = makeFilecoinStore({
      getBytes: Buffer.from('evil substitute bytes'),
      headReturns: headRetrievable,
    });
    const { events, restore } = captureFilecoinEvents();
    try {
      const summary = await runOnce({
        ...DEFAULT_DEPS, store, verifyMode: 'hash_verify' as const,
      });
      expect(summary.archivalFailed).toBe(1);
    } finally {
      restore();
    }
    const row = await getRawDocumentById(pool, USER, id);
    expect(row?.rawStorageStatus).toBe('blob_archival_failed');
    expect(row?.lastError).toMatchObject({
      layer: 'raw_storage', code: 'content_hash_mismatch',
    });
    expect(findFilecoinEvent(events, 'filecoin.retrieval.verification_failed'))
      .toBeDefined();
    expect(findFilecoinEvent(events, 'filecoin.reconcile.archival_failed'))
      .toBeDefined();
  });
});
