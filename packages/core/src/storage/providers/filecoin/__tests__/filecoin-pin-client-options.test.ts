/**
 * @file Tests for `FilecoinPinFilecoinProviderClient.put`'s
 * option wiring — the boundary properties the reviewer called
 * out:
 *
 *   - upload-timeout / per-call `timeoutMs` → `AbortSignal`
 *     threaded into `executeUpload`. A stuck SP must be
 *     cancellable; a timeout surfaces as
 *     `FilecoinProviderError('filecoin_pin_upload_timeout', …)`.
 *
 *   - `input.pieceMetadata` (sanitized per-piece allowlist from
 *     `metadata.ts:buildFilecoinMetadata`) → `executeUpload`'s
 *     `pieceMetadata` option. The AtomicMemory metadata contract
 *     must hold for both drivers — silently dropping the field
 *     would be a regression.
 */

import { describe, expect, it, vi } from 'vitest';
import { FilecoinPinFilecoinProviderClient } from '../filecoin-pin-client.js';
import { FilecoinProviderError } from '../errors.js';
import { fakeDelegate, fakeSynapse, uploadResultFixture } from './filecoin-pin-test-fixtures.js';

const mockExecuteUpload = vi.fn();
vi.mock('filecoin-pin/core/upload', () => ({
  executeUpload: (...args: unknown[]) => mockExecuteUpload(...args),
}));

const HELLO = Buffer.from('phase-5 option wiring');

describe('FilecoinPinFilecoinProviderClient.put — pieceMetadata wiring', () => {
  it('threads sanitized input.pieceMetadata through to executeUpload.pieceMetadata', async () => {
    mockExecuteUpload.mockReset();
    mockExecuteUpload.mockResolvedValueOnce(uploadResultFixture());
    const client = new FilecoinPinFilecoinProviderClient(fakeSynapse, fakeDelegate);
    await client.put({
      key: 'k', body: HELLO,
      pieceMetadata: { artifact_id: 'doc-1', codec_name: 'aes_gcm' },
    });
    const [, , , options] = mockExecuteUpload.mock.calls[0]!;
    const opts = options as Record<string, unknown>;
    expect(opts.pieceMetadata).toEqual({ artifact_id: 'doc-1', codec_name: 'aes_gcm' });
  });

  it('omits the pieceMetadata key entirely when the input does not supply one', async () => {
    mockExecuteUpload.mockReset();
    mockExecuteUpload.mockResolvedValueOnce(uploadResultFixture());
    const client = new FilecoinPinFilecoinProviderClient(fakeSynapse, fakeDelegate);
    await client.put({ key: 'k', body: HELLO });
    const [, , , options] = mockExecuteUpload.mock.calls[0]!;
    expect('pieceMetadata' in (options as Record<string, unknown>)).toBe(false);
  });
});

describe('FilecoinPinFilecoinProviderClient.put — timeout wiring', () => {
  it('threads an AbortSignal to executeUpload when input.timeoutMs is set', async () => {
    mockExecuteUpload.mockReset();
    mockExecuteUpload.mockResolvedValueOnce(uploadResultFixture());
    const client = new FilecoinPinFilecoinProviderClient(fakeSynapse, fakeDelegate);
    await client.put({ key: 'k', body: HELLO, timeoutMs: 5000 });
    const [, , , options] = mockExecuteUpload.mock.calls[0]!;
    const signal = (options as { signal?: AbortSignal }).signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal!.aborted).toBe(false);
  });

  it('falls back to the client-level uploadTimeoutMs when input.timeoutMs is absent', async () => {
    mockExecuteUpload.mockReset();
    mockExecuteUpload.mockResolvedValueOnce(uploadResultFixture());
    const client = new FilecoinPinFilecoinProviderClient(fakeSynapse, fakeDelegate, {
      uploadTimeoutMs: 7000,
    });
    await client.put({ key: 'k', body: HELLO });
    const [, , , options] = mockExecuteUpload.mock.calls[0]!;
    expect((options as { signal?: AbortSignal }).signal).toBeInstanceOf(AbortSignal);
  });

  it('omits the signal entirely when no timeout is configured (cannot cancel)', async () => {
    mockExecuteUpload.mockReset();
    mockExecuteUpload.mockResolvedValueOnce(uploadResultFixture());
    const client = new FilecoinPinFilecoinProviderClient(fakeSynapse, fakeDelegate);
    await client.put({ key: 'k', body: HELLO });
    const [, , , options] = mockExecuteUpload.mock.calls[0]!;
    expect('signal' in (options as Record<string, unknown>)).toBe(false);
  });

  it('rejects with filecoin_pin_upload_timeout (deterministic, fake-timer driven) even if the vendor promise never settles', async () => {
    // Phase 5 blocker fix: the previous test relied on real
    // setTimeout. The new wrapper uses `Promise.race` against a
    // sentinel that BOTH aborts the controller AND rejects the
    // race even when `executeUpload` ignores the signal — so we
    // can prove the timeout fires by mocking executeUpload as a
    // never-settling promise and advancing fake time.
    vi.useFakeTimers();
    try {
      mockExecuteUpload.mockReset();
      mockExecuteUpload.mockImplementationOnce(() => new Promise<never>(() => {
        // never resolves AND never rejects — the worst case the
        // race wrapper has to defend against.
      }));
      const client = new FilecoinPinFilecoinProviderClient(fakeSynapse, fakeDelegate);
      const putPromise = client.put({ key: 'k', body: HELLO, timeoutMs: 1000 });
      // Catch the rejection synchronously so an unhandled-
      // rejection from the race doesn't fail the test on its way
      // through.
      const expectRejected = expect(putPromise).rejects.toMatchObject({
        errorCode: 'filecoin_pin_upload_timeout',
      });
      await vi.advanceTimersByTimeAsync(1000);
      await expectRejected;
    } finally {
      vi.useRealTimers();
    }
  });

  it('a successful upload cancels the timeout — no pending timer aborts the dead controller later', async () => {
    // Phase 5 review blocker: the previous `deferTimeoutRejection`
    // setTimeout was never cleared on the success path. Even with
    // `unref()`, the timer fired later and aborted a now-dead
    // controller (and produced an unhandled rejection that nobody
    // listened to). The new `makeTimeoutHandle().cancel()` is
    // invoked in `finally`. This test pins the contract: after a
    // successful upload with a configured timeout, advancing fake
    // time past `timeoutMs` does NOT abort the observed signal.
    vi.useFakeTimers();
    try {
      mockExecuteUpload.mockReset();
      let observedSignal: AbortSignal | undefined;
      mockExecuteUpload.mockImplementationOnce((_s, _c, _r, opts: { signal?: AbortSignal }) => {
        observedSignal = opts.signal;
        return Promise.resolve(uploadResultFixture());
      });
      const client = new FilecoinPinFilecoinProviderClient(fakeSynapse, fakeDelegate);
      const result = await client.put({ key: 'k', body: HELLO, timeoutMs: 1000 });
      expect(result.pieceCid).toBeDefined();
      expect(observedSignal?.aborted).toBe(false);
      // Race winner has resolved; the timeout sentinel was
      // cancelled in `finally`. Advancing past the configured
      // timeout MUST NOT toggle the signal — that would prove a
      // leaked timer.
      await vi.advanceTimersByTimeAsync(5000);
      expect(observedSignal?.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts the controller when the timeout fires (vendor-signal cooperative path)', async () => {
    vi.useFakeTimers();
    try {
      mockExecuteUpload.mockReset();
      let observedSignal: AbortSignal | undefined;
      const executeCalled = new Promise<void>((resolve) => {
        mockExecuteUpload.mockImplementationOnce((_s, _c, _r, opts: { signal?: AbortSignal }) => {
          observedSignal = opts.signal;
          resolve();
          return new Promise<never>(() => undefined);
        });
      });
      const client = new FilecoinPinFilecoinProviderClient(fakeSynapse, fakeDelegate);
      const putPromise = client.put({ key: 'k', body: HELLO, timeoutMs: 500 });
      const expectRejected = expect(putPromise).rejects.toMatchObject({
        errorCode: 'filecoin_pin_upload_timeout',
      });
      // Wait for `put` to reach `executeUpload` — the CAR build
      // step is async and runs before the signal is observable.
      await executeCalled;
      expect(observedSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(500);
      await expectRejected;
      // After the race winner rejects, the AbortController is
      // aborted so a signal-aware vendor cancels its work.
      expect(observedSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
