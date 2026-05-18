/**
 * public tests — `formatRawDocument`, `formatUploadRawDocumentResponse`,
 * and `formatPassportFeedRow` emit:
 *   1. `raw_storage_metadata` redacted through the public allowlist
 *      (no `upload_result`, no AES-GCM internals, internal copies
 *      flattened to `copy_count` / `provider_ids` / `copy_statuses`,
 *      unknown filecoin fields stripped).
 *   2. Per-row `delete_semantics` resolved from the row's
 *      `storage_provider` via the registry (`filecoin → tombstone`,
 *      `local_fs → delete`, pointer-only/unregistered → null).
 *
 * These tests use registry stubs + row literals; the helper-level
 * redaction is covered in `public-raw-storage-metadata.test.ts` and
 * the end-to-end wire-level test lives in `documents.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import {
  formatPassportFeedResponse,
  formatRawDocument,
  formatUploadRawDocumentResponse,
} from '../document-response-formatters.js';
import {
  buildStoreRegistry,
  singleStoreRegistry,
} from '../../storage/store-registry.js';
import type {
  RawContentStore,
  RawContentStoreCapabilities,
} from '../../storage/raw-content-store.js';
import type { LastError, RawDocumentRow } from '../../db/raw-document-types.js';
import type { ListPassportFeedResult } from '../../db/passport-feed-repository.js';
import { REAL_PIECE_CID_A } from '../../storage/__tests__/filecoin-cid-fixtures.js';

function makeStore(provider: string, deleteSemantics: 'delete' | 'unpin' | 'tombstone'): RawContentStore {
  const capabilities: RawContentStoreCapabilities = {
    addressing: deleteSemantics === 'tombstone' ? 'content' : 'location',
    retrievalConsistency: deleteSemantics === 'tombstone' ? 'eventual' : 'immediate',
    deleteSemantics,
    supportsHead: true,
    supportsGet: true,
  };
  return {
    provider,
    capabilities,
    put: async () => { throw new Error('not used'); },
    get: async () => { throw new Error('not used'); },
    head: async () => ({ exists: false, metadata: null }),
    delete: async () => ({ deleted: false, semantics: 'deleted' }),
  };
}

const FILECOIN_STORE = makeStore('filecoin', 'tombstone');
const LOCAL_FS_STORE = makeStore('local_fs', 'delete');

const MIXED_REGISTRY = buildStoreRegistry(FILECOIN_STORE, [LOCAL_FS_STORE]);
const POINTER_ONLY_REGISTRY = singleStoreRegistry(null);

function makeRow(overrides: Partial<RawDocumentRow>): RawDocumentRow {
  return {
    id: 'doc-1',
    userId: 'user-1',
    rawSourceId: 'src-1',
    externalId: 'ext-1',
    externalUri: null,
    displayName: null,
    mimeType: null,
    sizeBytes: 11,
    contentHash: 'a'.repeat(64),
    providerVersion: null,
    sourceModifiedAt: null,
    storageMode: 'managed_blob',
    storageUri: 'ipfs://bafy-test',
    storageProvider: 'filecoin',
    registrationStatus: 'registered',
    rawStorageStatus: 'blob_pending',
    rawStorageMetadata: {},
    metadata: {},
    createdAt: new Date('2026-05-11T00:00:00.000Z'),
    updatedAt: new Date('2026-05-11T00:00:00.000Z'),
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

const INTERNAL_METADATA: Record<string, unknown> = {
  codec: {
    name: 'aes_gcm',
    version: 1,
    nonce: 'PLANTED-NONCE',
    tag: 'PLANTED-TAG',
    key_id: 'v1',
    encoded_content_hash: 'planted-encoded-hex',
  },
  filecoin: {
    ipfs_cid: 'bafy' + 'a'.repeat(55),
    piece_cid: REAL_PIECE_CID_A,
    // Internal Synapse-backed sidecar shape — unsupported legacy keys + raw
    // structured deals/copies live here and MUST NOT reach the
    // wire. The public projection only emits flattened copy_count /
    // provider_ids / copy_statuses.
    copies: [
      { provider_id: 'f01', status: 'active' },
      { provider_id: 'f02', status: 'pending' },
    ],
    onramp: 'storacha',
    gateway_url: 'https://w3s.link/ipfs/bafy-test',
    onramp_status: 'retrievable',
    internal_billing_secret: 'PLANTED-SECRET',
    wallet_address: '0xPLANTED-WALLET',
  },
  upload_result: { stored_status: 'pending' },
};

/**
 * the durable URI-write step compensation envelope shape — public allow-listed fields
 * (`layer`, `code`, `message`, `occurred_at`) plus the server-only
 * `internal_recovery_hint` carrying the orphan URI + provider. The
 * formatter strips `internal_*` keys before exposing on the wire.
 */
const LAST_ERROR_WITH_RECOVERY_HINT = {
  layer: 'raw_storage',
  code: 'artifact_not_linkable',
  message: 'prior artifact is in delete lifecycle',
  occurred_at: '2026-05-11T00:00:00.000Z',
  internal_recovery_hint: {
    storage_uri: 'local-fs://orphan-uri.bin',
    storage_provider: 'local_fs',
    cleanup_error: 'Error: synthetic backend delete failure',
  },
} as unknown as LastError;

describe('formatRawDocument — public redaction + delete_semantics', () => {
  it('redacts internal sidecars + emits filecoin → tombstone for an active Filecoin row', () => {
    const out = formatRawDocument(
      makeRow({ rawStorageMetadata: INTERNAL_METADATA, storageProvider: 'filecoin' }),
      MIXED_REGISTRY,
    );
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('PLANTED-NONCE');
    expect(serialized).not.toContain('PLANTED-TAG');
    expect(serialized).not.toContain('PLANTED-SECRET');
    expect(serialized).not.toContain('PLANTED-WALLET');
    expect(serialized).not.toContain('upload_result');
    expect(serialized).not.toContain('stored_status');
    expect(serialized).not.toContain('encoded_content_hash');
    // Legacy onramp public fields are no longer in the allowlist.
    expect(serialized).not.toContain('storacha');
    expect(serialized).not.toContain('gateway_url');
    expect(serialized).not.toContain('onramp_status');
    expect(out.raw_storage_metadata).toEqual({
      codec: { name: 'aes_gcm', version: 1 },
      filecoin: {
        ipfs_cid: 'bafy' + 'a'.repeat(55),
        piece_cid: REAL_PIECE_CID_A,
        copy_count: 2,
        provider_ids: ['f01', 'f02'],
        copy_statuses: ['active', 'pending'],
      },
    });
    expect(out.delete_semantics).toBe('tombstone');
  });

  it("emits 'delete' for a local_fs row (legacy provider, registered)", () => {
    const out = formatRawDocument(
      makeRow({ storageProvider: 'local_fs', storageUri: 'local-fs://x.bin' }),
      MIXED_REGISTRY,
    );
    expect(out.delete_semantics).toBe('delete');
  });

  it('emits null delete_semantics for a pointer-only row (no managed blob)', () => {
    const out = formatRawDocument(
      makeRow({
        storageMode: 'pointer_only',
        storageProvider: null,
        storageUri: null,
        rawStorageStatus: 'pointer_recorded',
        rawStorageMetadata: {},
      }),
      POINTER_ONLY_REGISTRY,
    );
    expect(out.delete_semantics).toBeNull();
    expect(out.raw_storage_metadata).toEqual({});
  });

  it('strips internal_recovery_hint from last_error while preserving the public envelope', () => {
    const out = formatRawDocument(
      makeRow({
        storageProvider: 'local_fs', storageUri: 'local-fs://x.bin',
        lastError: LAST_ERROR_WITH_RECOVERY_HINT,
      }),
      MIXED_REGISTRY,
    );
    expect(JSON.stringify(out)).not.toContain('internal_recovery_hint');
    expect(JSON.stringify(out)).not.toContain('local-fs://orphan-uri.bin');
    expect(out.last_error).toEqual({
      layer: 'raw_storage',
      code: 'artifact_not_linkable',
      message: 'prior artifact is in delete lifecycle',
      occurred_at: '2026-05-11T00:00:00.000Z',
    });
  });

  it('emits null delete_semantics for a row whose provider is not registered', () => {
    // Filecoin-active deployment encounters a stale `s3://` row that
    // pre-dates a provider switch with no legacy registration.
    const filecoinOnly = singleStoreRegistry(FILECOIN_STORE);
    const out = formatRawDocument(
      makeRow({ storageProvider: 's3', storageUri: 's3://b/k.bin' }),
      filecoinOnly,
    );
    expect(out.delete_semantics).toBeNull();
  });
});

describe('formatUploadRawDocumentResponse — public redaction + delete_semantics', () => {
  it('strips internal metadata + emits filecoin delete_semantics on a successful upload', () => {
    const out = formatUploadRawDocumentResponse(
      {
        documentId: 'doc-1', storageProvider: 'filecoin',
        storageUri: 'ipfs://bafy-test', contentHash: 'a'.repeat(64),
        sizeBytes: 11, rawStorageStatus: 'blob_pending',
        storageMode: 'managed_blob',
        rawStorageMetadata: INTERNAL_METADATA,
        idempotentSkip: false,
      },
      MIXED_REGISTRY,
    );
    expect(JSON.stringify(out)).not.toContain('upload_result');
    expect(JSON.stringify(out)).not.toContain('PLANTED-NONCE');
    expect(out.delete_semantics).toBe('tombstone');
    const meta = out.raw_storage_metadata as {
      filecoin: { copy_count: number; provider_ids: string[]; copy_statuses: string[] };
    };
    expect(meta.filecoin.copy_count).toBe(2);
    expect(meta.filecoin.provider_ids).toEqual(['f01', 'f02']);
    expect(meta.filecoin.copy_statuses).toEqual(['active', 'pending']);
  });

  it("emits 'delete' for a local_fs upload", () => {
    const out = formatUploadRawDocumentResponse(
      {
        documentId: 'doc-x', storageProvider: 'local_fs',
        storageUri: 'local-fs://x.bin', contentHash: 'b'.repeat(64),
        sizeBytes: 5, rawStorageStatus: 'blob_stored',
        storageMode: 'managed_blob',
        rawStorageMetadata: { codec: { name: 'none', version: 1 } },
        idempotentSkip: false,
      },
      MIXED_REGISTRY,
    );
    expect(out.delete_semantics).toBe('delete');
  });
});

describe('formatPassportFeedResponse — public grouped-row widening + redaction', () => {
  function makeGroupedRow(overrides: { storageProvider: string | null; meta: Record<string, unknown> }) {
    return {
      kind: 'document_grouped' as const,
      documentId: 'doc-1',
      sortAt: new Date('2026-05-11T00:00:00.000Z'),
      sortId: 'sort-1',
      representative: {
        id: 'mem-1', content: 'hi',
        createdAt: new Date('2026-05-11T00:00:00.000Z'),
        sourceSite: null,
      },
      chunkCount: 1,
      rawStorageStatus: 'blob_pending',
      extractionStatus: 'complete',
      semanticIndexStatus: 'complete',
      lastError: null,
      displayName: null,
      mimeType: null,
      storageProvider: overrides.storageProvider,
      rawStorageMetadata: overrides.meta,
    };
  }

  it('grouped Filecoin row emits redacted metadata + delete_semantics=tombstone + flat copy_count', () => {
    const result: ListPassportFeedResult = {
      rows: [makeGroupedRow({ storageProvider: 'filecoin', meta: INTERNAL_METADATA })],
      nextCursor: null,
    };
    const out = formatPassportFeedResponse(result, MIXED_REGISTRY);
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('upload_result');
    expect(serialized).not.toContain('PLANTED-NONCE');
    expect(serialized).not.toContain('PLANTED-SECRET');
    expect(serialized).not.toContain('PLANTED-WALLET');
    expect(serialized).not.toContain('storacha');
    const rows = (out.rows as Array<Record<string, unknown>>);
    const grouped = rows[0];
    expect(grouped.storage_provider).toBe('filecoin');
    expect(grouped.delete_semantics).toBe('tombstone');
    const filecoin = (grouped.raw_storage_metadata as {
      filecoin: { copy_count: number; provider_ids: string[]; copy_statuses: string[] };
    }).filecoin;
    expect(filecoin.copy_count).toBe(2);
    expect(filecoin.provider_ids).toEqual(['f01', 'f02']);
    expect(filecoin.copy_statuses).toEqual(['active', 'pending']);
  });

  it('grouped local_fs row emits delete_semantics=delete', () => {
    const result: ListPassportFeedResult = {
      rows: [makeGroupedRow({ storageProvider: 'local_fs', meta: { codec: { name: 'none', version: 1 } } })],
      nextCursor: null,
    };
    const out = formatPassportFeedResponse(result, MIXED_REGISTRY);
    const grouped = (out.rows as Array<Record<string, unknown>>)[0];
    expect(grouped.delete_semantics).toBe('delete');
  });

  it('grouped row with null storage_provider emits null delete_semantics', () => {
    const result: ListPassportFeedResult = {
      rows: [makeGroupedRow({ storageProvider: null, meta: {} })],
      nextCursor: null,
    };
    const out = formatPassportFeedResponse(result, MIXED_REGISTRY);
    const grouped = (out.rows as Array<Record<string, unknown>>)[0];
    expect(grouped.storage_provider).toBeNull();
    expect(grouped.delete_semantics).toBeNull();
    expect(grouped.raw_storage_metadata).toEqual({});
  });

  it('grouped row strips internal_recovery_hint from last_error while keeping layer/code/message', () => {
    const lastError = LAST_ERROR_WITH_RECOVERY_HINT;
    const result: ListPassportFeedResult = {
      rows: [{ ...makeGroupedRow({ storageProvider: 'local_fs', meta: {} }), lastError }],
      nextCursor: null,
    };
    const out = formatPassportFeedResponse(result, MIXED_REGISTRY);
    expect(JSON.stringify(out)).not.toContain('internal_recovery_hint');
    expect(JSON.stringify(out)).not.toContain('local-fs://orphan-uri.bin');
    const grouped = (out.rows as Array<Record<string, unknown>>)[0];
    expect(grouped.last_error).toEqual({
      layer: 'raw_storage',
      code: 'artifact_not_linkable',
      message: 'prior artifact is in delete lifecycle',
      occurred_at: '2026-05-11T00:00:00.000Z',
    });
  });

  it('standalone-memory rows are unaffected by public widening', () => {
    const result: ListPassportFeedResult = {
      rows: [{
        kind: 'standalone_memory',
        sortAt: new Date('2026-05-11T00:00:00.000Z'),
        sortId: 'm-1',
        memory: {
          id: 'mem-x', content: 'hi',
          createdAt: new Date('2026-05-11T00:00:00.000Z'),
          sourceSite: 'web',
        },
      }],
      nextCursor: null,
    };
    const out = formatPassportFeedResponse(result, MIXED_REGISTRY);
    const standalone = (out.rows as Array<Record<string, unknown>>)[0];
    expect(standalone.kind).toBe('standalone_memory');
    expect(standalone).not.toHaveProperty('storage_provider');
    expect(standalone).not.toHaveProperty('raw_storage_metadata');
    expect(standalone).not.toHaveProperty('delete_semantics');
  });
});
