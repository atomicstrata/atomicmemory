/** Regression coverage for actual provider HTTP cancellation and ingest acceptance boundaries. */
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryClient } from '../../client/memory-client';
import { AtomicMemoryProvider } from '../atomicmemory-provider/atomicmemory-provider';
import {
  MemoryProviderError,
  MemoryTransportError,
  PendingIngestError,
} from '../errors';
import { createHttpClient } from '../shared/http-client';
import { startRequestServer } from './shared/request-server';

const scope = { user: 'request-user' };
const wireResult = {
  episode_id: 'e1',
  facts_extracted: 1,
  memories_stored: 1,
  memories_updated: 1,
  memories_deleted: 0,
  memories_skipped: 0,
  stored_memory_ids: ['created'],
  updated_memory_ids: ['updated'],
  links_created: 0,
  composites_created: 0,
};
type Call = (client: MemoryClient, signal: AbortSignal) => Promise<unknown>;
const providers: ('atomicmemory' | 'mem0')[] = ['atomicmemory', 'mem0'];
const calls: {
  name: string;
  provider: 'atomicmemory' | 'mem0';
  path: string;
  call: Call;
}[] = [
  {
    name: 'AtomicMemory text',
    provider: 'atomicmemory',
    path: '/v1/memories/ingest',
    call: (client, signal) =>
      client.ingest({ mode: 'text', content: 'text', scope, signal }),
  },
  {
    name: 'AtomicMemory messages',
    provider: 'atomicmemory',
    path: '/v1/memories/ingest',
    call: (client, signal) =>
      client.ingest({
        mode: 'messages',
        messages: [{ role: 'user', content: 'text' }],
        scope,
        signal,
      }),
  },
  {
    name: 'AtomicMemory verbatim',
    provider: 'atomicmemory',
    path: '/v1/memories/ingest/quick',
    call: (client, signal) =>
      client.ingest({
        mode: 'verbatim',
        content: 'text',
        contentClass: 'summary',
        scope,
        signal,
      }),
  },
  {
    name: 'AtomicMemory search',
    provider: 'atomicmemory',
    path: '/v1/memories/search/fast',
    call: (client, signal) => client.search({ query: 'text', scope, signal }),
  },
  {
    name: 'AtomicMemory temporal search',
    provider: 'atomicmemory',
    path: '/v1/memories/search',
    call: (client, signal) => {
      const provider = client.getProvider();
      if (!(provider instanceof AtomicMemoryProvider))
        throw new Error('Expected AtomicMemory provider');
      return provider.searchAsOf({
        query: 'text',
        scope,
        signal,
        asOf: new Date('2026-01-01'),
      });
    },
  },
  {
    name: 'Mem0 text',
    provider: 'mem0',
    path: '/v1/memories/',
    call: (client, signal) =>
      client.ingest({ mode: 'text', content: 'text', scope, signal }),
  },
  {
    name: 'Mem0 messages',
    provider: 'mem0',
    path: '/v1/memories/',
    call: (client, signal) =>
      client.ingest({
        mode: 'messages',
        messages: [{ role: 'user', content: 'text' }],
        scope,
        signal,
      }),
  },
  {
    name: 'Mem0 search',
    provider: 'mem0',
    path: '/v2/memories/search/',
    call: (client, signal) => client.search({ query: 'text', scope, signal }),
  },
];

let server: Awaited<ReturnType<typeof startRequestServer>> | undefined;
afterEach(async () => {
  await server?.stop();
  server = undefined;
});

async function clientFor(
  provider: 'atomicmemory' | 'mem0',
  timeout = 1000,
): Promise<MemoryClient> {
  if (!server)
    throw new Error('Start the HTTP fixture before constructing a client');
  const config = {
    apiUrl: server.apiUrl,
    apiKey: 'fixture-secret',
    timeout,
    allowPrivateNetworks: true,
  };
  const client = new MemoryClient({ providers: { [provider]: config } });
  await client.initialize();
  return client;
}

describe('caller cancellation', () => {
  it.each(calls)(
    'cancels in-flight $name HTTP requests',
    async ({ provider, path, call }) => {
      server = await startRequestServer();
      const client = await clientFor(provider);
      const controller = new AbortController();
      const result = call(client, controller.signal).catch(
        (error: unknown) => error,
      );
      const request = await server.arrived;
      expect(request.path).toBe(path);
      expect(JSON.parse(request.body)).not.toHaveProperty('signal');
      controller.abort();
      const error = await result;
      expect(error).toBeInstanceOf(MemoryTransportError);
      expect(error).toMatchObject({ provider, code: 'AbortError' });
      await request.closed;
    },
  );

  it.each(calls)(
    'rejects already-aborted $name requests',
    async ({ provider, call }) => {
      server = await startRequestServer({ status: 200, body: wireResult });
      const client = await clientFor(provider);
      const controller = new AbortController();
      controller.abort();
      await expect(call(client, controller.signal)).rejects.toMatchObject({
        name: 'MemoryTransportError',
        provider,
        code: 'AbortError',
      });
      expect(server.requestCount()).toBe(0);
    },
  );

  it.each(providers)(
    'retains configured %s timeout with a caller signal',
    async (provider) => {
      server = await startRequestServer();
      const client = await clientFor(provider, 100);
      const controller = new AbortController();
      const result = client
        .search({ query: 'text', scope, signal: controller.signal })
        .catch((error: unknown) => error);
      const request = await server.arrived;
      const error = await result;
      expect(error).toBeInstanceOf(MemoryTransportError);
      expect(error).toMatchObject({ provider, code: 'TimeoutError' });
      expect(controller.signal.aborted).toBe(false);
      await request.closed;
    },
  );
});

type IngestCase = {
  name: string;
  call: (client: MemoryClient) => Promise<unknown>;
};
const genericIngests: IngestCase[] = [
  {
    name: 'text',
    call: (client) => client.ingest({ mode: 'text', content: 'text', scope }),
  },
  {
    name: 'messages',
    call: (client) =>
      client.ingest({
        mode: 'messages',
        messages: [{ role: 'user', content: 'text' }],
        scope,
      }),
  },
  {
    name: 'verbatim',
    call: (client) =>
      client.ingest({
        mode: 'verbatim',
        content: 'text',
        contentClass: 'summary',
        scope,
      }),
  },
];
const namespaceIngests: IngestCase[] = [
  {
    name: 'namespace full',
    call: (client) =>
      client.atomicmemory.ingestFull(
        { conversation: 'text', sourceSite: 'test' },
        { kind: 'user', userId: 'request-user' },
      ),
  },
  {
    name: 'namespace quick',
    call: (client) =>
      client.atomicmemory.ingestQuick(
        { conversation: 'text', sourceSite: 'test' },
        { kind: 'user', userId: 'request-user' },
        { skipExtraction: true },
      ),
  },
];
const ingests = [...genericIngests, ...namespaceIngests];

describe.each([
  {
    name: 'without IDs',
    body: { status: 'pending', secret: 'backend-secret' },
  },
  { name: 'with IDs', body: { ...wireResult, secret: 'backend-secret' } },
])('HTTP 202 $name', ({ body }) => {
  it.each(ingests)('fails closed for $name ingest', async ({ call }) => {
    server = await startRequestServer({ status: 202, body });
    const client = await clientFor('atomicmemory');
    const error = await call(client).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MemoryProviderError);
    expect(error).toBeInstanceOf(PendingIngestError);
    expect(error).toMatchObject({
      name: 'PendingIngestError',
      provider: 'atomicmemory',
      status: 202,
    });
    if (!(error instanceof Error)) throw new Error('Expected a typed error');
    expect(error.message).not.toContain('backend-secret');
    expect(error.message).not.toContain('fixture-secret');
    expect(error.message).not.toContain(server.apiUrl);
  });
});

describe('successful response compatibility', () => {
  it.each([200, 201])(
    'preserves generic ingest IDs on HTTP %s',
    async (status) => {
      server = await startRequestServer({ status, body: wireResult });
      const client = await clientFor('atomicmemory');
      for (const ingest of genericIngests) {
        await expect(ingest.call(client)).resolves.toEqual({
          created: ['created'],
          updated: ['updated'],
          unchanged: [],
        });
      }
    },
  );

  it.each([200, 201])(
    'preserves namespace ingest shape on HTTP %s',
    async (status) => {
      server = await startRequestServer({ status, body: wireResult });
      const client = await clientFor('atomicmemory');
      for (const ingest of namespaceIngests) {
        await expect(ingest.call(client)).resolves.toEqual({
          episodeId: 'e1',
          factsExtracted: 1,
          memoriesStored: 1,
          memoriesUpdated: 1,
          memoriesDeleted: 0,
          memoriesSkipped: 0,
          storedMemoryIds: ['created'],
          updatedMemoryIds: ['updated'],
          linksCreated: 0,
          compositesCreated: 0,
        });
      }
    },
  );

  it('keeps HTTP 202 successful without an explicit ingest policy, even at an ingest URL', async () => {
    server = await startRequestServer({ status: 202, body: { queued: true } });
    await expect(
      createHttpClient('atomicmemory').fetchJson(
        { apiUrl: server.apiUrl, timeout: 1000 },
        '/v1/memories/ingest',
        { method: 'POST' },
      ),
    ).resolves.toEqual({ queued: true });
  });
});
