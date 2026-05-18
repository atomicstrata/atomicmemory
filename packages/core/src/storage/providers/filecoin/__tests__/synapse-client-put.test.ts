/**
 * @file Unit tests for `SynapseFilecoinProviderClient.put`.
 *
 * Tests run against an in-process fake Synapse handle that
 * implements the narrow `SynapseLike` interface
 * `SynapseFilecoinProviderClient` consumes. The real SDK is never
 * invoked; tests are deterministic and require no network or
 * credentials. The live calibration smoke test lives elsewhere
 * (gated by `FILECOIN_LIVE_TESTS=1`).
 */

import { describe, expect, it, vi } from 'vitest';
import type { UploadResult } from '@filoz/synapse-sdk';
import {
  SynapseFilecoinProviderClient,
  type SynapseLike,
  type SynapseUploadOptionsLike,
} from '../synapse-client.js';
import { FilecoinProviderError } from '../errors.js';
import { PIECE_CID, PIECE_URI } from './synapse-client-rw-fixtures.js';

interface FakeSynapseSetup {
  readonly resolve?: UploadResult;
  readonly reject?: unknown;
  readonly delayMs?: number;
}

function fakeUploadResult(overrides: Partial<UploadResult> = {}): UploadResult {
  const pieceCid = overrides.pieceCid ?? makePieceCidLike(PIECE_CID);
  return {
    pieceCid,
    size: 1024,
    requestedCopies: 2,
    complete: true,
    copies: [
      {
        providerId: 1n,
        dataSetId: 42n,
        pieceId: 7n,
        role: 'primary',
        retrievalUrl: 'https://example/internal-not-exposed',
        isNewDataSet: false,
      },
      {
        providerId: 2n,
        dataSetId: 42n,
        pieceId: 7n,
        role: 'secondary',
        retrievalUrl: 'https://example/internal-not-exposed',
        isNewDataSet: false,
      },
    ],
    failedAttempts: [],
    ...overrides,
  } as UploadResult;
}

function makePieceCidLike(text: string): UploadResult['pieceCid'] {
  // The runtime PieceCID is a `multiformats` Link, but the
  // boundary only calls `.toString()`. A minimal object satisfies
  // that surface.
  return { toString: () => text } as unknown as UploadResult['pieceCid'];
}

function buildFakeSynapse(setup: FakeSynapseSetup): {
  readonly synapse: SynapseLike;
  readonly uploadSpy: ReturnType<typeof vi.fn>;
} {
  const uploadSpy = vi.fn(async (
    _data: Uint8Array,
    _opts?: SynapseUploadOptionsLike,
  ): Promise<UploadResult> => {
    if (setup.delayMs) await new Promise((r) => setTimeout(r, setup.delayMs));
    if (setup.reject !== undefined) throw setup.reject;
    return setup.resolve!;
  });
  // The put-path tests do not exercise download / findDataSets /
  // createContext; stubs that throw on access keep the boundary
  // narrow without growing this fixture.
  const notUsed = async (): Promise<never> => {
    throw new Error('not used in put-path tests');
  };
  const synapse: SynapseLike = {
    storage: {
      upload: uploadSpy,
      download: notUsed as unknown as SynapseLike['storage']['download'],
      findDataSets: notUsed as unknown as SynapseLike['storage']['findDataSets'],
      createContext: notUsed as unknown as SynapseLike['storage']['createContext'],
      getStorageInfo: notUsed as unknown as SynapseLike['storage']['getStorageInfo'],
      getUploadCosts: notUsed as unknown as SynapseLike['storage']['getUploadCosts'],
    },
    chain: { id: 314159 },
    client: { getChainId: async () => 314159 },
  };
  return { synapse, uploadSpy };
}

describe('SynapseFilecoinProviderClient.put — happy path', () => {
  it('maps UploadResult onto FilecoinPutResult with the canonical URI', async () => {
    const { synapse } = buildFakeSynapse({ resolve: fakeUploadResult() });
    const client = new SynapseFilecoinProviderClient(synapse);
    const result = await client.put({
      key: 's/abc/doc/01.bin',
      body: Buffer.from('hello world'),
      contentType: 'text/plain',
    });
    expect(result.pieceCid).toBe(PIECE_CID);
    expect(result.storageUri).toBe(PIECE_URI);
    expect(result.sizeBytes).toBe(1024);
    expect(result.complete).toBe(true);
    expect(result.requestedCopies).toBe(2);
  });

  it('stringifies bigint providerId/dataSetId/pieceId into copies[]', async () => {
    const { synapse } = buildFakeSynapse({ resolve: fakeUploadResult() });
    const client = new SynapseFilecoinProviderClient(synapse);
    const { copies } = await client.put({ key: 'k', body: Buffer.from('x') });
    expect(copies).toEqual([
      { providerId: '1', dataSetId: '42', pieceId: '7', role: 'primary' },
      { providerId: '2', dataSetId: '42', pieceId: '7', role: 'secondary' },
    ]);
    expect(JSON.stringify(copies)).not.toContain('internal-not-exposed');
  });

  it('threads operator-config options (copies, providerIds, dataSetMetadata)', async () => {
    const { synapse, uploadSpy } = buildFakeSynapse({ resolve: fakeUploadResult() });
    const client = new SynapseFilecoinProviderClient(synapse, {
      copies: 3,
      providerIds: ['1', '2', '3'],
      dataSetMetadata: { tenant: 'acme' },
    });
    await client.put({ key: 'k', body: Buffer.from('x') });
    const opts = uploadSpy.mock.calls[0]![1] as SynapseUploadOptionsLike;
    expect(opts.copies).toBe(3);
    expect(opts.providerIds).toEqual([1n, 2n, 3n]);
    expect(opts.metadata).toEqual({ tenant: 'acme' });
  });

  it('passes per-input pieceMetadata through to Synapse', async () => {
    const { synapse, uploadSpy } = buildFakeSynapse({ resolve: fakeUploadResult() });
    const client = new SynapseFilecoinProviderClient(synapse);
    await client.put({
      key: 'k',
      body: Buffer.from('x'),
      pieceMetadata: { artifact_id: 'a-1', content_type: 'text/plain' },
    });
    const opts = uploadSpy.mock.calls[0]![1] as SynapseUploadOptionsLike;
    expect(opts.pieceMetadata).toEqual({ artifact_id: 'a-1', content_type: 'text/plain' });
  });
});

describe('SynapseFilecoinProviderClient.put — partial / failure paths', () => {
  it('surfaces partial-success uploads (complete=false + failedAttempts)', async () => {
    const partial = fakeUploadResult({
      complete: false,
      copies: [
        {
          providerId: 1n,
          dataSetId: 42n,
          pieceId: 7n,
          role: 'primary',
          retrievalUrl: 'https://example/x',
          isNewDataSet: false,
        },
      ],
      failedAttempts: [
        { providerId: 2n, role: 'secondary', error: 'pull timeout', explicit: false },
      ],
    });
    const { synapse } = buildFakeSynapse({ resolve: partial });
    const client = new SynapseFilecoinProviderClient(synapse);
    const result = await client.put({ key: 'k', body: Buffer.from('x') });
    expect(result.complete).toBe(false);
    expect(result.copies).toHaveLength(1);
    expect(result.failedAttempts).toEqual([
      { providerId: '2', role: 'secondary', errorCode: 'filecoin_copy_failed', explicit: false },
    ]);
    // Raw vendor message MUST NOT cross the boundary.
    expect(JSON.stringify(result)).not.toContain('pull timeout');
  });

  it('wraps SDK rejection in FilecoinProviderError with a sanitized code', async () => {
    const { synapse } = buildFakeSynapse({
      reject: new Error('PullError: provider unreachable at 12.34.56.78:443'),
    });
    const client = new SynapseFilecoinProviderClient(synapse);
    let caught: unknown;
    try {
      await client.put({ key: 'k', body: Buffer.from('x') });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(FilecoinProviderError);
    const err = caught as FilecoinProviderError;
    expect(err.errorCode).toBe('filecoin_upload_failed');
    expect(err.message).not.toContain('12.34.56.78');
    expect(err.message).not.toContain('provider unreachable');
  });

  it('honors timeoutMs and surfaces filecoin_upload_timeout (deterministic via fake timers)', async () => {
    vi.useFakeTimers();
    try {
      const { synapse } = buildFakeSynapse({ resolve: fakeUploadResult() });
      // Replace upload with a promise that only resolves via the
      // signal — no wall-clock dependency.
      (synapse.storage.upload as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        (_data: Uint8Array, opts?: SynapseUploadOptionsLike) =>
          new Promise<never>((_resolve, reject) => {
            opts?.signal?.addEventListener('abort', () =>
              reject(opts.signal!.reason ?? new Error('aborted')),
            );
          }),
      );
      const client = new SynapseFilecoinProviderClient(synapse);
      const pending = client.put({ key: 'k', body: Buffer.from('x'), timeoutMs: 5 });
      // Attach a no-op rejection handler so the microtask race
      // between the fake-timer abort and the test's `expect.rejects`
      // doesn't fire a transient unhandled-rejection warning.
      pending.catch(() => undefined);
      // Drive virtual clock past the timeout boundary; no real delay.
      await vi.advanceTimersByTimeAsync(5);
      await expect(pending).rejects.toMatchObject({
        errorCode: 'filecoin_upload_timeout',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses operator-config uploadTimeoutMs when input.timeoutMs is not supplied", async () => {
    vi.useFakeTimers();
    try {
      const { synapse } = buildFakeSynapse({ resolve: fakeUploadResult() });
      (synapse.storage.upload as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        (_data: Uint8Array, opts?: SynapseUploadOptionsLike) =>
          new Promise<never>((_resolve, reject) => {
            opts?.signal?.addEventListener('abort', () =>
              reject(opts.signal!.reason ?? new Error('aborted')),
            );
          }),
      );
      const client = new SynapseFilecoinProviderClient(synapse, { uploadTimeoutMs: 7 });
      const pending = client.put({ key: 'k', body: Buffer.from('x') });
      pending.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(7);
      await expect(pending).rejects.toMatchObject({
        errorCode: 'filecoin_upload_timeout',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("input.timeoutMs overrides operator-config uploadTimeoutMs", async () => {
    vi.useFakeTimers();
    try {
      const { synapse } = buildFakeSynapse({ resolve: fakeUploadResult() });
      (synapse.storage.upload as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        (_data: Uint8Array, opts?: SynapseUploadOptionsLike) =>
          new Promise<never>((_resolve, reject) => {
            opts?.signal?.addEventListener('abort', () =>
              reject(opts.signal!.reason ?? new Error('aborted')),
            );
          }),
      );
      // Operator-default is 1000ms; per-call override is 5ms. The
      // shorter per-call value should win.
      const client = new SynapseFilecoinProviderClient(synapse, { uploadTimeoutMs: 1000 });
      const pending = client.put({ key: 'k', body: Buffer.from('x'), timeoutMs: 5 });
      pending.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(5);
      await expect(pending).rejects.toMatchObject({
        errorCode: 'filecoin_upload_timeout',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("when both input.timeoutMs and uploadTimeoutMs are unset, no AbortController is created", async () => {
    const { synapse, uploadSpy } = buildFakeSynapse({ resolve: fakeUploadResult() });
    const client = new SynapseFilecoinProviderClient(synapse);
    await client.put({ key: 'k', body: Buffer.from('x') });
    const opts = uploadSpy.mock.calls[0]![1] as SynapseUploadOptionsLike | undefined;
    expect(opts?.signal).toBeUndefined();
  });
});

describe('SynapseFilecoinProviderClient — interface identity', () => {
  it('advertises provider=filecoin / driver=synapse', () => {
    const { synapse } = buildFakeSynapse({ resolve: fakeUploadResult() });
    const client = new SynapseFilecoinProviderClient(synapse);
    expect(client.provider).toBe('filecoin');
    expect(client.driver).toBe('synapse');
  });
});
