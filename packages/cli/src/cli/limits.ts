/**
 * @file Hard CLI bounds for numeric flags. v5 requires the CLI itself
 * to reject pathological values (`--limit 999999`,
 * `--token-budget 10000000`) at usage time rather than forwarding them
 * to the provider where they would either OOM, time out, or be
 * silently coerced. Bounds are also surfaced via named constants so
 * tests and renderers can reference the documented cap.
 *
 * For `--token-budget`, the per-provider `capabilities.maxTokenBudget`
 * (when advertised) acts as an additional ceiling on top of the
 * absolute hard cap; the lower of the two wins.
 */

import { CliError, type ProviderCapabilities } from '../types.js';

/** Absolute upper bound on `--limit`. Above this, fail usage. */
export const MAX_LIMIT = 1000;

/** Absolute upper bound on `--token-budget`. Above this, fail usage. */
export const MAX_TOKEN_BUDGET = 200_000;

export function assertLimit(value: number, flag = '--limit'): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new CliError(
      'usage',
      `${flag} must be a positive integer; got ${value}`,
    );
  }
  if (value > MAX_LIMIT) {
    throw new CliError(
      'usage',
      `${flag}=${value} exceeds CLI hard cap of ${MAX_LIMIT}; pass a smaller value or paginate`,
    );
  }
}

export function assertTokenBudget(
  value: number,
  capabilities: ProviderCapabilities,
): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new CliError(
      'usage',
      `--token-budget must be a positive integer; got ${value}`,
    );
  }
  if (value > MAX_TOKEN_BUDGET) {
    throw new CliError(
      'usage',
      `--token-budget=${value} exceeds CLI hard cap of ${MAX_TOKEN_BUDGET}`,
    );
  }
  const providerCap = capabilities.maxTokenBudget;
  if (typeof providerCap === 'number' && providerCap > 0 && value > providerCap) {
    throw new CliError(
      'usage',
      `--token-budget=${value} exceeds provider maxTokenBudget=${providerCap}`,
    );
  }
}
