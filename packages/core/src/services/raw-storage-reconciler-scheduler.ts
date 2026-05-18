/**
 * Scheduler wrapper around `runOnce`. Owns the `setInterval` handle,
 * prevents overlapping runs, and exposes an
 * explicit `stop()` that awaits any in-flight tick before resolving.
 *
 * NOT auto-started from `createCoreRuntime` — tests never want a
 * background timer firing in the middle of seeded-row assertions.
 * Production composition (a separate boot path) explicitly calls
 * `startReconciler(deps)` when the runtime container hands back a
 * non-null `reconcilerDeps` bundle and adds `scheduler.stop` to the
 * graceful-shutdown hook.
 */

import { runOnce, type ReconcilerDeps } from './raw-storage-reconciler.js';

export interface ReconcilerScheduler {
  /** Clears the interval and awaits the in-flight `runOnce()`. */
  stop(): Promise<void>;
  /** True while a `runOnce()` invocation is in flight. */
  readonly isRunning: boolean;
}

export interface SchedulerOptions extends ReconcilerDeps {
  /** Polling interval — `setInterval(tick, intervalMs)`. */
  intervalMs: number;
  /**
   * Called with the error if `runOnce()` rejects. Sanitization is
   * the caller's responsibility.
   */
  onError?: (err: unknown) => void;
}

export function startReconciler(options: SchedulerOptions): ReconcilerScheduler {
  let isRunning = false;
  let stopped = false;
  let inFlight: Promise<void> = Promise.resolve();
  const tick = (): void => {
    if (stopped || isRunning) return;
    isRunning = true;
    inFlight = runOnce(options)
      .then(() => undefined)
      .catch((err) => {
        if (options.onError) options.onError(err);
      })
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
