/**
 * @file Cancellable timeout sentinel for the filecoin-pin
 * driver's `put` path.
 *
 * Lifted out of `filecoin-pin-client.ts` so the client stays
 * focused on the `FilecoinProviderClient` implementation and
 * this file owns the (subtle) timer-lifetime contract.
 *
 * Contract:
 *   - `promise` rejects with `FilecoinProviderError(
 *     'filecoin_pin_upload_timeout', …)` after `timeoutMs` AND
 *     aborts the supplied controller (cooperative cancel for a
 *     signal-aware vendor).
 *   - `cancel()` clears the underlying `setTimeout` AND swallows
 *     the rejection so the loser of `Promise.race` does not
 *     surface as `unhandledRejection`.
 *
 * Callers MUST invoke `cancel()` in a `finally` block — a
 * successful upload that does not call `cancel()` would leak the
 * pending timer and later abort the (now-dead) controller. The
 * companion fake-timer test in
 * `__tests__/filecoin-pin-client-options.test.ts` pins both the
 * timeout-fires and the success-path-no-leak halves of the
 * contract.
 */

import { FilecoinProviderError } from './errors.js';

export interface TimeoutHandle {
  readonly promise: Promise<never>;
  cancel(): void;
}

export function makeTimeoutHandle(timeoutMs: number, aborter: AbortController): TimeoutHandle {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      if (cancelled) return;
      aborter.abort();
      reject(new FilecoinProviderError(
        'filecoin_pin_upload_timeout',
        `filecoin-pin driver aborted CAR upload after ${timeoutMs} ms.`,
      ));
    }, timeoutMs);
    timer.unref?.();
  });
  // Silently absorb the rejection if the race already returned a
  // result — otherwise Node logs `unhandledRejection` when the
  // sentinel loses.
  promise.catch(() => undefined);
  return {
    promise,
    cancel(): void {
      cancelled = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
