/**
 * @file v5 hard CLI bounds. `--limit` and `--token-budget` carry
 * named caps so the CLI itself rejects pathological values at usage
 * time rather than forwarding them to the provider where they would
 * OOM, time out, or be silently coerced. `--token-budget` also
 * respects the per-provider `capabilities.maxTokenBudget` (the lower
 * of the two ceilings wins).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_LIMIT,
  MAX_TOKEN_BUDGET,
  assertLimit,
  assertTokenBudget,
} from '../cli/limits.js';
import { CliError, type ProviderCapabilities } from '../types.js';

const baseCapabilities: ProviderCapabilities = {
  ingestModes: ['text'],
  extensions: { package: true },
};

test('assertLimit accepts values up to MAX_LIMIT', () => {
  assert.doesNotThrow(() => assertLimit(1));
  assert.doesNotThrow(() => assertLimit(MAX_LIMIT));
});

test('assertLimit rejects values above MAX_LIMIT with usage exit 2', () => {
  assert.throws(
    () => assertLimit(MAX_LIMIT + 1),
    (err) => err instanceof CliError && err.code === 'usage' && err.exitCode === 2,
  );
});

test('assertLimit rejects non-positive integers', () => {
  for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => assertLimit(bad),
      (err) => err instanceof CliError && err.code === 'usage',
    );
  }
});

test('assertTokenBudget accepts values up to MAX_TOKEN_BUDGET', () => {
  assert.doesNotThrow(() => assertTokenBudget(1, baseCapabilities));
  assert.doesNotThrow(() => assertTokenBudget(MAX_TOKEN_BUDGET, baseCapabilities));
});

test('assertTokenBudget rejects above MAX_TOKEN_BUDGET (CLI hard cap)', () => {
  assert.throws(
    () => assertTokenBudget(MAX_TOKEN_BUDGET + 1, baseCapabilities),
    (err) =>
      err instanceof CliError &&
      err.code === 'usage' &&
      /CLI hard cap/.test(err.message),
  );
});

test('assertTokenBudget rejects values above provider maxTokenBudget when advertised', () => {
  const caps: ProviderCapabilities = { ...baseCapabilities, maxTokenBudget: 1024 };
  assert.throws(
    () => assertTokenBudget(2048, caps),
    (err) =>
      err instanceof CliError &&
      err.code === 'usage' &&
      /provider maxTokenBudget/.test(err.message),
  );
  assert.doesNotThrow(() => assertTokenBudget(1024, caps));
});
