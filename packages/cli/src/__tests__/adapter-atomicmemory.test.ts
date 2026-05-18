/**
 * @file AtomicMemoryAdapter tests with a fake MemoryClient — no
 * network, no SDK construction. Covers:
 *   - initialize() is idempotent and called lazily
 *   - getStatus / getCapabilities use the SDK and translate scope
 *   - addMemory / ingestMemories / searchMemories / listMemories /
 *     getMemory / deleteMemory / packageContext route correctly and
 *     translate CliScope.agent_id <-> SdkScope.agent
 *   - constructor rejects mismatched profile.provider
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AtomicMemoryAdapter,
  type ClientFactory,
} from '../adapters/atomicmemory.js';
import type { CliProfileShape } from '../config/schema.js';
import type {
  Capabilities as SdkCapabilities,
  ContextPackage as SdkContextPackage,
  IngestInput as SdkIngestInput,
  IngestResult as SdkIngestResult,
  ListRequest as SdkListRequest,
  ListResultPage as SdkListResultPage,
  Memory as SdkMemory,
  MemoryClient,
  MemoryRef as SdkMemoryRef,
  PackageRequest as SdkPackageRequest,
  ProviderStatus as SdkProviderStatus,
  SearchRequest as SdkSearchRequest,
  SearchResultPage as SdkSearchResultPage,
} from '@atomicmemory/sdk';
import { CliError } from '../types.js';

const profile: CliProfileShape = {
  provider: 'atomicmemory',
  apiUrl: 'http://localhost:3050',
  trustSurface: 'local',
  apiKey: 'sk-test',
};

interface FakeCalls {
  initialize: number;
  getProviderStatus: number;
  capabilities: number;
  ingest: SdkIngestInput[];
  search: SdkSearchRequest[];
  list: SdkListRequest[];
  get: SdkMemoryRef[];
  delete: SdkMemoryRef[];
  package: SdkPackageRequest[];
}

function makeFake(overrides: Partial<{
  status: SdkProviderStatus[];
  capabilities: SdkCapabilities;
  ingestResult: SdkIngestResult;
  searchPage: SdkSearchResultPage;
  listPage: SdkListResultPage;
  getResult: SdkMemory | null;
  packageResult: SdkContextPackage;
}> = {}) {
  const calls: FakeCalls = {
    initialize: 0,
    getProviderStatus: 0,
    capabilities: 0,
    ingest: [],
    search: [],
    list: [],
    get: [],
    delete: [],
    package: [],
  };
  const stub: Partial<MemoryClient> = {
    initialize: async () => {
      calls.initialize += 1;
    },
    getProviderStatus: () => {
      calls.getProviderStatus += 1;
      return overrides.status ?? [
        { name: 'atomicmemory', initialized: true, capabilities: null },
      ];
    },
    capabilities: () => {
      calls.capabilities += 1;
      return overrides.capabilities ?? defaultCaps();
    },
    ingest: async (req) => {
      calls.ingest.push(req as SdkIngestInput);
      return overrides.ingestResult ?? { created: ['mem-new'], updated: [], unchanged: [] };
    },
    search: async (req) => {
      calls.search.push(req as SdkSearchRequest);
      return overrides.searchPage ?? { results: [] };
    },
    list: async (req) => {
      calls.list.push(req as SdkListRequest);
      return overrides.listPage ?? { memories: [] };
    },
    get: async (ref) => {
      calls.get.push(ref as SdkMemoryRef);
      return overrides.getResult ?? null;
    },
    delete: async (ref) => {
      calls.delete.push(ref as SdkMemoryRef);
    },
    package: async (req) => {
      calls.package.push(req as SdkPackageRequest);
      return overrides.packageResult ?? {
        text: '',
        tokens: 0,
        results: [],
        budgetConstrained: false,
      };
    },
  };
  const factory: ClientFactory = () => stub as MemoryClient;
  return { calls, factory };
}

function defaultCaps(): SdkCapabilities {
  return {
    ingestModes: ['text', 'messages', 'verbatim'],
    requiredScope: { default: ['user'], search: ['user', 'agent'] },
    extensions: {
      update: true,
      package: true,
      temporal: false,
      graph: false,
      forget: false,
      profile: false,
      reflect: false,
      versioning: false,
      batch: false,
      health: false,
    },
    supportedRerankers: ['mmr'],
    customExtensions: { 'atomicmemory.lifecycle': { version: '1.0' } },
  };
}

test('constructor rejects a profile whose provider is not atomicmemory', () => {
  assert.throws(
    () =>
      new AtomicMemoryAdapter({
        profile: { ...profile, provider: 'mem0' },
        clientFactory: makeFake().factory,
      }),
    (e: unknown) => e instanceof CliError && e.code === 'usage',
  );
});

test('initialize is lazy and idempotent across multiple adapter calls', async () => {
  const { calls, factory } = makeFake();
  const a = new AtomicMemoryAdapter({ profile, clientFactory: factory });
  await a.initialize();
  await a.initialize();
  await a.getStatus();
  assert.equal(calls.initialize, 1);
});

test('getStatus reports ok=true when the SDK marks the provider initialized', async () => {
  const { factory } = makeFake();
  const a = new AtomicMemoryAdapter({ profile, clientFactory: factory });
  const s = await a.getStatus();
  assert.equal(s.ok, true);
  assert.equal(s.provider, 'atomicmemory');
  assert.equal(s.detail, undefined);
});

test('getStatus surfaces a detail when SDK reports the provider not initialized', async () => {
  const { factory } = makeFake({
    status: [{ name: 'atomicmemory', initialized: false, capabilities: null }],
  });
  const a = new AtomicMemoryAdapter({ profile, clientFactory: factory });
  const s = await a.getStatus();
  assert.equal(s.ok, false);
  assert.match(s.detail ?? '', /not initialized/);
});

test('getStatus fails closed when SDK omits the requested provider status', async () => {
  const { factory } = makeFake({
    status: [{ name: 'mem0', initialized: true, capabilities: null }],
  });
  const a = new AtomicMemoryAdapter({ profile, clientFactory: factory });
  const s = await a.getStatus();
  assert.equal(s.ok, false);
  assert.equal(s.provider, 'atomicmemory');
  assert.match(s.detail ?? '', /atomicmemory/);
});

test('getCapabilities translates SDK requiredScope.agent to CLI agent_id', async () => {
  const { factory } = makeFake();
  const a = new AtomicMemoryAdapter({ profile, clientFactory: factory });
  const caps = await a.getCapabilities();
  assert.deepEqual(caps.requiredScope?.search, ['user', 'agent_id']);
  assert.deepEqual(caps.requiredScope?.default, ['user']);
});

test('addMemory uses ingest mode "text" and translates scope.agent_id to scope.agent', async () => {
  const { calls, factory } = makeFake();
  const a = new AtomicMemoryAdapter({ profile, clientFactory: factory });
  const result = await a.addMemory({
    text: 'hello',
    scope: { user: 'u1', agent_id: 'a1' },
    metadata: { kind: 'note' },
    provenance: { source: 'cli' },
  });
  assert.deepEqual(result, { created: ['mem-new'], updated: [], unchanged: [] });
  assert.equal(calls.ingest.length, 1);
  const call = calls.ingest[0]!;
  assert.equal(call.mode, 'text');
  if (call.mode === 'text') {
    assert.equal(call.content, 'hello');
    assert.equal(call.scope.user, 'u1');
    assert.equal(call.scope.agent, 'a1');
    assert.equal((call.scope as Record<string, unknown>).agent_id, undefined);
  }
});

test('ingestMemories rejects empty/missing inputs with missing_input exit 2', async () => {
  const { factory } = makeFake();
  const a = new AtomicMemoryAdapter({ profile, clientFactory: factory });
  await assert.rejects(
    a.ingestMemories({ mode: 'text', scope: { user: 'u1' } }),
    (e: unknown) => e instanceof CliError && e.code === 'missing_input',
  );
  await assert.rejects(
    a.ingestMemories({ mode: 'messages', scope: { user: 'u1' }, messages: [] }),
    (e: unknown) => e instanceof CliError && e.code === 'missing_input',
  );
});

test('searchMemories forwards limit/filterJson/reranker and translates scope', async () => {
  const { calls, factory } = makeFake();
  const a = new AtomicMemoryAdapter({ profile, clientFactory: factory });
  await a.searchMemories({
    query: 'q',
    scope: { user: 'u1', agent_id: 'a1' },
    limit: 7,
    filterJson: { field: 'kind', op: 'eq', value: 'fact' },
    reranker: 'mmr',
  });
  assert.equal(calls.search.length, 1);
  const req = calls.search[0]!;
  assert.equal(req.query, 'q');
  assert.equal(req.limit, 7);
  assert.equal(req.reranker, 'mmr');
  assert.deepEqual(req.filter, { field: 'kind', op: 'eq', value: 'fact' });
  assert.equal(req.scope.user, 'u1');
  assert.equal(req.scope.agent, 'a1');
});

test('listMemories forwards cursor and limit', async () => {
  const { calls, factory } = makeFake();
  const a = new AtomicMemoryAdapter({ profile, clientFactory: factory });
  await a.listMemories({ scope: { user: 'u1' }, limit: 3, cursor: 'cur-a' });
  assert.deepEqual(calls.list[0], {
    scope: { user: 'u1' },
    limit: 3,
    cursor: 'cur-a',
  });
});

test('getMemory returns null when the SDK does, else maps the memory to CLI shape', async () => {
  const memory: SdkMemory = {
    id: 'mem_x',
    content: 'c',
    scope: { user: 'u1', agent: 'a1' },
    createdAt: new Date('2026-05-08T10:00:00Z'),
  };
  const { calls, factory } = makeFake({ getResult: memory });
  const a = new AtomicMemoryAdapter({ profile, clientFactory: factory });
  const m = await a.getMemory({ id: 'mem_x', scope: { user: 'u1', agent_id: 'a1' } });
  assert.ok(m);
  assert.equal(m?.id, 'mem_x');
  assert.equal(m?.scope.agent_id, 'a1');
  assert.equal(calls.get[0]?.scope.agent, 'a1');

  const { factory: nullFactory } = makeFake({ getResult: null });
  const b = new AtomicMemoryAdapter({ profile, clientFactory: nullFactory });
  assert.equal(await b.getMemory({ id: 'no', scope: { user: 'u1' } }), null);
});

test('deleteMemory translates scope.agent_id and resolves with no return value', async () => {
  const { calls, factory } = makeFake();
  const a = new AtomicMemoryAdapter({ profile, clientFactory: factory });
  await a.deleteMemory({ id: 'mem_x', scope: { user: 'u1', agent_id: 'a1' } });
  assert.equal(calls.delete[0]?.scope.agent, 'a1');
});

test('packageContext forwards token/format/filter and translates scope', async () => {
  const { calls, factory } = makeFake();
  const a = new AtomicMemoryAdapter({ profile, clientFactory: factory });
  const pkg = await a.packageContext({
    query: 'q',
    scope: { user: 'u1' },
    tokenBudget: 500,
    format: 'tiered',
    filterJson: { field: 'kind', op: 'eq', value: 'fact' },
  });
  const req = calls.package[0]!;
  assert.equal(req.query, 'q');
  assert.equal(req.tokenBudget, 500);
  assert.equal(req.format, 'tiered');
  assert.deepEqual(req.filter, { field: 'kind', op: 'eq', value: 'fact' });
  assert.equal(pkg.budgetConstrained, false);
});

test('packageContext propagates SDK budgetConstrained to the CLI adapter shape', async () => {
  const { factory } = makeFake({
    packageResult: {
      text: 'short package',
      tokens: 12,
      results: [],
      budgetConstrained: true,
    },
  });
  const a = new AtomicMemoryAdapter({ profile, clientFactory: factory });
  const pkg = await a.packageContext({
    query: 'q',
    scope: { user: 'u1' },
    tokenBudget: 10,
  });
  assert.equal(pkg.budgetConstrained, true);
});
