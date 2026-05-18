/**
 * @file AtomicMemory Provider Unit Tests
 *
 * Tests the AtomicMemoryProvider against a mocked globalThis.fetch,
 * verifying correct endpoint routing, request body construction,
 * response mapping, extension discovery, and error classification.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AtomicMemoryProvider } from '../atomicmemory-provider/atomicmemory-provider';
import { InvalidScopeError, RateLimitError, MemoryProviderError } from '../errors';
import type { Scope, IngestInput, SearchRequest, PackageRequest } from '../types';
import { jsonResponse, errorResponse, installFetchMock } from './shared/http-mocks';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const API_URL = 'https://test.atomicmemory.dev';
const VALID_SCOPE: Scope = { user: 'u1' };

function createProvider(): AtomicMemoryProvider {
  return new AtomicMemoryProvider({ apiUrl: API_URL, apiKey: 'key-123' });
}

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = installFetchMock();
});

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

describe('ingest', () => {
  it('sends text content to POST /memories/ingest', async () => {
    const provider = createProvider();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        episode_id: 'e1',
        facts_extracted: 1,
        memories_stored: 1,
        memories_updated: 0,
        memories_deleted: 0,
        memories_skipped: 0,
        stored_memory_ids: ['m1'],
        updated_memory_ids: [],
        links_created: 0,
        composites_created: 0,
      })
    );

    const input: IngestInput = {
      mode: 'text',
      content: 'Hello world',
      scope: VALID_SCOPE,
      provenance: { source: 'test-app' },
    };
    const result = await provider.ingest(input);

    const [url, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(url).toBe(`${API_URL}/v1/memories/ingest`);
    expect(init.method).toBe('POST');
    expect(body.user_id).toBe('u1');
    expect(body.conversation).toBe('Hello world');
    expect(body.source_site).toBe('test-app');
    expect(result.created).toEqual(['m1']);
  });

  it('serialises messages to conversation string', async () => {
    const provider = createProvider();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        episode_id: 'e2',
        facts_extracted: 1,
        memories_stored: 1,
        memories_updated: 0,
        memories_deleted: 0,
        memories_skipped: 0,
        stored_memory_ids: ['m2'],
        updated_memory_ids: [],
        links_created: 0,
        composites_created: 0,
      })
    );

    const input: IngestInput = {
      mode: 'messages',
      messages: [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello' },
      ],
      scope: VALID_SCOPE,
    };
    await provider.ingest(input);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.conversation).toBe('user: Hi\nassistant: Hello');
  });

  it('maps scope.thread to session_id', async () => {
    const provider = createProvider();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        episode_id: 'e3',
        facts_extracted: 1,
        memories_stored: 1,
        memories_updated: 0,
        memories_deleted: 0,
        memories_skipped: 0,
        stored_memory_ids: ['m3'],
        updated_memory_ids: [],
        links_created: 0,
        composites_created: 0,
      })
    );

    await provider.ingest({
      mode: 'text',
      content: 'Hello thread',
      scope: { user: 'u1', thread: 'thread-1' },
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.session_id).toBe('thread-1');
  });
});

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

describe('search', () => {
  it('posts to /memories/search/fast and maps results', async () => {
    const provider = createProvider();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        memories: [{
          id: 's1',
          content: 'fact',
          semantic_similarity: 0.84,
          ranking_score: 1.25,
          relevance: 0.84,
          score: 1.25,
        }],
        count: 1,
      })
    );

    const request: SearchRequest = { query: 'test', scope: VALID_SCOPE, limit: 5, threshold: 0.8 };
    const page = await provider.search(request);

    const [url, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(url).toBe(`${API_URL}/v1/memories/search/fast`);
    expect(init.method).toBe('POST');
    expect(body.query).toBe('test');
    expect(body.user_id).toBe('u1');
    expect(body.limit).toBe(5);
    expect(body.threshold).toBe(0.8);
    expect(page.results).toHaveLength(1);
    expect(page.results[0].score).toBe(1.25);
    expect(page.results[0].similarity).toBe(0.84);
    expect(page.results[0].rankingScore).toBe(1.25);
    expect(page.results[0].relevance).toBe(0.84);
    expect(page.results[0].memory.id).toBe('s1');
  });

  it('maps scope.thread to search session_id', async () => {
    const provider = createProvider();
    mockFetch.mockResolvedValueOnce(jsonResponse({ memories: [], count: 0 }));

    await provider.search({
      query: 'test',
      scope: { user: 'u1', thread: 'thread-1' },
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.session_id).toBe('thread-1');
  });

  it('rejects thread-scoped search rows without matching session_id', async () => {
    const provider = createProvider();
    mockFetch.mockResolvedValueOnce(jsonResponse({
      memories: [{ id: 's1', content: 'wrong thread' }],
      count: 1,
    }));

    await expect(provider.search({
      query: 'test',
      scope: { user: 'u1', thread: 'thread-1' },
    })).rejects.toThrow(/session_id/);
  });

  it('rejects thread-scoped search rows with mismatched session_id', async () => {
    const provider = createProvider();
    mockFetch.mockResolvedValueOnce(jsonResponse({
      memories: [{ id: 's1', content: 'wrong thread', session_id: 'thread-2' }],
      count: 1,
    }));

    await expect(provider.search({
      query: 'test',
      scope: { user: 'u1', thread: 'thread-1' },
    })).rejects.toThrow(/session_id/);
  });

  it('rejects namespace-scoped search rows with mismatched namespace', async () => {
    const provider = createProvider();
    mockFetch.mockResolvedValueOnce(jsonResponse({
      memories: [{ id: 's1', content: 'wrong namespace', namespace: 'other' }],
      count: 1,
    }));

    await expect(provider.search({
      query: 'test',
      scope: { user: 'u1', namespace: 'expected' },
    })).rejects.toThrow(/namespace/);
  });
});

// ---------------------------------------------------------------------------
// Get
// ---------------------------------------------------------------------------

describe('get', () => {
  it('fetches GET /memories/:id with user_id query param', async () => {
    const provider = createProvider();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ id: 'g1', content: 'remembered' })
    );

    const memory = await provider.get({ id: 'g1', scope: VALID_SCOPE });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe(`${API_URL}/v1/memories/g1?user_id=u1`);
    expect(memory).not.toBeNull();
    expect(memory!.id).toBe('g1');
    expect(memory!.content).toBe('remembered');
  });

  it('returns null on 404', async () => {
    const provider = createProvider();
    mockFetch.mockResolvedValueOnce(errorResponse(404));

    const memory = await provider.get({ id: 'missing', scope: VALID_SCOPE });
    expect(memory).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

describe('delete', () => {
  it('sends DELETE /memories/:id with user_id query param', async () => {
    const provider = createProvider();
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await provider.delete({ id: 'd1', scope: VALID_SCOPE });

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(`${API_URL}/v1/memories/d1?user_id=u1`);
    expect(init.method).toBe('DELETE');
  });

  it('silently handles 404 on delete (no-op)', async () => {
    const provider = createProvider();
    mockFetch.mockResolvedValueOnce(errorResponse(404, 'Not Found'));

    // Should not throw
    await provider.delete({ id: 'gone', scope: VALID_SCOPE });
  });
});

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

describe('list', () => {
  it('fetches GET /memories/list with user_id, limit, offset', async () => {
    const provider = createProvider();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        memories: [{
          id: 'l1',
          content: 'item',
          namespace: 'project-a',
          session_id: 'thread-a',
        }],
        count: 1,
      })
    );

    const page = await provider.list({ scope: VALID_SCOPE, limit: 10 });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe(`${API_URL}/v1/memories/list?user_id=u1&limit=10&offset=0`);
    expect(page.memories).toHaveLength(1);
    expect(page.memories[0].id).toBe('l1');
    expect(page.memories[0].scope).toEqual({
      user: 'u1',
      namespace: 'project-a',
      thread: 'thread-a',
    });
  });

  it('maps scope.thread to list session_id query param', async () => {
    const provider = createProvider();
    mockFetch.mockResolvedValueOnce(jsonResponse({ memories: [], count: 0 }));

    await provider.list({
      scope: { user: 'u1', thread: 'thread-1' },
      limit: 10,
    });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe(
      `${API_URL}/v1/memories/list?user_id=u1&limit=10&offset=0&session_id=thread-1`,
    );
  });

  it('rejects thread-scoped list rows without matching session_id', async () => {
    const provider = createProvider();
    mockFetch.mockResolvedValueOnce(jsonResponse({
      memories: [{ id: 'l1', content: 'missing session' }],
      count: 1,
    }));

    await expect(provider.list({
      scope: { user: 'u1', thread: 'thread-1' },
      limit: 10,
    })).rejects.toThrow(/session_id/);
  });

  it('rejects thread-scoped list rows with mismatched session_id', async () => {
    const provider = createProvider();
    mockFetch.mockResolvedValueOnce(jsonResponse({
      memories: [{ id: 'l1', content: 'wrong session', session_id: 'thread-2' }],
      count: 1,
    }));

    await expect(provider.list({
      scope: { user: 'u1', thread: 'thread-1' },
      limit: 10,
    })).rejects.toThrow(/session_id/);
  });

  it('returns cursor when results fill the limit', async () => {
    const provider = createProvider();
    const twoItems = [
      { id: 'a', content: 'a' },
      { id: 'b', content: 'b' },
    ];
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ memories: twoItems, count: 2 })
    );

    const page = await provider.list({ scope: VALID_SCOPE, limit: 2 });
    expect(page.cursor).toBe('2');
  });

  it('omits cursor when results are fewer than limit', async () => {
    const provider = createProvider();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ memories: [{ id: 'x', content: 'x' }], count: 1 })
    );

    const page = await provider.list({ scope: VALID_SCOPE, limit: 10 });
    expect(page.cursor).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Extension discovery
// ---------------------------------------------------------------------------

describe('getExtension', () => {
  it('returns this for supported extensions', () => {
    const provider = createProvider();

    expect(provider.getExtension('package')).toBe(provider);
    expect(provider.getExtension('temporal')).toBe(provider);
    expect(provider.getExtension('versioning')).toBe(provider);
    expect(provider.getExtension('health')).toBe(provider);
  });

  it('returns undefined for unsupported extensions', () => {
    const provider = createProvider();

    expect(provider.getExtension('graph')).toBeUndefined();
    expect(provider.getExtension('forget')).toBeUndefined();
    expect(provider.getExtension('batch')).toBeUndefined();
    expect(provider.getExtension('nonexistent')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// package() — ContextPackage
// ---------------------------------------------------------------------------

describe('package', () => {
  it('returns ContextPackage with injection text and results', async () => {
    const provider = createProvider();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        memories: [{ id: 'p1', content: 'ctx', score: 0.9 }],
        injection_text: 'You previously said: ctx',
        estimated_context_tokens: 42,
        budget_constrained: false,
      })
    );

    const request: PackageRequest = {
      query: 'what did I say',
      scope: VALID_SCOPE,
      limit: 5,
      tokenBudget: 500,
      format: 'structured',
    };
    const pkg = await provider.package(request);

    const [url, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(url).toBe(`${API_URL}/v1/memories/search`);
    expect(body.retrieval_mode).toBe('abstract-aware');
    expect(body.token_budget).toBe(500);
    expect(body.skip_repair).toBe(true);
    expect(pkg.text).toBe('You previously said: ctx');
    expect(pkg.results).toHaveLength(1);
    expect(pkg.tokens).toBe(42);
    expect(pkg.budgetConstrained).toBe(false);
  });

  it('maps scope.thread to package session_id', async () => {
    const provider = createProvider();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        memories: [],
        injection_text: '',
        estimated_context_tokens: 0,
        budget_constrained: false,
      })
    );

    await provider.package({
      query: 'what did I say',
      scope: { user: 'u1', thread: 'thread-1' },
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.session_id).toBe('thread-1');
  });

  it('rejects thread-scoped package rows without matching session_id', async () => {
    const provider = createProvider();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        memories: [{ id: 'p1', content: 'wrong thread', score: 0.9 }],
        injection_text: 'wrong thread',
        estimated_context_tokens: 2,
        budget_constrained: false,
      })
    );

    await expect(
      provider.package({
        query: 'what did I say',
        scope: { user: 'u1', thread: 'thread-1' },
      })
    ).rejects.toThrow(/session_id/);
  });

  it('propagates budget_constrained=true from the backend', async () => {
    const provider = createProvider();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        memories: [{ id: 'p1', content: 'ctx', score: 0.9 }],
        injection_text: 'short',
        estimated_context_tokens: 10,
        budget_constrained: true,
      })
    );

    const pkg = await provider.package({ query: 'q', scope: VALID_SCOPE, tokenBudget: 5 });
    expect(pkg.budgetConstrained).toBe(true);
  });

  it('throws when backend response is missing budget_constrained', async () => {
    const provider = createProvider();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        memories: [],
        injection_text: '',
        estimated_context_tokens: 0,
      })
    );
    await expect(
      provider.package({ query: 'q', scope: VALID_SCOPE })
    ).rejects.toThrow(/budget_constrained/);
  });

  it('throws when budget_constrained is not a boolean', async () => {
    const provider = createProvider();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        memories: [],
        injection_text: '',
        estimated_context_tokens: 0,
        budget_constrained: 'yes',
      })
    );
    await expect(
      provider.package({ query: 'q', scope: VALID_SCOPE })
    ).rejects.toThrow(/budget_constrained/);
  });
});

// ---------------------------------------------------------------------------
// searchAsOf() — TemporalSearch
// ---------------------------------------------------------------------------

describe('searchAsOf', () => {
  it('maps scope.thread to temporal search session_id', async () => {
    const provider = createProvider();
    mockFetch.mockResolvedValueOnce(jsonResponse({ memories: [] }));

    await provider.searchAsOf({
      query: 'what did I say',
      scope: { user: 'u1', thread: 'thread-1' },
      asOf: new Date('2026-05-16T12:00:00.000Z'),
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.session_id).toBe('thread-1');
    expect(body.as_of).toBe('2026-05-16T12:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// Scope validation
// ---------------------------------------------------------------------------

describe('scope validation', () => {
  it('throws InvalidScopeError when user is missing', async () => {
    const provider = createProvider();
    const emptyScope: Scope = {};

    await expect(
      provider.ingest({ mode: 'text', content: 'x', scope: emptyScope })
    ).rejects.toThrow(InvalidScopeError);
  });

  it('includes the missing field name in the error', async () => {
    const provider = createProvider();

    try {
      await provider.search({ query: 'q', scope: {} });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidScopeError);
      expect((err as InvalidScopeError).message).toContain('user');
    }
  });
});

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

describe('error mapping', () => {
  it('maps 429 to RateLimitError with retryAfterMs', async () => {
    const provider = createProvider();
    mockFetch.mockResolvedValueOnce(errorResponse(429, 'slow down', '30'));

    try {
      await provider.search({ query: 'q', scope: VALID_SCOPE });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitError);
      expect((err as RateLimitError).retryAfterMs).toBe(30_000);
    }
  });

  it('maps 500 to MemoryProviderError', async () => {
    const provider = createProvider();
    mockFetch.mockResolvedValueOnce(errorResponse(500, 'internal error'));

    try {
      await provider.search({ query: 'q', scope: VALID_SCOPE });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(MemoryProviderError);
      expect((err as MemoryProviderError).message).toContain('500');
    }
  });

  it('maps 404 on get to null (not an error)', async () => {
    const provider = createProvider();
    mockFetch.mockResolvedValueOnce(errorResponse(404));

    const result = await provider.get({ id: 'nope', scope: VALID_SCOPE });
    expect(result).toBeNull();
  });
});
