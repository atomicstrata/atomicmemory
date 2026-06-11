/**
 * @file Unit coverage for `atomicmemory import --type llmwiki <file>`.
 *
 * Covers: dry-run pass-through (no adapter needed), verbatim ingest
 * routing, deterministic external IDs, --type validation, capability
 * gating, fail-safe re-import detection (none/found/inconclusive),
 * provenance.source double-check, --yes confirmation gate, and the
 * cross-namespace warning.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { importCommand } from '../commands/memory/import.js';
import { CliError, type ProviderCapabilities } from '../types.js';
import { emptyConfig } from '../config/schema.js';
import type { CommandContext } from '../commands/types.js';
import type {
  AdapterIngestInput,
  AdapterIngestResult,
  AdapterListInput,
  AdapterListResult,
  AdapterMemorySummary,
  ProviderAdapter,
} from '../adapters/types.js';

// Single source of truth for the demo-kb fixture is the llmwiki
// package's `test-fixtures/` directory. Resolving via require.resolve
// keeps the dependency one-way (CLI tests reach into the llmwiki
// package) so a fixture change in one place lands everywhere.
const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'llmwiki',
  'test-fixtures',
  'demo-kb-export.json',
);

interface FakeAdapterState {
  ingestCalls: AdapterIngestInput[];
  preExisting: AdapterMemorySummary[];
}

function makeAdapter(
  state: FakeAdapterState,
  capabilities: ProviderCapabilities,
): CommandContext['getAdapter'] {
  const adapter: Partial<ProviderAdapter> = {
    async ingestMemories(input: AdapterIngestInput): Promise<AdapterIngestResult> {
      state.ingestCalls.push(input);
      return { created: [`mem-${state.ingestCalls.length}`], updated: [], unchanged: [] };
    },
    // Honor scope filtering the way production adapters do so the test
    // exercises the bridge's real cross-namespace probing behavior: it
    // calls listMemories with `{ user }` only, expecting memories across
    // every namespace under that user to surface.
    async listMemories(input: AdapterListInput): Promise<AdapterListResult> {
      const filtered = state.preExisting.filter((memory) => {
        if (memory.scope.user !== input.scope.user) return false;
        if (input.scope.namespace !== undefined && memory.scope.namespace !== input.scope.namespace) return false;
        if (input.scope.agent_id !== undefined && memory.scope.agent_id !== input.scope.agent_id) return false;
        if (input.scope.thread !== undefined && memory.scope.thread !== input.scope.thread) return false;
        return true;
      });
      return { memories: filtered };
    },
  };
  return async () => ({ adapter: adapter as ProviderAdapter, capabilities });
}

function makeCtx(state: FakeAdapterState, flags: Record<string, unknown>): CommandContext {
  return {
    command: 'import',
    positional: [FIXTURE],
    flags,
    config: emptyConfig(),
    configPath: '/tmp/x/cfg.json',
    configDir: '/tmp/x',
    profile: null,
    scope: { user: 'tester' },
    env: {},
    version: '0.1.0',
    readStdin: async () => '',
    experimental: false,
    getAdapter: makeAdapter(state, {
      ingestModes: ['text', 'messages', 'verbatim'],
      extensions: { package: false },
    }),
  };
}

function exportRecord(externalId: string, extra: Partial<AdapterMemorySummary> = {}): AdapterMemorySummary {
  return {
    id: `mem-${externalId}`,
    content: 'x',
    scope: { user: 'tester' },
    createdAt: new Date().toISOString(),
    provenance: { source: 'llmwiki', sourceId: externalId },
    metadata: { externalId },
    ...extra,
  };
}

test('--type llmwiki --dry-run reports pages without calling getAdapter', async () => {
  const state: FakeAdapterState = { ingestCalls: [], preExisting: [] };
  let adapterCalled = false;
  const ctx: CommandContext = {
    ...makeCtx(state, { type: 'llmwiki', 'dry-run': true }),
    getAdapter: async () => {
      adapterCalled = true;
      throw new Error('dry-run must not call getAdapter');
    },
  };
  const result = await importCommand(ctx);
  assert.equal(adapterCalled, false);
  assert.equal(state.ingestCalls.length, 0);
  const data = result.data as {
    dryRunPages?: { path: string; externalId: string; bodyBytes: number }[];
    dryRunSummary?: { pageCount: number; totalBytes: number; projectId: string };
  };
  const paths = data.dryRunPages?.map((p) => p.path).sort();
  assert.deepEqual(paths, [
    'wiki/concepts/chunking.md',
    'wiki/concepts/retrieval.md',
    'wiki/queries/what-is-retrieval.md',
  ]);
  for (const page of data.dryRunPages ?? []) {
    assert.match(page.externalId, /^llmwiki\/demo-kb\/(concepts|queries)\/[a-z0-9-]+$/);
    assert.ok(page.bodyBytes > 0);
  }
  assert.equal(data.dryRunSummary?.pageCount, 3);
  assert.equal(data.dryRunSummary?.projectId, 'demo-kb');
  assert.ok((data.dryRunSummary?.totalBytes ?? 0) > 0);
});

test('--type llmwiki routes verbatim ingest with deterministic external IDs', async () => {
  const state: FakeAdapterState = { ingestCalls: [], preExisting: [] };
  const ctx = makeCtx(state, { type: 'llmwiki' });
  await importCommand(ctx);
  assert.equal(state.ingestCalls.length, 3);
  for (const call of state.ingestCalls) {
    assert.equal(call.mode, 'verbatim');
    const externalId = (call.metadata as { externalId: string }).externalId;
    assert.match(externalId, /^llmwiki\/demo-kb\/(concepts|queries)\/[a-z0-9-]+$/);
    assert.equal(call.provenance?.sourceId, externalId);
  }
});

test('--type wrongvalue rejects with a clear --type error', async () => {
  const state: FakeAdapterState = { ingestCalls: [], preExisting: [] };
  const ctx = makeCtx(state, { type: 'wrongvalue' });
  await assert.rejects(
    () => importCommand(ctx),
    (err: unknown) => err instanceof CliError && err.code === 'usage' && /--type/.test(err.message),
  );
});

test('--type llmwiki refuses on second import without opt-in flags', async () => {
  const state: FakeAdapterState = {
    ingestCalls: [],
    preExisting: [exportRecord('llmwiki/demo-kb/concepts/retrieval')],
  };
  const ctx = makeCtx(state, { type: 'llmwiki' });
  await assert.rejects(
    () => importCommand(ctx),
    (err: unknown) => err instanceof CliError && err.code === 'usage' && /append-only/.test(err.message),
  );
  assert.equal(state.ingestCalls.length, 0);
});

test('--type llmwiki opt-in flags without --yes still refuse', async () => {
  const state: FakeAdapterState = {
    ingestCalls: [],
    preExisting: [exportRecord('llmwiki/demo-kb/concepts/retrieval')],
  };
  const ctx = makeCtx(state, {
    type: 'llmwiki',
    'allow-append-only': true,
    'accept-duplicates': true,
  });
  await assert.rejects(
    () => importCommand(ctx),
    (err: unknown) => err instanceof CliError && err.code === 'usage' && /--yes/.test(err.message),
  );
  assert.equal(state.ingestCalls.length, 0);
});

test('--type llmwiki proceeds on second import when all three opt-in flags supplied', async () => {
  const state: FakeAdapterState = {
    ingestCalls: [],
    preExisting: [exportRecord('llmwiki/demo-kb/concepts/retrieval')],
  };
  const ctx = makeCtx(state, {
    type: 'llmwiki',
    'allow-append-only': true,
    'accept-duplicates': true,
    yes: true,
  });
  await importCommand(ctx);
  assert.equal(state.ingestCalls.length, 3);
});

test('--type llmwiki ignores synthetic externalId without source=llmwiki provenance', async () => {
  const state: FakeAdapterState = {
    ingestCalls: [],
    preExisting: [
      {
        id: 'mem-fake',
        content: 'forged',
        scope: { user: 'tester' },
        createdAt: new Date().toISOString(),
        provenance: { source: 'custom-thing' },
        metadata: { externalId: 'llmwiki/demo-kb/concepts/anything' },
      },
    ],
  };
  const ctx = makeCtx(state, { type: 'llmwiki' });
  await importCommand(ctx);
  assert.equal(state.ingestCalls.length, 3); // proceeded as first import
});

test('--type llmwiki warns when re-importing the same projectId under a different namespace', async () => {
  const state: FakeAdapterState = {
    ingestCalls: [],
    preExisting: [
      exportRecord('llmwiki/demo-kb/concepts/retrieval', { scope: { user: 'tester', namespace: 'staging' } }),
    ],
  };
  const ctx: CommandContext = {
    ...makeCtx(state, {
      type: 'llmwiki',
      'allow-append-only': true,
      'accept-duplicates': true,
      yes: true,
    }),
    scope: { user: 'tester', namespace: 'production' },
  };
  const result = await importCommand(ctx);
  const meta = result.meta as { warning?: string };
  assert.ok(meta.warning);
  assert.match(meta.warning, /DIFFERENT namespace/);
});

test('--type llmwiki refuses when re-import probe is inconclusive (>= 50k records)', async () => {
  const preExisting: AdapterMemorySummary[] = Array.from({ length: 50_001 }, (_, i) => ({
    id: `mem-${i}`,
    content: 'x',
    scope: { user: 'tester' },
    createdAt: new Date().toISOString(),
    provenance: { source: 'other' },
    metadata: { externalId: `other/${i}` },
  }));
  const state: FakeAdapterState = { ingestCalls: [], preExisting };
  const ctx = makeCtx(state, { type: 'llmwiki' });
  await assert.rejects(
    () => importCommand(ctx),
    (err: unknown) =>
      err instanceof CliError &&
      err.code === 'usage' &&
      /E_LLMWIKI_REIMPORT_CHECK_INCONCLUSIVE/.test(err.message) &&
      // Inconclusive is a fail-safe: the error must NOT advertise the
      // opt-in flags as a workaround, because the code throws before
      // checking them. Telling users to pass --allow-append-only would
      // be a false promise.
      !/--allow-append-only/.test(err.message),
  );
});

test('--type llmwiki opt-in flags do NOT bypass an inconclusive probe', async () => {
  const preExisting: AdapterMemorySummary[] = Array.from({ length: 50_001 }, (_, i) => ({
    id: `mem-${i}`,
    content: 'x',
    scope: { user: 'tester' },
    createdAt: new Date().toISOString(),
    provenance: { source: 'other' },
    metadata: { externalId: `other/${i}` },
  }));
  const state: FakeAdapterState = { ingestCalls: [], preExisting };
  const ctx = makeCtx(state, {
    type: 'llmwiki',
    'allow-append-only': true,
    'accept-duplicates': true,
    yes: true,
  });
  await assert.rejects(
    () => importCommand(ctx),
    (err: unknown) =>
      err instanceof CliError &&
      /E_LLMWIKI_REIMPORT_CHECK_INCONCLUSIVE/.test(err.message),
  );
  assert.equal(state.ingestCalls.length, 0);
});

test('--type llmwiki rejects providers without verbatim capability', async () => {
  const state: FakeAdapterState = { ingestCalls: [], preExisting: [] };
  const ctx: CommandContext = {
    ...makeCtx(state, { type: 'llmwiki' }),
    getAdapter: makeAdapter(state, { ingestModes: ['text'], extensions: { package: false } }),
  };
  await assert.rejects(
    () => importCommand(ctx),
    (err: unknown) =>
      err instanceof CliError && err.code === 'unsupported_capability' && /verbatim/i.test(err.message),
  );
  assert.equal(state.ingestCalls.length, 0);
});

test('--type llmwiki surfaces a clean usage error when projectId override is invalid', async () => {
  const state: FakeAdapterState = { ingestCalls: [], preExisting: [] };
  const ctx = makeCtx(state, { type: 'llmwiki', 'project-id': '../escape' });
  await assert.rejects(
    () => importCommand(ctx),
    (err: unknown) =>
      err instanceof CliError &&
      err.code === 'missing_input' &&
      /E_LLMWIKI_PROJECT_ID_INVALID/.test(err.message),
  );
  assert.equal(state.ingestCalls.length, 0);
});

test('--type llmwiki collects per-page failures and throws a partial-import summary (H3)', async () => {
  let callIndex = 0;
  const state: FakeAdapterState = { ingestCalls: [], preExisting: [] };
  const ctx: CommandContext = {
    ...makeCtx(state, { type: 'llmwiki' }),
    getAdapter: async () => ({
      adapter: {
        async ingestMemories(input: AdapterIngestInput) {
          callIndex++;
          // Fail the second page; succeed on the rest.
          if (callIndex === 2) throw new Error('simulated provider hiccup');
          state.ingestCalls.push(input);
          return { created: [`mem-${callIndex}`], updated: [], unchanged: [] };
        },
        async listMemories() {
          return { memories: [] };
        },
      } as unknown as ProviderAdapter,
      capabilities: { ingestModes: ['verbatim'], extensions: { package: false } },
    }),
  };
  await assert.rejects(
    () => importCommand(ctx),
    (err: unknown) =>
      err instanceof CliError &&
      err.code === 'runtime' &&
      /Partial import: created 2, failed 1/.test(err.message) &&
      /simulated provider hiccup/.test(err.message),
  );
});

test('--type llmwiki surfaces an INVALID_SHAPE error when the file is malformed JSON', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'import-llmwiki-bad-'));
  const badPath = path.join(dir, 'bad.json');
  writeFileSync(badPath, 'not json {');
  const state: FakeAdapterState = { ingestCalls: [], preExisting: [] };
  const ctx: CommandContext = { ...makeCtx(state, { type: 'llmwiki' }), positional: [badPath] };
  try {
    await assert.rejects(
      () => importCommand(ctx),
      (err: unknown) =>
        err instanceof CliError &&
        err.code === 'usage' &&
        /E_LLMWIKI_EXPORT_INVALID_SHAPE/.test(err.message),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
