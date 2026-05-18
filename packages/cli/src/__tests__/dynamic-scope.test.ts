/**
 * @file v5 dynamic scope contract: after capabilities load and before
 * any adapter operation, the handler must enforce
 * `Capabilities.requiredScope`. Operation-specific entries take
 * precedence over the `default` fallback. Missing fields surface as
 * `missing_scope_field` (or `missing_user`) usage errors, BEFORE the
 * adapter method is invoked. Tested for `search` (operation-specific
 * required entry) and `ingest` (default fallback).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { search } from '../commands/memory/search.js';
import { ingest } from '../commands/memory/ingest.js';
import { CliError, type ProviderCapabilities } from '../types.js';
import { emptyConfig } from '../config/schema.js';
import type { CommandContext } from '../commands/types.js';

interface AdapterTracker {
  searchCalled: boolean;
  ingestCalled: boolean;
}

function makeAdapterStub(tracker: AdapterTracker) {
  return (capabilities: ProviderCapabilities): CommandContext['getAdapter'] =>
    async () => ({
      adapter: {
        searchMemories: async () => {
          tracker.searchCalled = true;
          return [];
        },
        ingestMemories: async () => {
          tracker.ingestCalled = true;
          return { created: [], updated: [], unchanged: [] };
        },
      } as never,
      capabilities,
    });
}

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
    getAdapter: async () => {
      throw new Error('test must inject getAdapter');
    },
    ...overrides,
  };
}

test('search fails with missing_scope_field when provider requires namespace and it is missing', async () => {
  const tracker: AdapterTracker = { searchCalled: false, ingestCalled: false };
  const build = makeAdapterStub(tracker);
  const caps: ProviderCapabilities = {
    ingestModes: ['text'],
    extensions: { package: false },
    requiredScope: { search: ['user', 'namespace'] },
  };
  const ctx = makeCtx({ getAdapter: build(caps) });
  await assert.rejects(
    () => search(ctx),
    (err) =>
      err instanceof CliError &&
      err.code === 'missing_scope_field' &&
      /namespace/.test(err.message),
  );
  assert.equal(tracker.searchCalled, false, 'searchMemories must not run when dynamic scope fails');
});

test('search proceeds when provider requiredScope is satisfied', async () => {
  const tracker: AdapterTracker = { searchCalled: false, ingestCalled: false };
  const build = makeAdapterStub(tracker);
  const caps: ProviderCapabilities = {
    ingestModes: ['text'],
    extensions: { package: false },
    requiredScope: { search: ['user', 'namespace'] },
  };
  const ctx = makeCtx({
    scope: { user: 'u', namespace: 'docs' },
    getAdapter: build(caps),
  });
  await search(ctx);
  assert.equal(tracker.searchCalled, true);
});

test('ingest falls back to requiredScope.default when no operation-specific entry exists', async () => {
  const tracker: AdapterTracker = { searchCalled: false, ingestCalled: false };
  const build = makeAdapterStub(tracker);
  const caps: ProviderCapabilities = {
    ingestModes: ['text'],
    extensions: { package: false },
    requiredScope: { default: ['user', 'agent_id'] },
  };
  const ctx = makeCtx({
    command: 'ingest',
    positional: ['hello'],
    flags: { mode: 'text' },
    getAdapter: build(caps),
  });
  await assert.rejects(
    () => ingest(ctx),
    (err) =>
      err instanceof CliError &&
      err.code === 'missing_scope_field' &&
      /agent_id/.test(err.message),
  );
  assert.equal(tracker.ingestCalled, false);
});
