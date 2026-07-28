/**
 * Tests for the deferred-AUDN background scheduler: it polls reconcile() on the
 * interval, never overlaps ticks, surfaces errors via onError, and stop() awaits
 * the in-flight drain. Uses fake timers to stay deterministic (no real sleeps).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  startDeferredAudnScheduler,
  type DeferredAudnSchedulerOptions,
} from '../deferred-audn-scheduler.js';
import type { ReconciliationResult } from '../deferred-audn.js';

const EMPTY: ReconciliationResult = {
  processed: 0, resolved: 0, noops: 0, updates: 0,
  supersedes: 0, deletes: 0, adds: 0, errors: 0, durationMs: 0,
};

function makeOptions(over: Partial<DeferredAudnSchedulerOptions> = {}): DeferredAudnSchedulerOptions {
  return {
    reconcile: vi.fn(async () => EMPTY),
    intervalMs: 1000,
    onError: vi.fn(),
    ...over,
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('startDeferredAudnScheduler', () => {
  it('is idle before the first tick', () => {
    const s = startDeferredAudnScheduler(makeOptions());
    expect(s.isRunning).toBe(false);
  });

  it('calls reconcile on each interval tick', async () => {
    const opts = makeOptions();
    startDeferredAudnScheduler(opts);
    await vi.advanceTimersByTimeAsync(2500);
    expect(opts.reconcile).toHaveBeenCalledTimes(2);
  });

  it('does not overlap ticks while a reconcile is in flight', async () => {
    let release!: () => void;
    const reconcile = vi.fn(() => new Promise<ReconciliationResult>((r) => { release = () => r(EMPTY); }));
    startDeferredAudnScheduler(makeOptions({ reconcile }));
    await vi.advanceTimersByTimeAsync(3000);
    expect(reconcile).toHaveBeenCalledTimes(1);
    release();
  });

  it('routes a rejected reconcile to onError instead of throwing', async () => {
    const onError = vi.fn();
    const reconcile = vi.fn(async () => { throw new Error('boom'); });
    startDeferredAudnScheduler(makeOptions({ reconcile, onError }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(onError).toHaveBeenCalledOnce();
  });

  it('stop() clears the interval and awaits the in-flight drain', async () => {
    const opts = makeOptions();
    const s = startDeferredAudnScheduler(opts);
    await vi.advanceTimersByTimeAsync(1000);
    await s.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(opts.reconcile).toHaveBeenCalledTimes(1);
  });
});
