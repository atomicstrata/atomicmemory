/**
 * @file Hindsight Provider Unit Tests
 *
 * Tests the HindsightProvider against a mocked globalThis.fetch, covering
 * endpoint routing, scope-to-bank/tag mapping, response mappers, extension
 * discovery, and provider capability declarations without requiring a live
 * Hindsight service.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HindsightProvider } from '../hindsight-provider';
import type {
  HindsightOperationsHandle,
  HindsightRetainHandle,
} from '../types';
import { UnsupportedOperationError } from '../../errors';
import type {
  IngestInput,
  ListRequest,
  PackageRequest,
  Scope,
  SearchRequest,
} from '../../types';
import {
  errorResponse,
  installFetchMock,
  jsonResponse,
} from '../../__tests__/shared/http-mocks';

const API_URL = 'https://api.hindsight.vectorize.io';
const VALID_SCOPE: Scope = {
  user: 'user-1',
  agent: 'agent-1',
  namespace: 'ns-1',
  thread: 'thread-1',
};

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = installFetchMock();
});

function createProvider(
  overrides: Partial<ConstructorParameters<typeof HindsightProvider>[0]> = {},
): HindsightProvider {
  return new HindsightProvider({ apiUrl: API_URL, ...overrides });
}

function requestBody(callIndex = 0): Record<string, unknown> {
  return JSON.parse(String(mockFetch.mock.calls[callIndex][1].body));
}

function requestUrl(callIndex = 0): string {
  return String(mockFetch.mock.calls[callIndex][0]);
}

describe('ingest', () => {
  it('posts text retain requests to the default project route', async () => {
    const provider = createProvider();
    mockFetch.mockResolvedValueOnce(jsonResponse({ success: true }));

    const result = await provider.ingest(textInput());

    expect(requestUrl()).toBe(`${API_URL}/v1/default/banks/user-1/memories`);
    expect(requestBody().items).toEqual([
      expect.objectContaining({ content: 'Alice likes Python' }),
    ]);
    expect(result).toEqual({ created: [], updated: [], unchanged: [] });
  });

  it('honors custom apiVersion and projectId route segments', async () => {
    const provider = createProvider({ apiVersion: 'v2', projectId: 'proj' });
    mockFetch.mockResolvedValueOnce(jsonResponse({ success: true }));

    await provider.ingest(textInput());

    expect(requestUrl()).toBe(`${API_URL}/v2/proj/banks/user-1/memories`);
  });

  it('joins messages into a role-prefixed transcript', async () => {
    const provider = createProvider();
    mockFetch.mockResolvedValueOnce(jsonResponse({ success: true }));

    await provider.ingest({
      mode: 'messages',
      scope: VALID_SCOPE,
      messages: [
        { role: 'user', content: 'Question' },
        { role: 'assistant', content: 'Answer' },
      ],
    });

    const items = requestBody().items as Array<Record<string, unknown>>;
    expect(items[0].content).toBe('user: Question\nassistant: Answer');
  });

  it('rejects verbatim ingest without calling fetch', async () => {
    const provider = createProvider();
    const input: IngestInput = {
      mode: 'verbatim',
      content: 'Store exactly this.',
      scope: VALID_SCOPE,
    };

    await expect(provider.ingest(input)).rejects.toBeInstanceOf(
      UnsupportedOperationError,
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('treats async retain responses as successful without invented ids', async () => {
    const provider = createProvider();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ success: true, async: true, operation_id: 'op-1' }),
    );

    const result = await provider.ingest(textInput());

    expect(result.created).toEqual([]);
    expect(result.updated).toEqual([]);
    expect(result.unchanged).toEqual([]);
  });

  it('adds strict scope tags for agent namespace and thread', async () => {
    const provider = createProvider();
    mockFetch.mockResolvedValueOnce(jsonResponse({ success: true }));

    await provider.ingest(textInput());

    const items = requestBody().items as Array<Record<string, unknown>>;
    expect(items[0].tags).toEqual([
      'agent:agent-1',
      'namespace:ns-1',
      'thread:thread-1',
    ]);
  });
});

describe('search', () => {
  it('posts recall requests with bank routing and strict scope tags', async () => {
    const provider = createProvider({ defaultMaxTokens: 123 });
    mockFetch.mockResolvedValueOnce(jsonResponse({ results: [] }));

    await provider.search(searchRequest());

    expect(requestUrl()).toBe(
      `${API_URL}/v1/default/banks/user-1/memories/recall`,
    );
    expect(requestBody()).toMatchObject({
      query: 'python',
      max_tokens: 123,
      tags_match: 'all_strict',
    });
  });

  it('applies SearchRequest.limit as a result count after recall', async () => {
    const provider = createProvider({ defaultMaxTokens: 123 });
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        results: [rawMemory(), { ...rawMemory(), id: 'mem-2' }],
      }),
    );

    const page = await provider.search({ ...searchRequest(), limit: 1 });

    expect(requestBody().max_tokens).toBe(123);
    expect(page.results).toHaveLength(1);
    expect(page.results[0].memory.id).toBe('mem-1');
  });

  it('maps documented recall result fields into SearchResult', async () => {
    const provider = createProvider();
    mockFetch.mockResolvedValueOnce(jsonResponse({ results: [rawMemory()] }));

    const page = await provider.search(searchRequest());

    expect(page.results[0].memory.kind).toBe('fact');
    expect(page.results[0].memory.content).toBe('Alice likes Python');
    expect(page.results[0].score).toBe(0);
    expect(page.results[0].memory.metadata?.hindsightType).toBe('world');
  });

  it('preserves unknown memory types without guessing MemoryKind', async () => {
    const provider = createProvider();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ results: [{ ...rawMemory(), type: 'opinion' }] }),
    );

    const page = await provider.search(searchRequest());

    expect(page.results[0].memory.kind).toBeUndefined();
    expect(page.results[0].memory.metadata?.hindsightType).toBe('opinion');
  });
});

describe('package extension', () => {
  it('uses request tokenBudget before config defaultMaxTokens', async () => {
    const provider = createProvider({ defaultMaxTokens: 99 });
    mockFetch.mockResolvedValueOnce(jsonResponse({ results: [rawMemory()] }));

    const result = await provider.package(packageRequest());

    expect(requestBody().max_tokens).toBe(11);
    expect(result.text).toContain('- [world] Alice likes Python');
    expect(result.budgetConstrained).toBe(false);
  });

  it('falls back to defaultMaxTokens when tokenBudget is absent', async () => {
    const provider = createProvider({ defaultMaxTokens: 77 });
    mockFetch.mockResolvedValueOnce(jsonResponse({ results: [] }));

    await provider.package({ ...packageRequest(), tokenBudget: undefined });

    expect(requestBody().max_tokens).toBe(77);
  });
});

describe('reflect extension', () => {
  it('maps reflect answers into Insight with supporting memory ids', async () => {
    const provider = createProvider();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        text: 'Use Python.',
        based_on: { memories: [{ id: 'm1' }] },
      }),
    );

    const insights = await provider.reflect('What language?', VALID_SCOPE);

    expect(requestBody()).toMatchObject({
      query: 'What language?',
      tags_match: 'all_strict',
      tags: ['agent:agent-1', 'namespace:ns-1', 'thread:thread-1'],
    });
    expect(insights).toEqual([
      { content: 'Use Python.', confidence: 0, supportingMemoryIds: ['m1'] },
    ]);
  });

  it('uses zero confidence when Hindsight omits confidence', async () => {
    const provider = createProvider();
    mockFetch.mockResolvedValueOnce(jsonResponse({ text: 'No confidence.' }));

    const insights = await provider.reflect('q', VALID_SCOPE);

    expect(insights[0].confidence).toBe(0);
  });
});

describe('list get delete', () => {
  it('lists memories with limit offset and cursor mapping', async () => {
    const provider = createProvider();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ items: [rawMemory()], total: 3 }),
    );

    const page = await provider.list(listRequest());

    expect(new URL(requestUrl()).searchParams.get('offset')).toBe('1');
    expect(page.cursor).toBe('2');
    expect(page.memories[0].id).toBe('mem-1');
  });

  it('returns null for get 404 responses', async () => {
    const provider = createProvider();
    mockFetch.mockResolvedValueOnce(errorResponse(404));

    const memory = await provider.get({ id: 'missing', scope: VALID_SCOPE });

    expect(memory).toBeNull();
  });

  it('ignores delete 404 responses', async () => {
    const provider = createProvider();
    mockFetch.mockResolvedValueOnce(errorResponse(404));

    await expect(
      provider.delete({ id: 'missing', scope: VALID_SCOPE }),
    ).resolves.toBeUndefined();
  });
});

describe('capabilities and extensions', () => {
  it('declares Hindsight-supported capabilities and custom handles', () => {
    const provider = createProvider();
    const caps = provider.capabilities();

    expect(caps.ingestModes).toEqual(['text', 'messages']);
    expect(caps.extensions.package).toBe(true);
    expect(caps.extensions.reflect).toBe(true);
    expect(caps.customExtensions).toHaveProperty('hindsight.retain');
    expect(caps.customExtensions).toHaveProperty('hindsight.operations');
  });

  it('resolves retain and operations custom extension handles', async () => {
    const provider = createProvider();
    mockFetch.mockResolvedValue(errorResponse(404));

    const retain =
      provider.getExtension<HindsightRetainHandle>('hindsight.retain');
    const operations = provider.getExtension<HindsightOperationsHandle>(
      'hindsight.operations',
    );

    expect(retain).toBeTruthy();
    expect(await operations?.get(VALID_SCOPE, 'missing')).toBeNull();
  });

  it('rejects operations without required user scope', async () => {
    const provider = createProvider();

    await expect(provider.search({ query: 'q', scope: {} })).rejects.toThrow(
      /requires scope fields: user/,
    );
  });
});

describe('http behavior', () => {
  it('strips trailing slashes from apiUrl', async () => {
    const provider = createProvider({ apiUrl: `${API_URL}///` });
    mockFetch.mockResolvedValueOnce(jsonResponse({ results: [] }));

    await provider.search(searchRequest());

    expect(requestUrl()).toBe(
      `${API_URL}/v1/default/banks/user-1/memories/recall`,
    );
  });

  it('adds Authorization header when apiKey is configured', async () => {
    const provider = createProvider({ apiKey: 'secret' });
    mockFetch.mockResolvedValueOnce(jsonResponse({ results: [] }));

    await provider.search(searchRequest());

    expect(mockFetch.mock.calls[0][1].headers.Authorization).toBe(
      'Bearer secret',
    );
  });

  it('omits Authorization header when apiKey is absent', async () => {
    const provider = createProvider();
    mockFetch.mockResolvedValueOnce(jsonResponse({ results: [] }));

    await provider.search(searchRequest());

    expect(mockFetch.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });
});

function textInput(): IngestInput {
  return {
    mode: 'text',
    content: 'Alice likes Python',
    scope: VALID_SCOPE,
    provenance: { source: 'sdk-test' },
  };
}

function searchRequest(): SearchRequest {
  return { query: 'python', scope: VALID_SCOPE, limit: 5 };
}

function packageRequest(): PackageRequest {
  return { query: 'python', scope: VALID_SCOPE, tokenBudget: 11 };
}

function listRequest(): ListRequest {
  return { scope: VALID_SCOPE, limit: 1, cursor: '1' };
}

function rawMemory(): Record<string, unknown> {
  return {
    id: 'mem-1',
    text: 'Alice likes Python',
    type: 'world',
    context: 'profile',
    tags: ['agent:agent-1'],
    created_at: '2026-05-13T00:00:00.000Z',
  };
}
