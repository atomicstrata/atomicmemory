/**
 * per-row provider dispatch tests for `RawContentStoreRegistry` + per-provider cleanup
 * dispatch + `markCleanupSuccess` marker selection.
 *
 * These tests intentionally avoid the DB layer — that's covered by the
 * integration tests in `blob-deletion-direct.test.ts` /
 * `blob-deletion-source-reset.test.ts`. Here we test the typed
 * boundary between the cleanup helper and the adapters via fakes.
 */

import { describe, it, expect, vi } from 'vitest';
import { cleanupManagedBlobs } from '../cleanup.js';
import {
  buildStoreRegistry,
  getDeleteSemantics,
  singleStoreRegistry,
} from '../store-registry.js';
import type {
  RawContentStore,
  RawContentStoreCapabilities,
} from '../raw-content-store.js';

function makeStore(
  provider: string,
  semantics: 'delete' | 'unpin' | 'tombstone',
  overrides: Partial<RawContentStore> = {},
): RawContentStore {
  const capabilities: RawContentStoreCapabilities = {
    addressing: semantics === 'tombstone' ? 'content' : 'location',
    retrievalConsistency: semantics === 'tombstone' ? 'eventual' : 'immediate',
    deleteSemantics: semantics,
    supportsHead: true,
    supportsGet: true,
  };
  const base: RawContentStore = {
    provider,
    capabilities,
    put: async () => { throw new Error(`${provider}: put not used in test`); },
    get: async () => { throw new Error(`${provider}: get not used in test`); },
    head: async () => ({ exists: false, metadata: null }),
    delete: async () => ({
      deleted: true,
      semantics: semantics === 'tombstone' ? 'tombstoned' : semantics === 'unpin' ? 'unpinned' : 'deleted',
    }),
  };
  return { ...base, ...overrides };
}

describe('RawContentStoreRegistry construction', () => {
  it('exposes active and entries from singleStoreRegistry', () => {
    const store = makeStore('local_fs', 'delete');
    const reg = singleStoreRegistry(store);
    expect(reg.active).toBe(store);
    expect(reg.entries).toEqual([['local_fs', store]]);
    expect(reg.get('local_fs')).toBe(store);
    expect(reg.get('s3')).toBeUndefined();
  });

  it('singleStoreRegistry(null) is a pointer-only registry', () => {
    const reg = singleStoreRegistry(null);
    expect(reg.active).toBeNull();
    expect(reg.entries).toEqual([]);
    expect(reg.get('local_fs')).toBeUndefined();
  });

  it('buildStoreRegistry combines active + legacy stores', () => {
    const active = makeStore('filecoin', 'tombstone');
    const legacy = makeStore('s3', 'delete');
    const reg = buildStoreRegistry(active, [legacy]);
    expect(reg.active).toBe(active);
    expect(reg.get('filecoin')).toBe(active);
    expect(reg.get('s3')).toBe(legacy);
    expect(reg.entries.map(([p]) => p).sort()).toEqual(['filecoin', 's3']);
  });

  it('throws when the same provider is registered twice', () => {
    const active = makeStore('s3', 'delete');
    const dup = makeStore('s3', 'delete');
    expect(() => buildStoreRegistry(active, [dup])).toThrow(/registered twice/);
  });
});

describe('getDeleteSemantics', () => {
  it('returns the registered adapter capability', () => {
    const reg = buildStoreRegistry(makeStore('filecoin', 'tombstone'), [
      makeStore('local_fs', 'delete'),
    ]);
    expect(getDeleteSemantics(reg, 'filecoin')).toBe('tombstone');
    expect(getDeleteSemantics(reg, 'local_fs')).toBe('delete');
  });

  it('returns null for unregistered or null providers', () => {
    const reg = singleStoreRegistry(makeStore('s3', 'delete'));
    expect(getDeleteSemantics(reg, null)).toBeNull();
    expect(getDeleteSemantics(reg, 'filecoin')).toBeNull();
  });
});

describe('cleanupManagedBlobs — per-provider dispatch', () => {
  it('dispatches each blob to the registered adapter for its provider', async () => {
    const localDelete = vi.fn(async () => ({ deleted: true, semantics: 'deleted' as const }));
    const s3Delete = vi.fn(async () => ({ deleted: false, semantics: 'deleted' as const }));
    const filecoinDelete = vi.fn(async () => ({ deleted: true, semantics: 'tombstoned' as const }));
    const reg = buildStoreRegistry(makeStore('filecoin', 'tombstone', { delete: filecoinDelete }), [
      makeStore('local_fs', 'delete', { delete: localDelete }),
      makeStore('s3', 'delete', { delete: s3Delete }),
    ]);
    const result = await cleanupManagedBlobs(reg, [
      { rawDocumentId: 'doc-test', storageProvider: 'local_fs', storageUri: 'local-fs://a', rawStorageMetadata: {} },
      { rawDocumentId: 'doc-test', storageProvider: 's3', storageUri: 's3://b/c', rawStorageMetadata: {} },
      { rawDocumentId: 'doc-test', storageProvider: 'filecoin', storageUri: 'ipfs://bafy', rawStorageMetadata: {} },
    ]);
    // Cleanup now plumbs `raw_storage_metadata` as opaque
    // `RawContentHints` (defaulting to `{}` when the ref doesn't
    // carry any). The second arg is the hints map.
    expect(localDelete).toHaveBeenCalledWith('local-fs://a', {});
    expect(s3Delete).toHaveBeenCalledWith('s3://b/c', {});
    expect(filecoinDelete).toHaveBeenCalledWith('ipfs://bafy', {});
    expect(result.successes).toHaveLength(3);
    expect(result.failures).toEqual([]);
    expect(result.deleted).toBe(2);
    expect(result.alreadyMissing).toBe(1);
  });

  it('records non-failure outcomes (including already-missing) in successes[]', async () => {
    const reg = singleStoreRegistry(makeStore('local_fs', 'delete', {
      delete: async () => ({ deleted: false, semantics: 'deleted' }),
    }));
    const result = await cleanupManagedBlobs(reg, [
      { rawDocumentId: 'doc-test', storageProvider: 'local_fs', storageUri: 'local-fs://gone', rawStorageMetadata: {} },
    ]);
    // Success entries MUST NOT carry the input-only
    // `rawStorageMetadata` hint (data-leak invariant).
    expect(result.successes).toEqual([
      { rawDocumentId: 'doc-test', storageProvider: 'local_fs', storageUri: 'local-fs://gone', deleted: false, semantics: 'deleted' },
    ]);
    expect(result.failures).toEqual([]);
  });

  it('records adapter exceptions in failures[], not successes[]', async () => {
    const reg = singleStoreRegistry(makeStore('s3', 'delete', {
      delete: async () => { throw new Error('boom'); },
    }));
    const result = await cleanupManagedBlobs(reg, [
      { rawDocumentId: 'doc-test', storageProvider: 's3', storageUri: 's3://b/c', rawStorageMetadata: {} },
    ]);
    expect(result.successes).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].message).toBe('boom');
  });

  it('reports missing provider loudly (no silent fall-through to active store)', async () => {
    const activeDelete = vi.fn(async () => ({ deleted: true, semantics: 'tombstoned' as const }));
    const reg = singleStoreRegistry(makeStore('filecoin', 'tombstone', { delete: activeDelete }));
    const result = await cleanupManagedBlobs(reg, [
      { rawDocumentId: 'doc-test', storageProvider: 's3', storageUri: 's3://legacy/orphan', rawStorageMetadata: {} },
    ]);
    expect(activeDelete).not.toHaveBeenCalled();
    expect(result.successes).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].message).toMatch(/provider 's3'/);
    expect(result.failures[0].message).toMatch(/RAW_STORAGE_LEGACY_PROVIDERS/);
  });

  it('passes the ref\'s rawStorageMetadata through to store.delete as RawContentHints', async () => {
    // Filecoin specifically needs this so the adapter can extract
    // `data_set_id` + `copies[].piece_id` and route around the
    // SDK's CID→active-piece lookup. Non-Filecoin adapters
    // receive the same opaque map and ignore it.
    const filecoinDelete = vi.fn(async () => ({ deleted: true, semantics: 'tombstoned' as const }));
    const reg = singleStoreRegistry(makeStore('filecoin', 'tombstone', { delete: filecoinDelete }));
    const sidecar = {
      filecoin: {
        data_set_id: '42',
        copies: [{ data_set_id: '42', piece_id: '7' }],
      },
    };
    await cleanupManagedBlobs(reg, [
      {
        rawDocumentId: 'doc-test',
        storageProvider: 'filecoin',
        storageUri: 'filecoin://piece/baga-x',
        rawStorageMetadata: sidecar,
      },
    ]);
    expect(filecoinDelete).toHaveBeenCalledWith('filecoin://piece/baga-x', sidecar);
  });

  it('success entries DROP rawStorageMetadata (input-only hint — never leaks to result/error)', async () => {
    const reg = singleStoreRegistry(makeStore('filecoin', 'tombstone', {
      delete: async () => ({ deleted: true, semantics: 'tombstoned' as const }),
    }));
    const sidecar = {
      filecoin: {
        data_set_id: '42',
        copies: [{ data_set_id: '42', piece_id: '7' }],
      },
    };
    const result = await cleanupManagedBlobs(reg, [
      {
        rawDocumentId: 'doc-leak-check',
        storageProvider: 'filecoin',
        storageUri: 'filecoin://piece/baga-leak',
        rawStorageMetadata: sidecar,
      },
    ]);
    expect(result.successes).toHaveLength(1);
    const entry = result.successes[0] as unknown as Record<string, unknown>;
    expect(entry).not.toHaveProperty('rawStorageMetadata');
    expect(Object.keys(entry).sort()).toEqual(
      ['deleted', 'rawDocumentId', 'semantics', 'storageProvider', 'storageUri'],
    );
    // Defense-in-depth — no piece_id / data_set_id substrings reach
    // the serialized result envelope (which feeds 500 envelopes
    // and observability).
    const json = JSON.stringify(result);
    expect(json).not.toContain('piece_id');
    expect(json).not.toContain('data_set_id');
  });

  it('failure entries DROP rawStorageMetadata (adapter-throw path)', async () => {
    const reg = singleStoreRegistry(makeStore('filecoin', 'tombstone', {
      delete: async () => { throw new Error('boom'); },
    }));
    const sidecar = {
      filecoin: {
        data_set_id: '42',
        copies: [{ data_set_id: '42', piece_id: '7' }],
      },
    };
    const result = await cleanupManagedBlobs(reg, [
      {
        rawDocumentId: 'doc-leak-check-fail',
        storageProvider: 'filecoin',
        storageUri: 'filecoin://piece/baga-leak-fail',
        rawStorageMetadata: sidecar,
      },
    ]);
    expect(result.failures).toHaveLength(1);
    const entry = result.failures[0] as unknown as Record<string, unknown>;
    expect(entry).not.toHaveProperty('rawStorageMetadata');
    expect(Object.keys(entry).sort()).toEqual(
      ['message', 'rawDocumentId', 'storageProvider', 'storageUri'],
    );
    const json = JSON.stringify(result);
    expect(json).not.toContain('piece_id');
    expect(json).not.toContain('data_set_id');
  });

  it('failure entries DROP rawStorageMetadata (missing-provider path)', async () => {
    // The unregistered-provider branch builds the failure record
    // before any adapter call — verify that branch also drops the
    // hint.
    const reg = singleStoreRegistry(makeStore('local_fs', 'delete'));
    const sidecar = {
      filecoin: { data_set_id: '42', copies: [{ data_set_id: '42', piece_id: '7' }] },
    };
    const result = await cleanupManagedBlobs(reg, [
      {
        rawDocumentId: 'doc-missing-provider',
        storageProvider: 'filecoin',
        storageUri: 'filecoin://piece/baga-missing',
        rawStorageMetadata: sidecar,
      },
    ]);
    expect(result.failures).toHaveLength(1);
    const entry = result.failures[0] as unknown as Record<string, unknown>;
    expect(entry).not.toHaveProperty('rawStorageMetadata');
    const json = JSON.stringify(result);
    expect(json).not.toContain('piece_id');
    expect(json).not.toContain('data_set_id');
  });

  it('reports each blob in a mixed batch independently', async () => {
    const reg = buildStoreRegistry(makeStore('filecoin', 'tombstone'), [
      makeStore('local_fs', 'delete', {
        delete: async () => ({ deleted: true, semantics: 'deleted' }),
      }),
    ]);
    const result = await cleanupManagedBlobs(reg, [
      { rawDocumentId: 'doc-test', storageProvider: 'local_fs', storageUri: 'local-fs://present', rawStorageMetadata: {} },     // success deleted
      { rawDocumentId: 'doc-test', storageProvider: 'filecoin', storageUri: 'ipfs://x', rawStorageMetadata: {} },                 // success tombstoned
      { rawDocumentId: 'doc-test', storageProvider: 'unknown', storageUri: 'unknown://orphan', rawStorageMetadata: {} },          // failure missing-provider
    ]);
    expect(result.successes).toHaveLength(2);
    expect(result.successes.map((s) => s.semantics).sort()).toEqual(['deleted', 'tombstoned']);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].storageProvider).toBe('unknown');
  });
});
