/**
 * Unit tests for the embedding LRU cache and batch integration.
 * Mocks OpenAI constructor to intercept API calls and verify caching.
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';

const mockCreate = vi.fn();

vi.mock('openai', () => {
  return {
    default: class MockOpenAI {
      embeddings = { create: mockCreate };
    },
  };
});

vi.mock('../api-retry.js', () => ({
  retryOnRateLimit: (fn: () => Promise<unknown>) => fn(),
}));

import {
  embedText,
  embedTexts,
  getEmbeddingCacheSize,
  clearEmbeddingCache,
  initEmbedding,
} from '../embedding.js';

function initOpenAiEmbedding(): void {
  initEmbedding({
    embeddingProvider: 'openai',
    embeddingModel: 'text-embedding-3-small',
    embeddingDimensions: 1024,
    embeddingApiUrl: undefined,
    voyageApiKey: undefined,
    voyageDocumentModel: 'voyage-4-large',
    voyageQueryModel: 'voyage-4-lite',
    ollamaBaseUrl: 'http://localhost:11434',
    openaiApiKey: 'test-key',
    embeddingCacheEnabled: false,
    extractionCacheDir: '/tmp/test-extraction',
    costLoggingEnabled: false,
    costRunId: 'test',
    costLogDir: '/tmp/test-cost',
  });
}

// The module-local config in embedding.ts requires an explicit init call
// (Phase 7 Step 3d). Tests that go through `createCoreRuntime` get this
// from the composition root; tests like this one that import embedText
// directly must init themselves. A narrow config is used so the mocked
// OpenAI constructor is what gets invoked.
beforeAll(() => {
  initOpenAiEmbedding();
});

function makeEmbedResponse(count: number) {
  return {
    data: Array.from({ length: count }, (_, i) => ({
      index: i,
      embedding: Array(4).fill(i + 1),
    })),
  };
}

describe('embedding LRU cache', () => {
  beforeEach(() => {
    clearEmbeddingCache();
    mockCreate.mockReset();
    mockCreate.mockResolvedValue(makeEmbedResponse(1));
  });

  it('caches embedText results', async () => {
    const first = await embedText('hello');
    const second = await embedText('hello');

    expect(first).toEqual(second);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('does not mix cache entries for different texts', async () => {
    mockCreate.mockResolvedValueOnce({ data: [{ index: 0, embedding: [1, 1] }] });
    mockCreate.mockResolvedValueOnce({ data: [{ index: 0, embedding: [9, 9] }] });

    const first = await embedText('hello');
    const second = await embedText('world');

    expect(first).toEqual([1, 1]);
    expect(second).toEqual([9, 9]);
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it('does not collide query and document embeddings of the same text', async () => {
    mockCreate.mockResolvedValueOnce({ data: [{ index: 0, embedding: [1, 1] }] });
    mockCreate.mockResolvedValueOnce({ data: [{ index: 0, embedding: [9, 9] }] });

    const document = await embedText('same text', 'document');
    const query = await embedText('same text', 'query');

    expect(document).toEqual([1, 1]);
    expect(query).toEqual([9, 9]);
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it('tracks cache size correctly', async () => {
    expect(getEmbeddingCacheSize()).toBe(0);
    await embedText('text-a');
    expect(getEmbeddingCacheSize()).toBe(1);
    await embedText('text-b');
    expect(getEmbeddingCacheSize()).toBe(2);
    await embedText('text-a'); // cache hit
    expect(getEmbeddingCacheSize()).toBe(2);
  });

  it('clearEmbeddingCache resets size to zero', async () => {
    await embedText('cached');
    expect(getEmbeddingCacheSize()).toBe(1);
    clearEmbeddingCache();
    expect(getEmbeddingCacheSize()).toBe(0);
  });

  it('re-fetches after cache clear', async () => {
    await embedText('cached');
    clearEmbeddingCache();
    await embedText('cached');
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });
});

describe('embedTexts batch with cache', () => {
  beforeEach(() => {
    clearEmbeddingCache();
    mockCreate.mockReset();
  });

  it('returns empty array for empty input', async () => {
    const result = await embedTexts([]);
    expect(result).toEqual([]);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('uses cache for fully cached batch', async () => {
    mockCreate.mockResolvedValue(makeEmbedResponse(1));
    await embedText('alpha');
    await embedText('beta');
    mockCreate.mockClear();

    const results = await embedTexts(['alpha', 'beta']);
    expect(results).toHaveLength(2);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('fetches only uncached texts in partial batch', async () => {
    // Cache 'alpha'
    mockCreate.mockResolvedValueOnce({ data: [{ index: 0, embedding: [5, 5] }] });
    await embedText('alpha');
    mockCreate.mockClear();

    // Batch call — only 'beta' should hit API
    mockCreate.mockResolvedValueOnce({ data: [{ index: 0, embedding: [7, 7] }] });
    const results = await embedTexts(['alpha', 'beta']);

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual([5, 5]); // from cache
    expect(results[1]).toEqual([7, 7]); // from API
    expect(mockCreate).toHaveBeenCalledTimes(1);
    // Verify only 'beta' was sent to the API
    expect(mockCreate.mock.calls[0][0].input).toEqual(['beta']);
  });

  it('populates cache from batch results', async () => {
    mockCreate.mockResolvedValueOnce({
      data: [
        { index: 0, embedding: [1, 1] },
        { index: 1, embedding: [2, 2] },
      ],
    });

    await embedTexts(['x', 'y']);
    expect(getEmbeddingCacheSize()).toBe(2);
    mockCreate.mockClear();

    // Subsequent single calls should hit cache
    const cached = await embedText('x');
    expect(cached).toEqual([1, 1]);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe('Voyage embedding provider', () => {
  beforeEach(() => {
    clearEmbeddingCache();
    vi.unstubAllGlobals();
    initEmbedding({
      embeddingProvider: 'voyage',
      embeddingModel: 'unused-for-voyage',
      embeddingDimensions: 1024,
      embeddingApiUrl: undefined,
      voyageApiKey: 'voyage-key',
      voyageDocumentModel: 'voyage-4-large',
      voyageQueryModel: 'voyage-4-lite',
      ollamaBaseUrl: 'http://localhost:11434',
      openaiApiKey: '',
      embeddingCacheEnabled: false,
      extractionCacheDir: '/tmp/test-extraction',
      costLoggingEnabled: false,
      costRunId: 'test',
      costLogDir: '/tmp/test-cost',
    });
  });

  it('uses task-specific Voyage models and input_type values', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ index: 0, embedding: [4, 4] }], usage: { total_tokens: 3 } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await embedText('same text', 'query');
    await embedText('same text', 'document');

    const firstBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(firstBody).toMatchObject({ model: 'voyage-4-lite', input_type: 'query' });
    expect(secondBody).toMatchObject({ model: 'voyage-4-large', input_type: 'document' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
