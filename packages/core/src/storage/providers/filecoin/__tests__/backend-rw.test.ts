/**
 * @file Tests for `FilecoinRawContentStore` read-path methods —
 * `get`, `head`, `delete` — against a hand-rolled
 * `FilecoinProviderClient` fake. Exercises the adapter
 * translation between `RawContentStore` (generic) and the
 * provider boundary.
 */

import { describe, expect, it } from 'vitest';
import { FilecoinRawContentStore } from '../backend.js';
import {
  buildFakeFilecoinProviderClient,
  type FakeProviderClientBehavior,
} from './provider-client-fixtures.js';

function buildFakeClient(behavior: FakeProviderClientBehavior = {}): ReturnType<
  typeof buildFakeFilecoinProviderClient
> {
  return buildFakeFilecoinProviderClient(behavior);
}

const PIECE_URI = 'filecoin://piece/baga-test';

describe('FilecoinRawContentStore — capabilities (post head/get wiring)', () => {
  it("advertises supportsHead=true and supportsGet=true now that they're implemented", () => {
    const { client } = buildFakeClient({});
    const store = new FilecoinRawContentStore(client);
    expect(store.capabilities.supportsHead).toBe(true);
    expect(store.capabilities.supportsGet).toBe(true);
    expect(store.capabilities.retrievalConsistency).toBe('eventual');
    expect(store.capabilities.deleteSemantics).toBe('tombstone');
  });
});

describe('FilecoinRawContentStore.get', () => {
  it('forwards storageUri and returns body + RawContentMetadata shape', async () => {
    const { client, getSpy } = buildFakeClient({
      get: { body: Buffer.from('payload'), providerMetadata: { piece_cid: 'baga-test' } },
    });
    const store = new FilecoinRawContentStore(client);
    const out = await store.get(PIECE_URI);
    expect(getSpy).toHaveBeenCalledWith({ storageUri: PIECE_URI });
    expect(out.body.toString('utf8')).toBe('payload');
    expect(out.metadata.contentLength).toBe('payload'.length);
    expect(out.metadata.providerMetadata).toEqual({ piece_cid: 'baga-test' });
  });
});

describe('FilecoinRawContentStore.head — proof-gated promotion', () => {
  it('returns exists=true ONLY when both exists AND proven are true', async () => {
    const { client } = buildFakeClient({
      head: {
        exists: true,
        proven: true,
        providerMetadata: { piece_cid: 'baga-test', data_set_last_proven_at: '2026-05-13T00:00:00.000Z' },
      },
    });
    const store = new FilecoinRawContentStore(client);
    const out = await store.head(PIECE_URI);
    expect(out.exists).toBe(true);
    expect(out.metadata?.providerMetadata).toEqual({
      piece_cid: 'baga-test',
      data_set_last_proven_at: '2026-05-13T00:00:00.000Z',
    });
  });

  // Shared driver for the "head collapses to exists=false" cases
  // — both unproven (exists=true + proven=false) and missing
  // (exists=false + proven=false) map to the same generic
  // `RawContentHeadResult { exists: false, metadata: null }`.
  async function expectHeadCollapsesToExistsFalse(
    headBehavior: { exists: boolean; proven: boolean },
  ): Promise<{ readonly failure?: unknown }> {
    const { client } = buildFakeClient({
      head: { ...headBehavior, providerMetadata: { piece_cid: 'baga-test' } },
    });
    const store = new FilecoinRawContentStore(client);
    const out = await store.head(PIECE_URI);
    expect(out.exists).toBe(false);
    expect(out.metadata).toBeNull();
    return out as { readonly failure?: unknown };
  }

  it("does NOT promote: exists=true but proven=false maps to RawContentHeadResult exists=false (still pending)", async () => {
    // The reconciler treats `RawContentHeadResult.exists=true` as
    // "promote blob_pending → blob_available". For Filecoin we MUST
    // NOT promote a piece whose PDP proof hasn't landed yet, even
    // if the SDK has recorded the SP store.
    const out = await expectHeadCollapsesToExistsFalse({ exists: true, proven: false });
    // Crucially: NO `failure` field is set. The reconciler
    // distinguishes `failure` (terminal, → blob_archival_failed)
    // from a plain exists=false (transient, stays blob_pending).
    expect(out.failure).toBeUndefined();
  });

  it('returns exists=false metadata=null when the piece is not found', async () => {
    await expectHeadCollapsesToExistsFalse({ exists: false, proven: false });
  });
});

describe('FilecoinRawContentStore.head + delete — data_set_id hint plumbing', () => {
  const VALID_HINT = { filecoin: { data_set_id: '42' } };
  const MALFORMED_HINT = { filecoin: { data_set_id: '0xff' } };

  it('head: valid sidecar hint forwards dataSetId to the provider client', async () => {
    const { client, headSpy } = buildFakeClient({
      head: { exists: true, proven: true, providerMetadata: { piece_cid: 'baga-test' } },
    });
    const store = new FilecoinRawContentStore(client);
    await store.head(PIECE_URI, VALID_HINT);
    expect(headSpy).toHaveBeenCalledWith({ storageUri: PIECE_URI, dataSetId: '42' });
  });

  it('head: missing sidecar omits dataSetId (provider client falls back to scan)', async () => {
    const { client, headSpy } = buildFakeClient({
      head: { exists: true, proven: true, providerMetadata: { piece_cid: 'baga-test' } },
    });
    const store = new FilecoinRawContentStore(client);
    await store.head(PIECE_URI);
    expect(headSpy).toHaveBeenCalledWith({ storageUri: PIECE_URI });
    expect(headSpy.mock.calls[0]?.[0]).not.toHaveProperty('dataSetId');
  });

  it('head: malformed sidecar treated as absent (no dataSetId forwarded, no throw)', async () => {
    const { client, headSpy } = buildFakeClient({
      head: { exists: true, proven: true, providerMetadata: { piece_cid: 'baga-test' } },
    });
    const store = new FilecoinRawContentStore(client);
    await expect(store.head(PIECE_URI, MALFORMED_HINT)).resolves.toBeDefined();
    expect(headSpy).toHaveBeenCalledWith({ storageUri: PIECE_URI });
    expect(headSpy.mock.calls[0]?.[0]).not.toHaveProperty('dataSetId');
  });

  it('delete: data_set_id-only hint forwards dataSetId; no pieceId field set', async () => {
    const { client, deleteSpy } = buildFakeClient({
      delete: { deleted: true, semantics: 'tombstone' },
    });
    const store = new FilecoinRawContentStore(client);
    await store.delete(PIECE_URI, VALID_HINT);
    expect(deleteSpy).toHaveBeenCalledWith({ storageUri: PIECE_URI, dataSetId: '42' });
    expect(deleteSpy.mock.calls[0]?.[0]).not.toHaveProperty('pieceId');
  });

  it('delete: full sidecar with matching copies[] forwards BOTH dataSetId and pieceId', async () => {
    const { client, deleteSpy } = buildFakeClient({
      delete: { deleted: true, semantics: 'tombstone' },
    });
    const store = new FilecoinRawContentStore(client);
    const hints = {
      filecoin: {
        data_set_id: '42',
        copies: [{ data_set_id: '42', piece_id: '7', provider_id: '1' }],
      },
    };
    await store.delete(PIECE_URI, hints);
    expect(deleteSpy).toHaveBeenCalledWith({
      storageUri: PIECE_URI,
      dataSetId: '42',
      pieceId: '7',
    });
  });

  it('delete: malformed piece_id is dropped; dataSetId still forwards', async () => {
    const { client, deleteSpy } = buildFakeClient({
      delete: { deleted: true, semantics: 'tombstone' },
    });
    const store = new FilecoinRawContentStore(client);
    const hints = {
      filecoin: {
        data_set_id: '42',
        copies: [{ data_set_id: '42', piece_id: '0xff' }],
      },
    };
    await store.delete(PIECE_URI, hints);
    expect(deleteSpy).toHaveBeenCalledWith({ storageUri: PIECE_URI, dataSetId: '42' });
    expect(deleteSpy.mock.calls[0]?.[0]).not.toHaveProperty('pieceId');
  });
});

describe('FilecoinRawContentStore.delete', () => {
  it('maps tombstone deletion onto the generic delete result', async () => {
    const { client, deleteSpy } = buildFakeClient({
      delete: { deleted: true, semantics: 'tombstone', txHash: '0xabc' },
    });
    const store = new FilecoinRawContentStore(client);
    const out = await store.delete(PIECE_URI);
    expect(deleteSpy).toHaveBeenCalledWith({ storageUri: PIECE_URI });
    expect(out.deleted).toBe(true);
    expect(out.semantics).toBe('tombstoned');
  });

  it('idempotent: deleted=false still maps to tombstoned semantics on the generic surface', async () => {
    const { client } = buildFakeClient({
      delete: { deleted: false, semantics: 'tombstone' },
    });
    const store = new FilecoinRawContentStore(client);
    const out = await store.delete(PIECE_URI);
    expect(out.deleted).toBe(false);
    expect(out.semantics).toBe('tombstoned');
  });
});
