/**
 * @file Mem0Adapter tests with a fake MemoryClient. The defining v5
 * behavior here is the unsupported_capability surface:
 *
 *   - packageContext throws unsupported_capability exit 2
 *   - ingestMemories with mode="verbatim" throws unsupported_capability
 *
 * The remaining methods route through the SDK with scope translation
 * exactly as the AtomicMemory adapter does; we cover one positive path
 * (search) to confirm wiring without re-asserting every translation
 * (already exercised by the AtomicMemoryAdapter suite).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Mem0Adapter, type Mem0ClientFactory } from '../adapters/mem0.js';
import type { CliProfileShape } from '../config/schema.js';
import type {
  Capabilities as SdkCapabilities,
  IngestInput as SdkIngestInput,
  MemoryClient,
  ProviderStatus as SdkProviderStatus,
  SearchRequest as SdkSearchRequest,
  SearchResultPage as SdkSearchResultPage,
} from '@atomicmemory/sdk';
import { CliError } from '../types.js';

const profile: CliProfileShape = {
  provider: 'mem0',
  apiUrl: 'https://mem0.example.com',
  trustSurface: 'authenticated-wrapper',
  apiKey: 'sk-mem0',
};

interface FakeCalls {
  initialize: number;
  ingest: SdkIngestInput[];
  search: SdkSearchRequest[];
}

function makeFake(overrides: Partial<{
  status: SdkProviderStatus[];
  capabilities: SdkCapabilities;
  searchPage: SdkSearchResultPage;
}> = {}) {
  const calls: FakeCalls = { initialize: 0, ingest: [], search: [] };
  const stub: Partial<MemoryClient> = {
    initialize: async () => {
      calls.initialize += 1;
    },
    getProviderStatus: () =>
      overrides.status ?? [
        { name: 'mem0', initialized: true, capabilities: null },
      ],
    capabilities: () => overrides.capabilities ?? mem0Caps(),
    ingest: async (req) => {
      calls.ingest.push(req as SdkIngestInput);
      return { created: ['m1'], updated: [], unchanged: [] };
    },
    search: async (req) => {
      calls.search.push(req as SdkSearchRequest);
      return overrides.searchPage ?? { results: [] };
    },
  };
  const factory: Mem0ClientFactory = () => stub as MemoryClient;
  return { calls, factory };
}

function mem0Caps(): SdkCapabilities {
  return {
    ingestModes: ['text', 'messages'],
    requiredScope: { default: ['user'] },
    extensions: {
      update: false,
      package: false,
      temporal: false,
      graph: false,
      forget: false,
      profile: false,
      reflect: false,
      versioning: false,
      batch: false,
      health: false,
    },
  };
}

test('constructor rejects a profile whose provider is not mem0', () => {
  assert.throws(
    () =>
      new Mem0Adapter({
        profile: { ...profile, provider: 'atomicmemory' },
        clientFactory: makeFake().factory,
      }),
    (e: unknown) => e instanceof CliError && e.code === 'usage',
  );
});

test('packageContext throws unsupported_capability exit 2 (Mem0 has no packager)', async () => {
  const { factory } = makeFake();
  const a = new Mem0Adapter({ profile, clientFactory: factory });
  await assert.rejects(
    a.packageContext({ query: 'q', scope: { user: 'u1' }, tokenBudget: 100 }),
    (e: unknown) =>
      e instanceof CliError &&
      e.code === 'unsupported_capability' &&
      e.exitCode === 2,
  );
});

test('ingestMemories rejects mode=verbatim with unsupported_capability exit 2', async () => {
  const { factory } = makeFake();
  const a = new Mem0Adapter({ profile, clientFactory: factory });
  await assert.rejects(
    a.ingestMemories({
      mode: 'verbatim',
      scope: { user: 'u1' },
      text: 'verbatim payload',
    }),
    (e: unknown) =>
      e instanceof CliError && e.code === 'unsupported_capability',
  );
});

test('addMemory and ingestMemories(text) succeed via the underlying SDK ingest', async () => {
  const { calls, factory } = makeFake();
  const a = new Mem0Adapter({ profile, clientFactory: factory });
  await a.addMemory({ text: 'hello', scope: { user: 'u1' } });
  await a.ingestMemories({
    mode: 'messages',
    scope: { user: 'u1' },
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(calls.ingest.length, 2);
  assert.equal(calls.ingest[0]?.mode, 'text');
  assert.equal(calls.ingest[1]?.mode, 'messages');
});

test('searchMemories translates scope.agent_id to scope.agent on Mem0 calls too', async () => {
  const { calls, factory } = makeFake();
  const a = new Mem0Adapter({ profile, clientFactory: factory });
  await a.searchMemories({
    query: 'q',
    scope: { user: 'u1', agent_id: 'a1' },
  });
  assert.equal(calls.search[0]?.scope.agent, 'a1');
});

test('getCapabilities returns mem0 caps with package=false (drives upstream gate)', async () => {
  const { factory } = makeFake();
  const a = new Mem0Adapter({ profile, clientFactory: factory });
  const caps = await a.getCapabilities();
  assert.equal(caps.extensions.package, false);
  assert.deepEqual(caps.ingestModes, ['text', 'messages']);
});
