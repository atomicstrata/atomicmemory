/**
 * Shared pagination utilities for llmwiki providers.
 *
 * Centralizes limit and token-budget normalization so both the live and
 * snapshot providers enforce identical semantics: undefined means "no
 * caller-specified limit / use the default"; a finite positive integer is
 * accepted; anything else is a caller error that throws immediately,
 * preventing bogus values from silently widening or distorting result sets.
 */

import {
  LLMWikiBridgeError,
  E_LLMWIKI_PROVIDER_INVALID_LIMIT,
  E_LLMWIKI_PROVIDER_INVALID_BUDGET,
} from "./errors.js";

/**
 * Normalize a request `limit`.
 *
 * - `undefined` → no caller-specified limit (returns `undefined`).
 * - Finite positive integer → returned as-is.
 * - Anything else (0, negative, non-integer, NaN, Infinity) → throws
 *   `E_LLMWIKI_PROVIDER_INVALID_LIMIT` so bogus limits are caught early.
 */
export function normalizeLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) return undefined;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new LLMWikiBridgeError(
      E_LLMWIKI_PROVIDER_INVALID_LIMIT,
      `limit must be a positive integer, got ${limit}`,
    );
  }
  return limit;
}

/**
 * Normalize a `tokenBudget` from a PackageRequest.
 *
 * - `undefined` → caller omitted; returns the provided default.
 * - Finite positive integer → returned as-is.
 * - NaN, Infinity, 0, negative, or non-integer → throws
 *   `E_LLMWIKI_PROVIDER_INVALID_BUDGET` so bogus budgets cannot
 *   silently disable the token cap.
 */
export function normalizeTokenBudget(budget: number | undefined, defaultBudget: number): number {
  if (budget === undefined) return defaultBudget;
  if (!Number.isInteger(budget) || budget <= 0) {
    throw new LLMWikiBridgeError(
      E_LLMWIKI_PROVIDER_INVALID_BUDGET,
      `tokenBudget must be a positive integer, got ${budget}`,
    );
  }
  return budget;
}
