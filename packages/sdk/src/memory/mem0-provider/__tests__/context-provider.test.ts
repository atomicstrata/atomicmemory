/**
 * @file Mem0 Context Provider Unit Tests
 *
 * Validates the V2-compatible bridge used by webapp consumers.
 * Focuses on endpoint routing and threshold semantics for local Mem0.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Mem0ContextProvider } from '../context-provider';

const API_URL = 'http://localhost:8888';
const TEST_USER = 'bridge-user';

function createProvider(): Mem0ContextProvider {
  return new Mem0ContextProvider({
    host: API_URL,
    apiStyle: 'oss',
    defaultUserId: TEST_USER,
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal('fetch', mockFetch);
});

describe('Mem0ContextProvider.addContext', () => {
  it('returns the Mem0 server-assigned ID alongside the caller contextId', async () => {
    const provider = createProvider();
    await provider.initialize();

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        results: [
          { id: 'mem0-server-id-abc', memory: 'Test content', event: 'ADD' },
        ],
      })
    );

    const result = await provider.addContext('caller-ctx-123', 'Test content', {
      userId: TEST_USER,
    });

    expect(result.memoryId).toBe('mem0-server-id-abc');
    expect(result.contextId).toBe('caller-ctx-123');
    expect(result.content).toBe('Test content');
  });

  it('falls back to contextId when Mem0 returns no results', async () => {
    const provider = createProvider();
    await provider.initialize();

    mockFetch.mockResolvedValueOnce(jsonResponse({ results: [] }));

    const result = await provider.addContext('fallback-ctx', 'Fallback test');

    expect(result.memoryId).toBe('fallback-ctx');
    expect(result.contextId).toBe('fallback-ctx');
  });
});

describe('Mem0ContextProvider.searchContext', () => {
  it('uses the OSS search endpoint and returns raw backend scores', async () => {
    const provider = createProvider();
    await provider.initialize();

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        results: [
          {
            id: 'mem-1',
            memory: 'User prefers dark mode',
            score: 0.18,
            metadata: { contextId: 'ctx-1' },
          },
        ],
      })
    );

    const results = await provider.searchContext('dark mode', {
      userId: TEST_USER,
      maxResults: 5,
    });

    expect(mockFetch.mock.calls[0][0]).toBe(`${API_URL}/search/`);
    expect(results).toEqual([
      {
        id: 'mem-1',
        contextId: 'ctx-1',
        content: 'User prefers dark mode',
        score: 0.18,
        metadata: { contextId: 'ctx-1' },
      },
    ]);
  });

  it('treats threshold as minimum similarity and converts it to max distance', async () => {
    const provider = createProvider();
    await provider.initialize();

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        results: [
          {
            id: 'close-match',
            memory: 'User prefers dark mode',
            score: 0.12,
            metadata: { contextId: 'ctx-close' },
          },
          {
            id: 'far-match',
            memory: 'User likes bright themes',
            score: 0.44,
            metadata: { contextId: 'ctx-far' },
          },
        ],
      })
    );

    const results = await provider.searchContext('dark mode', {
      userId: TEST_USER,
      threshold: 0.8,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe('close-match');
    expect(results[0]?.score).toBe(0.12);
  });
});

describe('Mem0ContextProvider.getContext', () => {
  it('returns a context record for a valid memory ID', async () => {
    const provider = createProvider();
    await provider.initialize();

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        id: 'mem-42',
        memory: 'User prefers dark mode',
        metadata: { source: 'chat' },
        created_at: '2025-01-01T00:00:00Z',
        updated_at: '2025-01-02T00:00:00Z',
      })
    );

    const result = await provider.getContext('mem-42');

    expect(mockFetch.mock.calls[0][0]).toBe(`${API_URL}/memories/mem-42/`);
    expect(result).toEqual({
      id: 'mem-42',
      content: 'User prefers dark mode',
      metadata: { source: 'chat' },
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-02T00:00:00Z',
    });
  });

  it('returns null when the memory does not exist', async () => {
    const provider = createProvider();
    await provider.initialize();

    mockFetch.mockResolvedValueOnce(
      new Response('Not Found', { status: 404 })
    );

    const result = await provider.getContext('nonexistent');

    expect(result).toBeNull();
  });
});

describe('Mem0ContextProvider.listContexts', () => {
  it('returns mapped context records for a user', async () => {
    const provider = createProvider();
    await provider.initialize();

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        results: [
          { id: 'mem-1', memory: 'First memory', metadata: {} },
          { id: 'mem-2', memory: 'Second memory', metadata: {} },
        ],
      })
    );

    const results = await provider.listContexts({ userId: TEST_USER });

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('/memories/');
    expect(url).toContain(`user_id=${TEST_USER}`);
    expect(results).toHaveLength(2);
    expect(results[0]?.id).toBe('mem-1');
    expect(results[1]?.content).toBe('Second memory');
  });

  it('uses defaultUserId when no userId is provided', async () => {
    const provider = createProvider();
    await provider.initialize();

    mockFetch.mockResolvedValueOnce(jsonResponse({ results: [] }));

    await provider.listContexts({});

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain(`user_id=${TEST_USER}`);
  });

  it('passes page_size when limit is specified', async () => {
    const provider = createProvider();
    await provider.initialize();

    mockFetch.mockResolvedValueOnce(jsonResponse({ results: [] }));

    await provider.listContexts({ limit: 3 });

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('page_size=3');
  });
});

describe('Mem0ContextProvider.deleteContext', () => {
  it('returns true on successful deletion', async () => {
    const provider = createProvider();
    await provider.initialize();

    mockFetch.mockResolvedValueOnce(
      new Response(null, { status: 200 })
    );

    const result = await provider.deleteContext('mem-42');

    expect(mockFetch.mock.calls[0][0]).toBe(`${API_URL}/memories/mem-42/`);
    expect(result).toBe(true);
  });

  it('returns false when the memory does not exist', async () => {
    const provider = createProvider();
    await provider.initialize();

    mockFetch.mockResolvedValueOnce(
      new Response('Not Found', { status: 404 })
    );

    const result = await provider.deleteContext('nonexistent');

    expect(result).toBe(false);
  });
});

describe('Mem0ContextProvider.deleteAllContexts', () => {
  it('deletes all memories for a user and returns true', async () => {
    const provider = createProvider();
    await provider.initialize();

    mockFetch.mockResolvedValueOnce(
      new Response(null, { status: 200 })
    );

    const result = await provider.deleteAllContexts({ userId: TEST_USER });

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('/memories/');
    expect(url).toContain(`user_id=${TEST_USER}`);
    expect(result).toBe(true);
  });

  it('returns false on 404', async () => {
    const provider = createProvider();
    await provider.initialize();

    mockFetch.mockResolvedValueOnce(
      new Response('Not Found', { status: 404 })
    );

    const result = await provider.deleteAllContexts({ userId: TEST_USER });

    expect(result).toBe(false);
  });
});

describe('Mem0ContextProvider initialization guard', () => {
  it('throws when calling methods before initialize()', async () => {
    const provider = createProvider();

    await expect(
      provider.addContext('id', 'content')
    ).rejects.toThrow('not initialized');
  });
});
