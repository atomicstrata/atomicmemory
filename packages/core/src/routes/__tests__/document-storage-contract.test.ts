/**
 * Step 7 of the storage-sibling plan — contract test for the
 * document wire shape.
 *
 * The Webapp Storage UI work (source plan Phase 8) will eventually
 * replace these projected fields with `storage_artifacts`-native
 * data, but Step 7 must NOT remove them. The webapp's
 * `ContextRow` / `FilecoinCidChip` / `documentRecordMapper` /
 * `ContextDocumentStatus` all read `raw_storage_status`,
 * `storage_provider`, `raw_storage_metadata`, and
 * `delete_semantics`; this test locks the contract so a Step-7
 * refactor regression surfaces here.
 *
 * Implemented as a focused unit test against `formatRawDocument`
 * so it doesn't depend on a booted Postgres harness.
 */

import { describe, expect, it } from 'vitest';
import { formatRawDocument } from '../document-response-formatters.js';
import { buildStoreRegistry } from '../../storage/store-registry.js';
import { LocalFsRawContentStore } from '../../storage/local-fs-store.js';
import type { RawDocumentRow } from '../../db/raw-document-types.js';

function makeRow(overrides: Partial<RawDocumentRow> = {}): RawDocumentRow {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    userId: 'u-1',
    rawSourceId: '22222222-2222-4222-8222-222222222222',
    externalId: 'ext-1',
    externalUri: 'https://example.com/x.pdf',
    displayName: null,
    mimeType: 'application/pdf',
    sizeBytes: 100,
    contentHash: 'abc',
    providerVersion: null,
    sourceModifiedAt: null,
    storageMode: 'managed_blob',
    storageUri: 'file:///tmp/x',
    storageProvider: 'local_fs',
    registrationStatus: 'registered',
    rawStorageStatus: 'blob_stored',
    rawStorageMetadata: {},
    metadata: {},
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:01Z'),
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
    storageArtifactId: '33333333-3333-4333-8333-333333333333',
    ...overrides,
  };
}

describe('Step 7 — document wire shape preserves the webapp contract', () => {
  it('formatRawDocument still emits raw_storage_status, storage_provider, raw_storage_metadata, and delete_semantics', () => {
    const store = new LocalFsRawContentStore({ root: '/tmp' });
    const registry = buildStoreRegistry(store, []);
    const wire = formatRawDocument(makeRow(), registry) as Record<string, unknown>;
    expect(wire.raw_storage_status).toBe('blob_stored');
    expect(wire.storage_provider).toBe('local_fs');
    expect(wire.raw_storage_metadata).toEqual({});
    expect(wire.delete_semantics).toBe('delete');
  });

  it('additively surfaces storage_artifact_id (new) while keeping the existing fields populated', () => {
    const store = new LocalFsRawContentStore({ root: '/tmp' });
    const registry = buildStoreRegistry(store, []);
    const wire = formatRawDocument(
      makeRow({ storageArtifactId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }),
      registry,
    ) as Record<string, unknown>;
    expect(wire.storage_artifact_id).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
    expect(wire.raw_storage_status).toBe('blob_stored');
    expect(wire.storage_provider).toBe('local_fs');
    expect(wire.delete_semantics).toBe('delete');
  });
});
