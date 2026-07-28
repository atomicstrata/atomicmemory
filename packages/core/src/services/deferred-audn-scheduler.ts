/**
 * Background scheduler that drains the deferred-AUDN queue off the ingest path.
 *
 * With `DEFERRED_AUDN_ENABLED=true`, ingest stores facts immediately and queues
 * the per-fact AUDN decision for later, so a write returns fast. Without a
 * drainer, that queue only empties when something calls `/v1/memories/reconcile`.
 * This scheduler polls `reconcile()` on an interval so AUDN is applied
 * automatically in the background — making ingest latency low while keeping the
 * supersede/dedup/contradiction decisions that AUDN provides.
 *
 * It mirrors `raw-storage-reconciler-scheduler.ts`: one in-flight tick at a time,
 * `stop()` clears the interval and awaits the in-flight drain. `createCoreRuntime`
 * does NOT start it — the process lifecycle (server.ts) opts in via config so
 * tests can drive `reconcile()` directly and stay deterministic.
 */
import type { ReconciliationResult } from './deferred-audn.js';

export interface DeferredAudnSchedulerOptions {
  /** Drains one batch of the deferred-AUDN queue (e.g. MemoryService.reconcileDeferredAll). */
  reconcile: () => Promise<ReconciliationResult>;
  /** Polling interval — `setInterval(tick, intervalMs)`. */
  intervalMs: number;
  /** Called when a tick's reconcile rejects, so the error is surfaced, not swallowed. */
  onError: (err: unknown) => void;
}

export interface DeferredAudnScheduler {
  /** Clears the interval and awaits the in-flight `reconcile()`. */
  stop(): Promise<void>;
  /** True while a `reconcile()` invocation is in flight. */
  readonly isRunning: boolean;
}

/** Start polling `reconcile()` every `intervalMs`; returns a stop handle. */
export function startDeferredAudnScheduler(
  options: DeferredAudnSchedulerOptions,
): DeferredAudnScheduler {
  let isRunning = false;
  let stopped = false;
  let inFlight: Promise<void> = Promise.resolve();

  const tick = (): void => {
    if (stopped || isRunning) return;
    isRunning = true;
    inFlight = options
      .reconcile()
      .then(() => undefined)
      .catch((err) => options.onError(err))
      .finally(() => {
        isRunning = false;
      });
  };

  const handle = setInterval(tick, options.intervalMs);

  return {
    get isRunning() {
      return isRunning;
    },
    async stop() {
      stopped = true;
      clearInterval(handle);
      await inFlight;
    },
  };
}
