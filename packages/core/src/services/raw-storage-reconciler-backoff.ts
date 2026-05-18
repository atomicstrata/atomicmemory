/**
 * @file Deterministic retry-backoff helper for raw-storage reconciliation.
 *
 * Kept separate from the reconciler orchestration so both production
 * code and tests can assert scheduling math without depending on the
 * larger DB/network reconciliation module.
 */

export function computeBackoffMs(attempts: number, baseMs: number, maxMs: number): number {
  if (attempts <= 0) return baseMs;
  const safeAttempts = Math.min(attempts, 32);
  const exponential = Math.pow(2, safeAttempts) * baseMs;
  return Math.min(exponential, maxMs);
}
