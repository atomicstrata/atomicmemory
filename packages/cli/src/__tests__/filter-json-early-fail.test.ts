/**
 * @file `search --filter-json` must reject malformed JSON BEFORE the
 * provider adapter is initialized. v5 §"Search Semantics" requires
 * input-level errors to fire ahead of network / capability checks so
 * that machine callers get a deterministic usage envelope rather than
 * a connectivity error masking a syntax bug. Regression: prior to
 * this fix the JSON.parse fired only after `await ctx.getAdapter()`,
 * which surfaced "command needs a configured profile" when there was
 * no profile, instead of the actual filter parse error.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { search } from '../commands/memory/search.js';
import { CliError } from '../types.js';
import { emptyConfig } from '../config/schema.js';
import type { CommandContext } from '../commands/types.js';

function makeCtx(overrides: Partial<CommandContext>): CommandContext {
  return {
    command: 'search',
    positional: ['hello'],
    flags: {},
    config: emptyConfig(),
    configPath: '/tmp/missing/config.json',
    configDir: '/tmp/missing',
    profile: null,
    scope: { user: 'u' },
    env: {},
    version: '0.1.0',
    readStdin: async () => '',
    experimental: false,
    // Track whether the handler ever reached for the adapter; the
    // assertion below proves it must not when --filter-json is bad.
    getAdapter: async () => {
      throw new Error('handler must not call getAdapter on bad --filter-json');
    },
    ...overrides,
  };
}

test('search rejects malformed --filter-json before provider init', async () => {
  const ctx = makeCtx({ flags: { 'filter-json': '{not json' } });
  await assert.rejects(
    () => search(ctx),
    (err) =>
      err instanceof CliError &&
      err.code === 'usage' &&
      /--filter-json is not valid JSON/.test(err.message),
  );
});

test('search reports the JSON parse error even when no profile is configured', async () => {
  // No profile + no getAdapter access; if the handler tried to init
  // the adapter first, it would surface a "configured profile" error
  // instead of the JSON parse error.
  const ctx = makeCtx({
    profile: null,
    flags: { 'filter-json': '[' },
    getAdapter: async () => {
      throw new CliError('usage', 'no profile configured');
    },
  });
  await assert.rejects(
    () => search(ctx),
    (err) =>
      err instanceof CliError &&
      err.code === 'usage' &&
      /--filter-json is not valid JSON/.test(err.message),
  );
});
