/**
 * Pure-function tests for the the managed-upload upload-pipeline decision
 * helpers. No DB / store / codec coupling — these tables drive the
 * orchestration loop, so they get coverage in isolation.
 */

import { describe, it, expect } from 'vitest';
import type { RawDocumentRow } from '../../db/raw-document-types.js';
import {
  classifyIdempotent,
  deriveFinalRawStorageStatus,
  readPersistedStoredStatus,
} from '../upload-decision.js';

function makeRow(overrides: Partial<RawDocumentRow>): RawDocumentRow {
  return {
    id: 'doc-1',
    userId: 'user-1',
    rawSourceId: 'src-1',
    externalId: 'ext-1',
    externalUri: null,
    displayName: null,
    mimeType: null,
    sizeBytes: null,
    contentHash: null,
    providerVersion: null,
    sourceModifiedAt: null,
    storageMode: 'pointer_only',
    storageUri: null,
    storageProvider: null,
    registrationStatus: 'registered',
    rawStorageStatus: 'pointer_recorded',
    rawStorageMetadata: {},
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    indexedContentHash: null,
    indexedAt: null,
    extractionStatus: 'not_required',
    semanticIndexStatus: 'not_required',
    lastError: null,
    rawStorageClaimId: null,
    rawStorageClaimedAt: null,
    rawStorageLastCheckedAt: null,
    rawStorageNextCheckAt: null,
    rawStorageReconcileAttempts: 0,
    rawStoragePendingSince: null,
    storageArtifactId: null,
    ...overrides,
  };
}

const HASH = 'h'.repeat(64);
const OTHER_HASH = 'b'.repeat(64);

describe('classifyIdempotent — decision table', () => {
  it('returns null when hash does not match (regardless of status)', () => {
    const row = makeRow({ contentHash: HASH, rawStorageStatus: 'blob_stored' });
    expect(classifyIdempotent(row, OTHER_HASH)).toBeNull();
  });

  it('returns returnExisting for blob_stored + same hash', () => {
    const row = makeRow({ contentHash: HASH, rawStorageStatus: 'blob_stored' });
    expect(classifyIdempotent(row, HASH)).toEqual({ kind: 'returnExisting' });
  });

  it('returns returnExisting for blob_pending + same hash', () => {
    const row = makeRow({ contentHash: HASH, rawStorageStatus: 'blob_pending' });
    expect(classifyIdempotent(row, HASH)).toEqual({ kind: 'returnExisting' });
  });

  it('returns returnExisting for blob_available + same hash', () => {
    const row = makeRow({ contentHash: HASH, rawStorageStatus: 'blob_available' });
    expect(classifyIdempotent(row, HASH)).toEqual({ kind: 'returnExisting' });
  });

  it('returns reclaimAndUpload for blob_uploading without URI (β-or-earlier crash)', () => {
    const row = makeRow({
      contentHash: HASH, rawStorageStatus: 'blob_uploading', storageUri: null,
    });
    expect(classifyIdempotent(row, HASH)).toEqual({ kind: 'reclaimAndUpload' });
  });

  it('returns finalize for blob_uploading WITH URI (β2→γ crash window)', () => {
    const row = makeRow({
      contentHash: HASH, rawStorageStatus: 'blob_uploading', storageUri: 'ipfs://bafy',
    });
    expect(classifyIdempotent(row, HASH)).toEqual({ kind: 'finalize' });
  });

  it('returns reclaimAndUpload for raw_storage_failed + same hash (retry)', () => {
    const row = makeRow({ contentHash: HASH, rawStorageStatus: 'raw_storage_failed' });
    expect(classifyIdempotent(row, HASH)).toEqual({ kind: 'reclaimAndUpload' });
  });

  it('returns null for pointer_recorded (fresh upload — no recovery applies)', () => {
    const row = makeRow({ contentHash: HASH, rawStorageStatus: 'pointer_recorded' });
    expect(classifyIdempotent(row, HASH)).toBeNull();
  });

  it('returns null for blob_tombstoned (terminal — caller should error)', () => {
    const row = makeRow({ contentHash: HASH, rawStorageStatus: 'blob_tombstoned' });
    expect(classifyIdempotent(row, HASH)).toBeNull();
  });

  it('returns null for blob_deleted (terminal — caller should error)', () => {
    const row = makeRow({ contentHash: HASH, rawStorageStatus: 'blob_deleted' });
    expect(classifyIdempotent(row, HASH)).toBeNull();
  });
});

describe('deriveFinalRawStorageStatus — provider-aware mapping', () => {
  it('maps pending → blob_pending regardless of provider', () => {
    expect(deriveFinalRawStorageStatus({ storedStatus: 'pending', storageProvider: 'filecoin' }))
      .toBe('blob_pending');
    expect(deriveFinalRawStorageStatus({ storedStatus: 'pending', storageProvider: 'local_fs' }))
      .toBe('blob_pending');
    expect(deriveFinalRawStorageStatus({ storedStatus: 'pending', storageProvider: 's3' }))
      .toBe('blob_pending');
  });

  it('maps stored + filecoin → blob_available (gateway-confirmed retrievable)', () => {
    expect(deriveFinalRawStorageStatus({ storedStatus: 'stored', storageProvider: 'filecoin' }))
      .toBe('blob_available');
  });

  it('maps stored + immediate providers → blob_stored', () => {
    expect(deriveFinalRawStorageStatus({ storedStatus: 'stored', storageProvider: 'local_fs' }))
      .toBe('blob_stored');
    expect(deriveFinalRawStorageStatus({ storedStatus: 'stored', storageProvider: 's3' }))
      .toBe('blob_stored');
  });
});

describe('readPersistedStoredStatus', () => {
  it('reads the internal upload_result.stored_status sidecar', () => {
    expect(readPersistedStoredStatus({ upload_result: { stored_status: 'pending' } }))
      .toBe('pending');
    expect(readPersistedStoredStatus({ upload_result: { stored_status: 'stored' } }))
      .toBe('stored');
  });

  it('returns null when the sidecar is missing or malformed', () => {
    expect(readPersistedStoredStatus({})).toBeNull();
    expect(readPersistedStoredStatus({ upload_result: null })).toBeNull();
    expect(readPersistedStoredStatus({ upload_result: 'wrong-type' })).toBeNull();
    expect(readPersistedStoredStatus({ upload_result: { stored_status: 'gibberish' } })).toBeNull();
  });
});
