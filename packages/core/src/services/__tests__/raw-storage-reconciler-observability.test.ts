/**
 * Phase 8.5 — integration coverage for the reconciler's structured
 * observability events. Verifies the load-bearing contracts:
 *
 *   - `filecoin.reconcile.claimed` fires once per non-empty batch with
 *     a `batchSize` reflecting actual claimed rows.
 *   - `filecoin.reconcile.promoted` carries `pendingAgeSeconds`
 *     derived from `raw_storage_pending_since`, plus the row's
 *     `reconcileAttempts` and a status_before/after pair.
 *   - `filecoin.reconcile.archival_failed` mirrors the promoted shape
 *     for the permanent-failure path AND for retry exhaustion.
 *   - `filecoin.reconcile.stale_claim_recovered` fires only when the
 *     batch reclaimed a row whose prior `raw_storage_claim_id` was
 *     non-NULL (rev-7 §3 + Phase 8.5 plan).
 *
 * Sanitization is locked at the unit-test level
 * (`filecoin-observability.test.ts`); this file is the end-to-end
 * proof that the wiring actually emits the right names with the
 * right payload shapes when run against a real Postgres + seeded
 * rows.
 */

import { describe, expect, it } from 'vitest';
import { pool } from '../../db/pool.js';
import { runOnce } from '../raw-storage-reconciler.js';
import {
  DEFAULT_DEPS,
  deps,
  headPending,
  headRetrievable,
  makeStore,
  seedRow,
} from './raw-storage-reconciler-test-helpers.js';
import {
  captureFilecoinEvents,
  findFilecoinEvent,
  useDocumentTestLifecycle,
} from './filecoin-event-test-helpers.js';

/**
 * Read the row's `raw_storage_pending_since` so an integration test
 * can compute the exact `pendingAgeSeconds` the reconciler will
 * emit, given an injected clock. The reconciler's `deps.now` is the
 * single seam — pass `pendingSince + N seconds` and the event
 * payload's `pendingAgeSeconds` is exactly `N` (review-fix MEDIUM 4
 * — no wall-clock tolerances).
 */
async function readPendingSince(rowId: string): Promise<Date> {
  const res = await pool.query<{ raw_storage_pending_since: Date }>(
    'SELECT raw_storage_pending_since FROM raw_documents WHERE id = $1',
    [rowId],
  );
  return res.rows[0]!.raw_storage_pending_since;
}

function offsetClock(base: Date, seconds: number): () => Date {
  const target = new Date(base.getTime() + seconds * 1000);
  return () => target;
}

// `captureFilecoinEvents` + `findFilecoinEvent` +
// `useDocumentTestLifecycle` live in `filecoin-event-test-helpers.ts`
// so the standard Postgres test lifecycle + event-capture spy lives
// in one place (rev-cleanup §1 — fallow flagged the inline patterns).
useDocumentTestLifecycle();

describe('reconciler observability — promoted', () => {
  it('emits batch + per-row events with EXACT pendingAgeSeconds (clock-seamed)', async () => {
    const id = await seedRow({
      externalId: 'obs-promoted',
      pendingSinceSecondsAgo: 120,
      reconcileAttempts: 2,
    });
    // Inject `now` so `pendingAgeSeconds` is exactly the DB row's
    // `pending_since + 120s`, regardless of wall-clock drift.
    const pendingSince = await readPendingSince(id);
    const { events, restore } = captureFilecoinEvents();
    try {
      await runOnce({ ...deps(headRetrievable), now: offsetClock(pendingSince, 120) });
    } finally {
      restore();
    }
    const claimed = findFilecoinEvent(events, 'filecoin.reconcile.claimed');
    expect(claimed).toBeDefined();
    expect(claimed!.detail.batchSize).toBe(1);
    expect(typeof claimed!.detail.claimId).toBe('string');

    const promoted = findFilecoinEvent(events, 'filecoin.reconcile.promoted');
    expect(promoted).toBeDefined();
    expect(promoted!.detail.documentId).toBe(id);
    expect(promoted!.detail.provider).toBe('filecoin');
    expect(promoted!.detail.statusBefore).toBe('blob_pending');
    expect(promoted!.detail.statusAfter).toBe('blob_available');
    expect(promoted!.detail.reconcileAttempts).toBe(2);
    expect(promoted!.detail.pendingAgeSeconds).toBe(120);
  });
});

describe('reconciler observability — archival_failed', () => {
  it('emits archival_failed with EXACT pendingAgeSeconds on retry exhaustion', async () => {
    const id = await seedRow({
      externalId: 'obs-exhausted',
      reconcileAttempts: 9,
      pendingSinceSecondsAgo: 600,
    });
    const pendingSince = await readPendingSince(id);
    const { events, restore } = captureFilecoinEvents();
    try {
      await runOnce({
        ...deps(headPending),
        maxAttempts: 10,
        now: offsetClock(pendingSince, 600),
      });
    } finally {
      restore();
    }
    const failed = findFilecoinEvent(events, 'filecoin.reconcile.archival_failed');
    expect(failed).toBeDefined();
    expect(failed!.detail.statusAfter).toBe('blob_archival_failed');
    expect(failed!.detail.errorCode).toBe('reconcile_attempts_exhausted');
    expect(failed!.detail.reconcileAttempts).toBe(9);
    expect(failed!.detail.pendingAgeSeconds).toBe(600);
  });
});

describe('reconciler observability — stale_claim_recovered', () => {
  it('fires only when batch reclaimed a row whose prior claim_id was non-NULL', async () => {
    await seedRow({
      externalId: 'obs-stale',
      claimId: 'stale-worker-id',
      claimedAtSecondsAgo: 7200,
    });
    await seedRow({ externalId: 'obs-fresh' });
    const { events, restore } = captureFilecoinEvents();
    try {
      await runOnce(deps(headRetrievable));
    } finally {
      restore();
    }
    const recovered = events.filter(
      (e) => e.event === 'filecoin.reconcile.stale_claim_recovered',
    );
    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.detail.provider).toBe('filecoin');
    expect(typeof recovered[0]!.detail.claimId).toBe('string');
  });

  it('does NOT fire for batches that only claim fresh (claim_id NULL) rows', async () => {
    await seedRow({ externalId: 'obs-fresh-only' });
    const { events, restore } = captureFilecoinEvents();
    try {
      await runOnce(deps(headRetrievable));
    } finally {
      restore();
    }
    expect(findFilecoinEvent(events, 'filecoin.reconcile.stale_claim_recovered')).toBeUndefined();
  });
});

describe('reconciler observability — retrieval verification sanitization (review-fix HIGH 2)', () => {
  it('redacts planted credentials in verification_failed errorMessage', async () => {
    // Seed a row whose adapter `head()` returns retrievable BUT whose
    // bytes don't match `content_hash` — that triggers the
    // verification_failed permanent-failure path. We plant a UCAN-
    // shaped credential in the message that the (now central)
    // sanitizer MUST strip.
    const id = await seedRow({
      externalId: 'obs-verify-fail',
      contentHash: 'a'.repeat(64),
    });
    const planted = 'did:key:z6MkpZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ';
    // The reconciler's hash_verify path runs `get()` + decode +
    // sha256-compare. Override `get()` to throw an error carrying
    // the planted credential — that's the transient-verify-error
    // branch that emits `filecoin.retrieval.verification_failed`.
    const store = makeStore({
      head: async () => ({
        exists: true,
        metadata: {
          contentLength: 0,
          contentType: null,
          contentHash: null,
          providerMetadata: {},
        },
      }),
    });
    store.get = async () => {
      throw new Error(`gateway error: ${planted}`);
    };
    const customDeps = { ...DEFAULT_DEPS, store, verifyMode: 'hash_verify' as const };
    const { events, restore } = captureFilecoinEvents();
    try {
      await runOnce(customDeps);
    } finally {
      restore();
    }
    const verifyFailed = findFilecoinEvent(events, 'filecoin.retrieval.verification_failed');
    expect(verifyFailed).toBeDefined();
    expect(verifyFailed!.detail.errorMessage as string).not.toContain(planted);
    expect(verifyFailed!.detail.errorMessage as string).toContain('[REDACTED');
    // The companion archival_failed event MUST also be sanitized —
    // it carries the same vendor message through the central
    // projection.
    const archivalFailed = findFilecoinEvent(events, 'filecoin.reconcile.archival_failed');
    if (archivalFailed) {
      expect(archivalFailed.detail.errorMessage as string).not.toContain(planted);
    }
    // Touch `id` so vitest doesn't flag the seed as unused.
    expect(typeof id).toBe('string');
  });
});

describe('reconciler observability — empty batch', () => {
  it('emits no events when no rows are claimed', async () => {
    const { events, restore } = captureFilecoinEvents();
    try {
      await runOnce(deps(headRetrievable));
    } finally {
      restore();
    }
    expect(events).toEqual([]);
  });
});
