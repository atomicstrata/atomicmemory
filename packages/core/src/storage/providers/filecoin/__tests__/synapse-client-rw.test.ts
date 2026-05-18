/**
 * @file Unit tests for `SynapseFilecoinProviderClient` read-path
 * methods `get`, `head`, and `verify`. The `delete` suite lives
 * in `synapse-client-delete.test.ts`; the shared in-process
 * fakes/constants live in `synapse-client-rw-fixtures.ts`. The
 * split keeps each file under the workspace 400-LOC cap.
 *
 * Tests run against an in-process fake `SynapseLike` and
 * `SynapseContextLike` so the real SDK is never invoked. The live
 * calibration smoke test lives elsewhere (gated by
 * `FILECOIN_LIVE_TESTS=1`).
 */

import { describe, expect, it, vi } from 'vitest';
import { SynapseFilecoinProviderClient } from '../synapse-client.js';
import { FilecoinProviderError } from '../errors.js';
import {
  buildFakeContext,
  buildFakeSynapse,
  fakePieceStatus,
  HELLO,
  HELLO_HASH,
  PIECE_CID,
  PIECE_URI,
} from './synapse-client-rw-fixtures.js';

describe('SynapseFilecoinProviderClient.get', () => {
  it('downloads the bytes and wraps them in a Buffer', async () => {
    const { synapse, downloadSpy } = buildFakeSynapse({
      download: { bytes: new Uint8Array(HELLO) },
    });
    const client = new SynapseFilecoinProviderClient(synapse);
    const out = await client.get({ storageUri: PIECE_URI });
    expect(out.body.equals(HELLO)).toBe(true);
    expect(downloadSpy).toHaveBeenCalledWith(
      expect.objectContaining({ pieceCid: PIECE_CID }),
    );
    expect(out.providerMetadata).toEqual({ piece_cid: PIECE_CID });
  });

  it('threads withCDN through from operator config', async () => {
    const { synapse, downloadSpy } = buildFakeSynapse({
      download: { bytes: new Uint8Array(HELLO) },
    });
    const client = new SynapseFilecoinProviderClient(synapse, { withCdn: true });
    await client.get({ storageUri: PIECE_URI });
    expect(downloadSpy).toHaveBeenCalledWith(
      expect.objectContaining({ pieceCid: PIECE_CID, withCDN: true }),
    );
  });

  it('rejects a malformed storage URI before any SDK call', async () => {
    const { synapse, downloadSpy } = buildFakeSynapse({});
    const client = new SynapseFilecoinProviderClient(synapse);
    await expect(client.get({ storageUri: 'ipfs://legacy' })).rejects.toBeInstanceOf(
      FilecoinProviderError,
    );
    expect(downloadSpy).not.toHaveBeenCalled();
  });

  it('sanitizes vendor errors into FilecoinProviderError', async () => {
    const { synapse } = buildFakeSynapse({
      download: { error: new Error('PullError: 10.0.0.1 connection reset') },
    });
    const client = new SynapseFilecoinProviderClient(synapse);
    let caught: unknown;
    try {
      await client.get({ storageUri: PIECE_URI });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(FilecoinProviderError);
    expect((caught as FilecoinProviderError).errorCode).toBe('filecoin_download_failed');
    expect((caught as Error).message).not.toContain('10.0.0.1');
  });

  it('honors timeoutMs and surfaces filecoin_download_timeout (deterministic via fake timers)', async () => {
    vi.useFakeTimers();
    try {
      const { synapse } = buildFakeSynapse({});
      // Replace download with a promise that only resolves via the
      // signal — no wall-clock dependency.
      (synapse.storage.download as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        (opts: { signal?: AbortSignal }) =>
          new Promise<never>((_resolve, reject) => {
            opts.signal?.addEventListener('abort', () =>
              reject(opts.signal!.reason ?? new Error('aborted')),
            );
          }),
      );
      const client = new SynapseFilecoinProviderClient(synapse);
      const pending = client.get({ storageUri: PIECE_URI, timeoutMs: 5 });
      // Attach a no-op rejection handler so the microtask race
      // between the fake-timer abort and `expect.rejects` doesn't
      // fire a transient unhandled-rejection warning.
      pending.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(5);
      await expect(pending).rejects.toMatchObject({
        errorCode: 'filecoin_download_timeout',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses operator-config retrievalTimeoutMs when input.timeoutMs is not supplied', async () => {
    vi.useFakeTimers();
    try {
      const { synapse } = buildFakeSynapse({});
      (synapse.storage.download as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        (opts: { signal?: AbortSignal }) =>
          new Promise<never>((_resolve, reject) => {
            opts.signal?.addEventListener('abort', () =>
              reject(opts.signal!.reason ?? new Error('aborted')),
            );
          }),
      );
      const client = new SynapseFilecoinProviderClient(synapse, { retrievalTimeoutMs: 9 });
      const pending = client.get({ storageUri: PIECE_URI });
      pending.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(9);
      await expect(pending).rejects.toMatchObject({
        errorCode: 'filecoin_download_timeout',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('input.timeoutMs overrides operator-config retrievalTimeoutMs', async () => {
    vi.useFakeTimers();
    try {
      const { synapse } = buildFakeSynapse({});
      (synapse.storage.download as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        (opts: { signal?: AbortSignal }) =>
          new Promise<never>((_resolve, reject) => {
            opts.signal?.addEventListener('abort', () =>
              reject(opts.signal!.reason ?? new Error('aborted')),
            );
          }),
      );
      const client = new SynapseFilecoinProviderClient(synapse, { retrievalTimeoutMs: 1000 });
      const pending = client.get({ storageUri: PIECE_URI, timeoutMs: 4 });
      pending.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(4);
      await expect(pending).rejects.toMatchObject({
        errorCode: 'filecoin_download_timeout',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('when neither input.timeoutMs nor retrievalTimeoutMs is set, no AbortController is created', async () => {
    const { synapse, downloadSpy } = buildFakeSynapse({
      download: { bytes: new Uint8Array(0) },
    });
    const client = new SynapseFilecoinProviderClient(synapse);
    await client.get({ storageUri: PIECE_URI });
    const opts = downloadSpy.mock.calls[0]![0] as { signal?: AbortSignal };
    expect(opts.signal).toBeUndefined();
  });
});

describe('SynapseFilecoinProviderClient.head', () => {
  it('uses the dataSetId hint when provided and short-circuits the scan', async () => {
    const ctx = buildFakeContext({ dataSetId: 42n, pieceStatus: fakePieceStatus() });
    const { synapse, createContextSpy } = buildFakeSynapse({
      contexts: new Map([[42n, ctx]]),
    });
    const client = new SynapseFilecoinProviderClient(synapse);
    const out = await client.head({ storageUri: PIECE_URI, dataSetId: '42' });
    expect(out.exists).toBe(true);
    expect(out.proven).toBe(true);
    expect(createContextSpy).toHaveBeenCalledTimes(1);
    expect(createContextSpy).toHaveBeenCalledWith({ dataSetId: 42n });
    expect(synapse.storage.findDataSets).not.toHaveBeenCalled();
  });

  it('scans findDataSets when no hint is provided and returns the first match', async () => {
    const ctxMiss = buildFakeContext({ dataSetId: 1n, pieceStatus: null });
    const ctxHit = buildFakeContext({ dataSetId: 2n, pieceStatus: fakePieceStatus() });
    const { synapse } = buildFakeSynapse({
      dataSets: [
        { dataSetId: 1n, providerId: 10n, isLive: true },
        { dataSetId: 2n, providerId: 20n, isLive: true },
      ],
      contexts: new Map([[1n, ctxMiss], [2n, ctxHit]]),
    });
    const client = new SynapseFilecoinProviderClient(synapse);
    const out = await client.head({ storageUri: PIECE_URI });
    expect(out.exists).toBe(true);
    expect(out.proven).toBe(true);
  });

  it('skips non-live data sets during the scan', async () => {
    const ctxLive = buildFakeContext({ dataSetId: 2n, pieceStatus: fakePieceStatus() });
    const ctxDead = buildFakeContext({ dataSetId: 1n, pieceStatus: fakePieceStatus() });
    const { synapse, createContextSpy } = buildFakeSynapse({
      dataSets: [
        { dataSetId: 1n, providerId: 10n, isLive: false },
        { dataSetId: 2n, providerId: 20n, isLive: true },
      ],
      contexts: new Map([[1n, ctxDead], [2n, ctxLive]]),
    });
    const client = new SynapseFilecoinProviderClient(synapse);
    const out = await client.head({ storageUri: PIECE_URI });
    expect(out.exists).toBe(true);
    // Dead data set was skipped; createContext was only called once for the live one.
    expect(createContextSpy).toHaveBeenCalledTimes(1);
    expect(createContextSpy).toHaveBeenCalledWith({ dataSetId: 2n });
  });

  it('returns exists=false when no data set holds the piece', async () => {
    const { synapse } = buildFakeSynapse({
      dataSets: [],
    });
    const client = new SynapseFilecoinProviderClient(synapse);
    const out = await client.head({ storageUri: PIECE_URI });
    expect(out.exists).toBe(false);
    expect(out.proven).toBe(false);
    expect(out.providerMetadata).toEqual({ piece_cid: PIECE_CID });
  });

  it('reports proven=false when the SDK has not yet recorded a proof', async () => {
    const ctx = buildFakeContext({
      dataSetId: 42n,
      pieceStatus: fakePieceStatus({ dataSetLastProven: null }),
    });
    const { synapse } = buildFakeSynapse({ contexts: new Map([[42n, ctx]]) });
    const client = new SynapseFilecoinProviderClient(synapse);
    const out = await client.head({ storageUri: PIECE_URI, dataSetId: '42' });
    expect(out.exists).toBe(true);
    expect(out.proven).toBe(false);
  });

  it('NEVER leaks PieceStatus.retrievalUrl into providerMetadata (CDN/SSRF rule)', async () => {
    const ctx = buildFakeContext({
      dataSetId: 42n,
      pieceStatus: fakePieceStatus({
        retrievalUrl: 'https://internal-sp-host.invalid/ipfs/baga-secret',
      }),
    });
    const { synapse } = buildFakeSynapse({ contexts: new Map([[42n, ctx]]) });
    const client = new SynapseFilecoinProviderClient(synapse);
    const out = await client.head({ storageUri: PIECE_URI, dataSetId: '42' });
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('internal-sp-host');
    expect(serialized).not.toContain('retrievalUrl');
    expect(serialized).not.toContain('retrieval_url');
    expect(out.providerMetadata).not.toHaveProperty('retrieval_url');
    expect(out.providerMetadata).not.toHaveProperty('retrievalUrl');
  });

  it('sanitizes vendor errors raised inside the scan', async () => {
    const ctx = buildFakeContext({ dataSetId: 42n, statusError: new Error('rpc 500') });
    const { synapse } = buildFakeSynapse({ contexts: new Map([[42n, ctx]]) });
    const client = new SynapseFilecoinProviderClient(synapse);
    let caught: unknown;
    try {
      await client.head({ storageUri: PIECE_URI, dataSetId: '42' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(FilecoinProviderError);
    expect((caught as FilecoinProviderError).errorCode).toBe('filecoin_head_failed');
  });

  it('rejects an invalid dataSetId hint with filecoin_invalid_data_set_id', async () => {
    const { synapse } = buildFakeSynapse({});
    const client = new SynapseFilecoinProviderClient(synapse);
    let caught: unknown;
    try {
      await client.head({ storageUri: PIECE_URI, dataSetId: 'not-a-number' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(FilecoinProviderError);
    expect((caught as FilecoinProviderError).errorCode).toBe('filecoin_invalid_data_set_id');
  });
});

describe('SynapseFilecoinProviderClient.verify', () => {
  it('returns verified=true on hash match', async () => {
    const { synapse } = buildFakeSynapse({ download: { bytes: new Uint8Array(HELLO) } });
    const client = new SynapseFilecoinProviderClient(synapse);
    const out = await client.verify({ storageUri: PIECE_URI, expectedContentHash: HELLO_HASH });
    expect(out).toEqual({ verified: true });
  });

  it('returns verified=false reason=content_hash_mismatch when bytes differ', async () => {
    const { synapse } = buildFakeSynapse({ download: { bytes: new Uint8Array(HELLO) } });
    const client = new SynapseFilecoinProviderClient(synapse);
    const out = await client.verify({
      storageUri: PIECE_URI,
      expectedContentHash: 'f'.repeat(64),
    });
    expect(out).toEqual({ verified: false, reason: 'content_hash_mismatch' });
  });

  it('returns verified=false reason=<download error> when retrieval fails', async () => {
    const { synapse } = buildFakeSynapse({
      download: { error: new Error('PullError') },
    });
    const client = new SynapseFilecoinProviderClient(synapse);
    const out = await client.verify({ storageUri: PIECE_URI, expectedContentHash: HELLO_HASH });
    expect(out.verified).toBe(false);
    expect(out.reason).toBe('filecoin_download_failed');
  });
});
