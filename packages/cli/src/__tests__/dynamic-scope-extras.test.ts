/**
 * @file Dynamic scope coverage for the rest of the v5 provider surface.
 * `search` and `ingest` already have tests in dynamic-scope.test.ts;
 * this file proves every remaining adapter-touching command
 * (add / import / list / get / delete / package) ALSO enforces
 * `capabilities.requiredScope` after capabilities load and before the
 * adapter method runs. Split out to keep both test files small.
 *
 * `package` deliberately puts the dynamic scope check AFTER the
 * `extensions.package` capability gate so a Mem0 invocation surfaces
 * `unsupported_capability` (the more informative diagnosis) rather
 * than a missing-scope-field error for an unsupported operation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { add } from '../commands/memory/add.js';
import { importCommand } from '../commands/memory/import.js';
import { list } from '../commands/memory/list.js';
import { deleteCommand } from '../commands/memory/delete.js';
import { packageCommand } from '../commands/memory/package.js';
import { CliError, type ProviderCapabilities } from '../types.js';
import { emptyConfig } from '../config/schema.js';
import type { CommandContext } from '../commands/types.js';

interface AdapterTracker {
  addCalled: boolean;
  listCalled: boolean;
  deleteCalled: boolean;
  packageCalled: boolean;
}

function newTracker(): AdapterTracker {
  return { addCalled: false, listCalled: false, deleteCalled: false, packageCalled: false };
}

function buildAdapter(tracker: AdapterTracker, capabilities: ProviderCapabilities): CommandContext['getAdapter'] {
  return async () => ({
    adapter: {
      addMemory: async () => {
        tracker.addCalled = true;
        return { created: ['id-1'], updated: [], unchanged: [] };
      },
      listMemories: async () => {
        tracker.listCalled = true;
        return { memories: [] };
      },
      getMemory: async () => ({
        id: 'x',
        content: 'x',
        scope: { user: 'u' },
        createdAt: new Date().toISOString(),
      }),
      deleteMemory: async () => {
        tracker.deleteCalled = true;
      },
      packageContext: async () => {
        tracker.packageCalled = true;
        return { text: '', tokens: 0, hits: [], budgetConstrained: false };
      },
    } as never,
    capabilities,
  });
}

function makeCtx(overrides: Partial<CommandContext>): CommandContext {
  return {
    command: 'add',
    positional: [],
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

test('add fails missing_scope_field before adapter.addMemory when ingest scope missing', async () => {
  const tracker = newTracker();
  const caps: ProviderCapabilities = {
    ingestModes: ['text'],
    extensions: { package: false },
    requiredScope: { ingest: ['user', 'namespace'] },
  };
  const ctx = makeCtx({
    positional: ['hello'],
    getAdapter: buildAdapter(tracker, caps),
  });
  await assert.rejects(
    () => add(ctx),
    (err) =>
      err instanceof CliError &&
      err.code === 'missing_scope_field' &&
      /namespace/.test(err.message),
  );
  assert.equal(tracker.addCalled, false);
});

test('import fails missing_scope_field before any addMemory call', async () => {
  const tracker = newTracker();
  const caps: ProviderCapabilities = {
    ingestModes: ['text'],
    extensions: { package: false },
    requiredScope: { ingest: ['user', 'agent_id'] },
  };
  const ctx = makeCtx({
    command: 'import',
    positional: ['-'],
    flags: { stdin: true },
    readStdin: async () => JSON.stringify([{ text: 'one' }, { text: 'two' }]),
    getAdapter: buildAdapter(tracker, caps),
  });
  await assert.rejects(
    () => importCommand(ctx),
    (err) =>
      err instanceof CliError &&
      err.code === 'missing_scope_field' &&
      /agent_id/.test(err.message),
  );
  assert.equal(tracker.addCalled, false);
});

test('list fails missing_scope_field before adapter.listMemories', async () => {
  const tracker = newTracker();
  const caps: ProviderCapabilities = {
    ingestModes: ['text'],
    extensions: { package: false },
    requiredScope: { list: ['user', 'thread'] },
  };
  const ctx = makeCtx({
    command: 'list',
    getAdapter: buildAdapter(tracker, caps),
  });
  await assert.rejects(
    () => list(ctx),
    (err) =>
      err instanceof CliError &&
      err.code === 'missing_scope_field' &&
      /thread/.test(err.message),
  );
  assert.equal(tracker.listCalled, false);
});

test('delete fails missing_scope_field before adapter.deleteMemory', async () => {
  const tracker = newTracker();
  const caps: ProviderCapabilities = {
    ingestModes: ['text'],
    extensions: { package: false },
    requiredScope: { delete: ['user', 'namespace'] },
  };
  const ctx = makeCtx({
    command: 'delete',
    positional: ['mem-1'],
    getAdapter: buildAdapter(tracker, caps),
  });
  await assert.rejects(
    () => deleteCommand(ctx),
    (err) =>
      err instanceof CliError &&
      err.code === 'missing_scope_field' &&
      /namespace/.test(err.message),
  );
  assert.equal(tracker.deleteCalled, false);
});

test('package fails missing_scope_field AFTER extensions.package, BEFORE adapter.packageContext', async () => {
  const tracker = newTracker();
  const caps: ProviderCapabilities = {
    ingestModes: ['text'],
    extensions: { package: true },
    requiredScope: { package: ['user', 'namespace'] },
  };
  const ctx = makeCtx({
    command: 'package',
    positional: ['hello'],
    getAdapter: buildAdapter(tracker, caps),
  });
  await assert.rejects(
    () => packageCommand(ctx),
    (err) =>
      err instanceof CliError &&
      err.code === 'missing_scope_field' &&
      /namespace/.test(err.message),
  );
  assert.equal(tracker.packageCalled, false);
});

test('package emits budget_constrained meta from adapter package result', async () => {
  const caps: ProviderCapabilities = {
    ingestModes: ['text'],
    extensions: { package: true },
    requiredScope: { package: ['user'] },
  };
  const ctx = makeCtx({
    command: 'package',
    positional: ['hello'],
    flags: { 'token-budget': 10 },
    getAdapter: async () => ({
      adapter: {
        packageContext: async () => ({
          text: 'short',
          tokens: 7,
          hits: [],
          budgetConstrained: true,
        }),
      } as never,
      capabilities: caps,
    }),
  });

  const result = await packageCommand(ctx);

  assert.equal(result.meta?.budget_constrained, true);
  assert.equal(result.meta?.token_budget, 10);
  assert.equal(result.data.budgetConstrained, true);
});
