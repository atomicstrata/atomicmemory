/**
 * @file Mem0 Provider Unit Tests
 *
 * Tests the Mem0Provider against a mocked globalThis.fetch,
 * verifying correct endpoint routing, request body construction,
 * response mapping, and error classification.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Mem0Provider } from '../mem0-provider';
import { RateLimitError, MemoryProviderError, UnsupportedOperationError } from '../../errors';
import type { Scope, IngestInput, SearchRequest, ListRequest } from '../../types';
import { jsonResponse, errorResponse, installFetchMock } from '../../__tests__/shared/http-mocks';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const API_URL = 'http://localhost:8888';
const VALID_SCOPE: Scope = { user: 'test-user' };

function createProvider(
  overrides: Partial<ConstructorParameters<typeof Mem0Provider>[0]> = {}
): Mem0Provider {
  return new Mem0Provider({
    apiUrl: API_URL,
    ...overrides,
  });
}

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = installFetchMock();
});

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

describe('ingest', () => {
  it('throws UnsupportedOperationError for verbatim mode (Mem0 does not honor the contract)', async () => {
    const provider = createProvider();
    const input: IngestInput = {
      mode: 'verbatim',
      content: 'Verbatim content that must not be split.',
      scope: VALID_SCOPE,
    };
    await expect(provider.ingest(input)).rejects.toBeInstanceOf(
      UnsupportedOperationError,
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('sends text content to POST /v1/memories/', async () => {
    const provider = createProvider();
    mockFetch.mockResolvedValueOnce(
      jsonResponse([{ id: 'mem-1', memory: 'extracted fact', event: 'ADD' }])
    );

    const input: IngestInput = {
      mode: 'text',
      content: 'Hello world',
      scope: VALID_SCOPE,
    };
    const result = await provider.ingest(input);

    const [url, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(url).toBe(`${API_URL}/v1/memories/`);
    expect(init.method).toBe('POST');
    expect(body.user_id).toBe('test-user');
    expect(body.messages).toEqual([{ role: 'user', content: 'Hello world' }]);
    expect(body.infer).toBe(true);
    expect(result.created).toEqual(['mem-1']);
  });

  it('sends messages as structured array', async () => {
    const provider = createProvider();
    mockFetch.mockResolvedValueOnce(
      jsonResponse([{ id: 'mem-2', memory: 'fact', event: 'ADD' }])
    );

    const input: IngestInput = {
      mode: 'messages',
      messages: [
        { role: 'user', content: 'What is AI?' },
        { role: 'assistant', content: 'AI is artificial intelligence.' },
      ],
      scope: VALID_SCOPE,
    };
    const result = await provider.ingest(input);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.messages).toEqual([
      { role: 'user', content: 'What is AI?' },
      { role: 'assistant', content: 'AI is artificial intelligence.' },
    ]);
    expect(result.created).toEqual(['mem-2']);
  });

  it('maps event types correctly in ingest result', async () => {
    const provider = createProvider();
    mockFetch.mockResolvedValueOnce(
      jsonResponse([
        { id: 'a', memory: 'new', event: 'ADD' },
        { id: 'b', memory: 'changed', event: 'UPDATE' },
        { id: 'c', memory: 'same', event: 'NONE' },
      ])
    );

    const result = await provider.ingest({
      mode: 'text',
      content: 'test',
      scope: VALID_SCOPE,
    });

    expect(result.created).toEqual(['a']);
    expect(result.updated).toEqual(['b']);
    expect(result.unchanged).toEqual(['c']);
  });

  it('respects per-request infer=false via metadata', async () => {
    const provider = createProvider();
    mockFetch.mockResolvedValueOnce(jsonResponse([{ id: 'm1', event: 'ADD' }]));

    await provider.ingest({
      mode: 'text',
      content: 'raw fact',
      scope: VALID_SCOPE,
      metadata: { infer: false, chunkId: 'kb-dev-test' },
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.infer).toBe(false);
    expect(body.metadata).toEqual({ chunkId: 'kb-dev-test' });
  });

  it('uses config defaultInfer when metadata.infer is absent', async () => {
    const provider = createProvider({ defaultInfer: false });
    mockFetch.mockResolvedValueOnce(jsonResponse([{ id: 'm1', event: 'ADD' }]));

    await provider.ingest({
      mode: 'text',
      content: 'test',
      scope: VALID_SCOPE,
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.infer).toBe(false);
  });

  it('strips trailing slashes from apiUrl', async () => {
    const provider = createProvider({ apiUrl: 'http://localhost:8888///' });
    mockFetch.mockResolvedValueOnce(jsonResponse([{ id: 'm1', event: 'ADD' }]));

    await provider.ingest({
      mode: 'text',
      content: 'test',
      scope: VALID_SCOPE,
    });

    expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:8888/v1/memories/');
  });
});

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

describe('search', () => {
  it('sends query to POST /v2/memories/search/ with nested filters (mem0 2.0)', async () => {
    const provider = createProvider();
    mockFetch.mockResolvedValueOnce(
      jsonResponse([
        { id: 'r1', memory: 'ML expertise', score: 0.95, metadata: { platform: 'web' } },
        { id: 'r2', memory: 'Python user', score: 0.80 },
      ])
    );

    const request: SearchRequest = {
      query: 'machine learning',
      scope: VALID_SCOPE,
      limit: 5,
    };
    const result = await provider.search(request);

    const [url, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(url).toBe(`${API_URL}/v2/memories/search/`);
    expect(body.query).toBe('machine learning');
    expect(body.filters).toEqual({ user_id: 'test-user' });
    expect(body.limit).toBe(5);
    expect(result.results).toHaveLength(2);
    expect(result.results[0].memory.content).toBe('ML expertise');
    expect(result.results[0].score).toBe(0.95);
    expect(result.results[1].memory.content).toBe('Python user');
  });

  it('maps V3 agent and thread scope fields to filters.agent_id and filters.run_id', async () => {
    const provider = createProvider();
    mockFetch.mockResolvedValueOnce(jsonResponse([]));

    await provider.search({
      query: 'q',
      scope: { user: 'u', agent: 'a', thread: 't' },
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.filters).toEqual({
      user_id: 'u',
      agent_id: 'a',
      run_id: 't',
    });
  });

  it('forwards orgId and projectId as top-level org_id and project_id', async () => {
    const provider = createProvider({ orgId: 'org-1', projectId: 'proj-1' });
    mockFetch.mockResolvedValueOnce(jsonResponse([]));

    await provider.search({ query: 'q', scope: VALID_SCOPE });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.org_id).toBe('org-1');
    expect(body.project_id).toBe('proj-1');
  });

  it('uses /memories/search/ (no v2 prefix) when pathPrefix is "" for OSS', async () => {
    const provider = createProvider({ pathPrefix: '' });
    mockFetch.mockResolvedValueOnce(jsonResponse([]));

    await provider.search({ query: 'q', scope: VALID_SCOPE });

    expect(mockFetch.mock.calls[0][0]).toBe(`${API_URL}/memories/search/`);
  });

  it('handles empty search results', async () => {
    const provider = createProvider();
    mockFetch.mockResolvedValueOnce(jsonResponse([]));

    const result = await provider.search({
      query: 'nonexistent',
      scope: VALID_SCOPE,
    });

    expect(result.results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Get
// ---------------------------------------------------------------------------

describe('get', () => {
  it('fetches a single memory by id', async () => {
    const provider = createProvider();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        id: 'mem-1',
        memory: 'User likes Python',
        created_at: '2026-01-01T00:00:00Z',
      })
    );

    const result = await provider.get({ id: 'mem-1', scope: VALID_SCOPE });

    expect(mockFetch.mock.calls[0][0]).toBe(`${API_URL}/v1/memories/mem-1/`);
    expect(result).not.toBeNull();
    expect(result!.id).toBe('mem-1');
    expect(result!.content).toBe('User likes Python');
  });

  it('returns null on 404', async () => {
    const provider = createProvider();
    mockFetch.mockResolvedValueOnce(errorResponse(404));

    const result = await provider.get({ id: 'missing', scope: VALID_SCOPE });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

describe('delete', () => {
  it('sends DELETE to /v1/memories/{id}/', async () => {
    const provider = createProvider();
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 200 }));

    await provider.delete({ id: 'mem-1', scope: VALID_SCOPE });

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(`${API_URL}/v1/memories/mem-1/`);
    expect(init.method).toBe('DELETE');
  });

  it('silently ignores 404 on delete', async () => {
    const provider = createProvider();
    mockFetch.mockResolvedValueOnce(errorResponse(404));

    await expect(
      provider.delete({ id: 'gone', scope: VALID_SCOPE })
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

describe('list', () => {
  it('lists memories with user_id and page_size params', async () => {
    const provider = createProvider();
    mockFetch.mockResolvedValueOnce(
      jsonResponse([
        { id: 'm1', memory: 'fact 1' },
        { id: 'm2', memory: 'fact 2' },
      ])
    );

    const request: ListRequest = { scope: VALID_SCOPE, limit: 10 };
    const result = await provider.list(request);

    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.pathname).toBe('/v1/memories/');
    expect(url.searchParams.get('user_id')).toBe('test-user');
    expect(url.searchParams.get('page_size')).toBe('10');
    expect(result.memories).toHaveLength(2);
    expect(result.memories[0].content).toBe('fact 1');
  });

  it('returns cursor when page is full', async () => {
    const provider = createProvider();
    const fullPage = Array.from({ length: 20 }, (_, i) => ({
      id: `m${i}`,
      memory: `fact ${i}`,
    }));
    mockFetch.mockResolvedValueOnce(jsonResponse(fullPage));

    const result = await provider.list({ scope: VALID_SCOPE });

    expect(result.cursor).toBe('20');
  });

  it('returns no cursor when page is not full', async () => {
    const provider = createProvider();
    mockFetch.mockResolvedValueOnce(
      jsonResponse([{ id: 'm1', memory: 'only one' }])
    );

    const result = await provider.list({ scope: VALID_SCOPE });

    expect(result.cursor).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

describe('capabilities', () => {
  it('declares correct ingest modes and scope', () => {
    const provider = createProvider();
    const caps = provider.capabilities();

    expect(caps.ingestModes).toEqual(['text', 'messages']);
    expect(caps.requiredScope.default).toEqual(['user']);
  });

  it('declares only health extension', () => {
    const provider = createProvider();
    const caps = provider.capabilities();

    expect(caps.extensions.package).toBe(false);
    expect(caps.extensions.temporal).toBe(false);
    expect(caps.extensions.versioning).toBe(false);
    expect(caps.extensions.health).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe('error handling', () => {
  it('throws RateLimitError on 429', async () => {
    const provider = createProvider();
    mockFetch.mockResolvedValueOnce(errorResponse(429, 'slow down', '30'));

    await expect(
      provider.search({ query: 'test', scope: VALID_SCOPE })
    ).rejects.toThrow(RateLimitError);
  });

  it('throws MemoryProviderError on 500', async () => {
    const provider = createProvider();
    mockFetch.mockResolvedValueOnce(errorResponse(500, 'internal error'));

    await expect(
      provider.search({ query: 'test', scope: VALID_SCOPE })
    ).rejects.toThrow(MemoryProviderError);
  });

  it('includes Authorization header when apiKey is set', async () => {
    const provider = createProvider({ apiKey: 'secret-key' });
    mockFetch.mockResolvedValueOnce(jsonResponse([]));

    await provider.search({ query: 'test', scope: VALID_SCOPE });

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers.Authorization).toBe('Bearer secret-key');
  });

  it('omits Authorization header when no apiKey', async () => {
    const provider = createProvider();
    mockFetch.mockResolvedValueOnce(jsonResponse([]));

    await provider.search({ query: 'test', scope: VALID_SCOPE });

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers.Authorization).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Deferred inference
// ---------------------------------------------------------------------------

describe('deferred inference', () => {
  it('sends infer=false first, then fires background infer=true', async () => {
    const provider = createProvider({ deferInference: true, defaultInfer: true });
    mockFetch
      .mockResolvedValueOnce(jsonResponse([{ id: 'mem-fast', memory: 'raw', event: 'ADD' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'mem-fast', memory: 'raw', event: 'UPDATE' }]));

    const result = await provider.ingest({
      mode: 'text',
      content: 'I love Rust',
      scope: VALID_SCOPE,
    });

    expect(result.created).toEqual(['mem-fast']);

    // Let the microtask queue flush so the background call executes
    await new Promise((r) => setTimeout(r, 0));

    expect(mockFetch).toHaveBeenCalledTimes(2);

    const firstBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(firstBody.infer).toBe(false);

    const secondBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(secondBody.infer).toBe(true);
  });

  it('skips background call when metadata.infer is explicitly false', async () => {
    const provider = createProvider({ deferInference: true });
    mockFetch.mockResolvedValueOnce(jsonResponse([{ id: 'm1', event: 'ADD' }]));

    await provider.ingest({
      mode: 'text',
      content: 'raw storage',
      scope: VALID_SCOPE,
      metadata: { infer: false },
    });

    await new Promise((r) => setTimeout(r, 0));

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.infer).toBe(false);
  });

  it('sends single call with infer=true when deferInference is off', async () => {
    const provider = createProvider({ deferInference: false });
    mockFetch.mockResolvedValueOnce(jsonResponse([{ id: 'm1', event: 'ADD' }]));

    await provider.ingest({
      mode: 'text',
      content: 'test',
      scope: VALID_SCOPE,
    });

    await new Promise((r) => setTimeout(r, 0));

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.infer).toBe(true);
  });

  it('does not reject when background AUDN call fails', async () => {
    const provider = createProvider({ deferInference: true });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    mockFetch
      .mockResolvedValueOnce(jsonResponse([{ id: 'mem-ok', event: 'ADD' }]))
      .mockRejectedValueOnce(new Error('Groq rate limit'));

    const result = await provider.ingest({
      mode: 'text',
      content: 'test content',
      scope: VALID_SCOPE,
    });

    expect(result.created).toEqual(['mem-ok']);

    // Flush the background promise rejection
    await new Promise((r) => setTimeout(r, 10));

    expect(consoleSpy).toHaveBeenCalledWith(
      '[Mem0Provider] deferred AUDN failed:',
      expect.any(Error)
    );

    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Scope validation (inherited from BaseMemoryProvider)
// ---------------------------------------------------------------------------

describe('scope validation', () => {
  it('rejects operations without required user scope', async () => {
    const provider = createProvider();

    await expect(
      provider.ingest({ mode: 'text', content: 'test', scope: {} as Scope })
    ).rejects.toThrow();
  });
});
