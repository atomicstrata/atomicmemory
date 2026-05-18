/**
 * Scheduler lifecycle tests — drive `setInterval` with fake timers
 * so the assertions stay deterministic. We never `await new Promise`
 * on a real timeout.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startReconciler, type SchedulerOptions } from '../raw-storage-reconciler-scheduler.js';
import type { RawContentStore } from '../../storage/raw-content-store.js';
import { NoopRawContentCodec } from '../../storage/codecs/noop-codec.js';
import type pg from 'pg';

function makeDeps(overrides: Partial<SchedulerOptions> = {}): SchedulerOptions {
  const fakeStore: RawContentStore = {
    provider: 'filecoin',
    capabilities: {
      addressing: 'content', retrievalConsistency: 'eventual',
      deleteSemantics: 'tombstone', supportsHead: true, supportsGet: true,
    },
    put: async () => { throw new Error('not used'); },
    get: async () => { throw new Error('not used'); },
    head: async () => ({ exists: false, metadata: null }),
    delete: async () => ({ deleted: false, semantics: 'tombstoned' }),
  };
  const stubPool = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })), connect: vi.fn() } as unknown as pg.Pool;
  // The default connect() throws so accidental network use surfaces
  // loudly in tests; specific tests override this.
  return {
    pool: stubPool,
    store: fakeStore,
    codec: new NoopRawContentCodec(),
    verifyMode: 'head_only',
    batchSize: 10,
    staleAfterMs: 5 * 60 * 1000,
    baseIntervalMs: 60 * 1000,
    backoffMaxMs: 60 * 60 * 1000,
    maxAttempts: 100,
    intervalMs: 1000,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('startReconciler', () => {
  it("isn't running before the first tick", () => {
    const scheduler = startReconciler(makeDeps());
    expect(scheduler.isRunning).toBe(false);
    void scheduler.stop();
  });

  it('stop() clears the interval without leaving open handles', async () => {
    const scheduler = startReconciler(makeDeps());
    // Advance past the first tick to start a runOnce(); the stub
    // pool's claim returns 0 rows so runOnce resolves immediately.
    await vi.advanceTimersByTimeAsync(1100);
    await scheduler.stop();
    expect(scheduler.isRunning).toBe(false);
  });

  it("doesn't double-fire when a previous runOnce is still in flight, then resolves cleanly on stop", async () => {
    // `pool.connect` returns a controllable Promise — the first tick
    // enters `runOnce()` and parks there until we resolve it.
    // Subsequent ticks that fire while `isRunning=true` MUST be
    // skipped. Once we resolve the in-flight Promise + await
    // `scheduler.stop()`, the test cleans up with no dangling work.
    const controlled = (() => {
      let resolveConnect: (value: { query: () => Promise<unknown>; release: () => void }) => void = () => undefined;
      const connectPromise = new Promise<{ query: () => Promise<unknown>; release: () => void }>(
        (resolve) => { resolveConnect = resolve; },
      );
      return { connectPromise, resolveConnect };
    })();
    const slowConnect = vi.fn().mockReturnValue(controlled.connectPromise);
    const pool = { query: vi.fn(), connect: slowConnect } as unknown as pg.Pool;
    const scheduler = startReconciler(makeDeps({ pool, intervalMs: 100 }));
    // First tick fires + blocks on the slow pool.connect.
    await vi.advanceTimersByTimeAsync(150);
    expect(slowConnect).toHaveBeenCalledTimes(1);
    expect(scheduler.isRunning).toBe(true);
    // Additional ticks while still running do NOT fire a second runOnce.
    await vi.advanceTimersByTimeAsync(400);
    expect(slowConnect).toHaveBeenCalledTimes(1);
    // Resolve the in-flight connect with a fake client whose
    // ROLLBACK-or-COMMIT replies are no-ops; the runOnce flow drains
    // through claimReconcileBatch on an empty result set and falls
    // off the for-loop without further claims.
    controlled.resolveConnect({
      query: async () => ({ rows: [], rowCount: 0 }),
      release: () => undefined,
    });
    // Switch to real timers so the microtask queue can drain through
    // the awaited Promise chain inside runOnce + scheduler.stop().
    vi.useRealTimers();
    await scheduler.stop();
    expect(scheduler.isRunning).toBe(false);
  });

  it("forwards a rejected runOnce to onError instead of leaving an unhandled rejection", async () => {
    const onError = vi.fn();
    const failingConnect = vi.fn(async () => { throw new Error('boom'); });
    const pool = { query: vi.fn(), connect: failingConnect } as unknown as pg.Pool;
    const scheduler = startReconciler(makeDeps({ pool, intervalMs: 100, onError }));
    await vi.advanceTimersByTimeAsync(150);
    // Allow the catch+finally microtask chain to settle.
    await vi.runAllTicks();
    await scheduler.stop();
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]?.[0] as Error).message).toBe('boom');
  });
});
