/**
 * Phase 6 reconciler eligibility tests. Covers the two-axis truth
 * table (claim_id × next_check_at) + the exclusion rules that gate
 * non-`blob_pending` Filecoin rows out of the worker entirely.
 *
 * Outcomes / metadata-merge / backoff / retry-exhaustion tests live
 * in `raw-storage-reconciler-outcomes.test.ts` to keep each file
 * under the 400-non-comment-line cap.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../../db/pool.js';
import { clearDocumentTables, setupTestSchema } from '../../db/__tests__/test-fixtures.js';
import { getRawDocumentById } from '../../db/raw-document-repository.js';
import { runOnce } from '../raw-storage-reconciler.js';
import {
  USER,
  deps,
  headRetrievable,
  seedRow,
} from './raw-storage-reconciler-test-helpers.js';

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

describe('reconciler runOnce — eligibility truth table', () => {
  it("eligible: claim_id NULL, next_check_at NULL — first probe ever", async () => {
    const id = await seedRow({ externalId: 'e-never-probed' });
    const summary = await runOnce(deps(headRetrievable));
    expect(summary.claimed).toBe(1);
    expect(summary.promoted).toBe(1);
    const row = await getRawDocumentById(pool, USER, id);
    expect(row?.rawStorageStatus).toBe('blob_available');
  });

  it('eligible: claim_id NULL, next_check_at in the past — backoff elapsed', async () => {
    const id = await seedRow({ externalId: 'e-backoff-elapsed', nextCheckAtSecondsAgo: 10 });
    const summary = await runOnce(deps(headRetrievable));
    expect(summary.promoted).toBe(1);
    const row = await getRawDocumentById(pool, USER, id);
    expect(row?.rawStorageStatus).toBe('blob_available');
  });

  it('NOT eligible: claim_id NULL, next_check_at in the future — backoff still in effect', async () => {
    const id = await seedRow({ externalId: 'e-backoff-pending', nextCheckAtSecondsAgo: -60 });
    const summary = await runOnce(deps(headRetrievable));
    expect(summary.claimed).toBe(0);
    const row = await getRawDocumentById(pool, USER, id);
    expect(row?.rawStorageStatus).toBe('blob_pending');
  });

  it('NOT eligible: fresh claim — active owner', async () => {
    const id = await seedRow({
      externalId: 'e-fresh-claim',
      claimId: 'other-worker',
      claimedAtSecondsAgo: 10,
    });
    const summary = await runOnce(deps(headRetrievable));
    expect(summary.claimed).toBe(0);
    const row = await getRawDocumentById(pool, USER, id);
    expect(row?.rawStorageClaimId).toBe('other-worker');
  });

  it('eligible: stale claim + next_check_at in the past — owner abandoned + backoff elapsed', async () => {
    const id = await seedRow({
      externalId: 'e-stale-elapsed',
      claimId: 'abandoned',
      claimedAtSecondsAgo: 600,
      nextCheckAtSecondsAgo: 10,
    });
    const summary = await runOnce(deps(headRetrievable));
    expect(summary.promoted).toBe(1);
    const row = await getRawDocumentById(pool, USER, id);
    expect(row?.rawStorageStatus).toBe('blob_available');
    expect(row?.rawStorageClaimId).toBeNull();
  });

  it("NOT eligible: stale claim + next_check_at in the future — don't override backoff", async () => {
    const id = await seedRow({
      externalId: 'e-stale-blocked',
      claimId: 'abandoned',
      claimedAtSecondsAgo: 600,
      nextCheckAtSecondsAgo: -60,
    });
    const summary = await runOnce(deps(headRetrievable));
    expect(summary.claimed).toBe(0);
    const row = await getRawDocumentById(pool, USER, id);
    expect(row?.rawStorageStatus).toBe('blob_pending');
  });
});

describe('reconciler runOnce — exclusion rules', () => {
  it('skips rows with null storage_uri (Phase α-only — recover via uploadRaw)', async () => {
    const id = await seedRow({ externalId: 'e-null-uri', storageUri: null });
    const summary = await runOnce(deps(headRetrievable));
    expect(summary.claimed).toBe(0);
    const row = await getRawDocumentById(pool, USER, id);
    expect(row?.rawStorageStatus).toBe('blob_pending');
  });

  it('skips non-filecoin rows', async () => {
    const id = await seedRow({
      externalId: 'e-non-filecoin',
      storageProvider: 'local_fs',
      storageUri: 'local-fs://test.bin',
    });
    const summary = await runOnce(deps(headRetrievable));
    expect(summary.claimed).toBe(0);
    const row = await getRawDocumentById(pool, USER, id);
    expect(row?.rawStorageStatus).toBe('blob_pending');
  });

  it('skips blob_uploading rows (those recover via uploadRaw idempotency)', async () => {
    const id = await seedRow({
      externalId: 'e-uploading',
      rawStorageStatus: 'blob_uploading',
    });
    const summary = await runOnce(deps(headRetrievable));
    expect(summary.claimed).toBe(0);
    const row = await getRawDocumentById(pool, USER, id);
    expect(row?.rawStorageStatus).toBe('blob_uploading');
  });

  it('skips already-terminal blob_available rows', async () => {
    await seedRow({ externalId: 'e-available', rawStorageStatus: 'blob_available' });
    const summary = await runOnce(deps(headRetrievable));
    expect(summary.claimed).toBe(0);
  });
});
