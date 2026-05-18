/**
 * @file Minimal fake `MemoryClient` for unit tests.
 */

import type {
  IngestInput,
  IngestResult,
  Memory,
  MemoryClient,
  SearchRequest,
  SearchResult,
  SearchResultPage,
} from '@atomicmemory/sdk';

interface FakeClientOptions {
  searchResults?: SearchResult[];
}

interface FakeClient {
  client: MemoryClient;
  searchCalls: SearchRequest[];
  ingestCalls: IngestInput[];
}

export function makeFakeClient(opts: FakeClientOptions = {}): FakeClient {
  const searchCalls: SearchRequest[] = [];
  const ingestCalls: IngestInput[] = [];
  const results = opts.searchResults ?? [];

  const client = {
    async search(req: SearchRequest): Promise<SearchResultPage> {
      searchCalls.push(req);
      return { results };
    },
    async ingest(input: IngestInput): Promise<IngestResult> {
      ingestCalls.push(input);
      return { created: ['fake-id'], updated: [], unchanged: [] };
    },
  } as unknown as MemoryClient;

  return { client, searchCalls, ingestCalls };
}

export function makeMemory(content: string, score = 0.9): SearchResult {
  const memory: Memory = {
    id: `mem-${content.slice(0, 8)}`,
    content,
    scope: { user: 'u1' },
    createdAt: new Date('2026-04-21T00:00:00Z'),
  };
  return { memory, score };
}
