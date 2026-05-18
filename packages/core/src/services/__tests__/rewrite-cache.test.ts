/**
 * Unit tests for the query rewrite LRU cache.
 * Verifies that repeated queries skip the LLM call.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../config.js', () => ({
  config: {
    llmProvider: 'openai',
    llmModel: 'gpt-4o-mini',
    openaiApiKey: 'test-key',
    llmApiUrl: undefined,
    ollamaBaseUrl: 'http://localhost:11434',
    llmSeed: undefined,
  },
}));

const mockChat = vi.fn();

vi.mock('../llm.js', () => ({
  llm: { chat: (...args: unknown[]) => mockChat(...args) },
}));

import { rewriteQuery, clearRewriteCache, getRewriteCacheSize } from '../extraction.js';

describe('rewrite query cache', () => {
  beforeEach(() => {
    clearRewriteCache();
    mockChat.mockReset();
    mockChat.mockResolvedValue('rewritten query text');
  });

  it('caches rewrite results', async () => {
    const first = await rewriteQuery('hello world');
    const second = await rewriteQuery('hello world');

    expect(first).toBe(second);
    expect(mockChat).toHaveBeenCalledTimes(1);
  });

  it('does not mix cache entries for different queries', async () => {
    mockChat.mockResolvedValueOnce('rewrite A');
    mockChat.mockResolvedValueOnce('rewrite B');

    const first = await rewriteQuery('query A');
    const second = await rewriteQuery('query B');

    expect(first).toBe('rewrite A');
    expect(second).toBe('rewrite B');
    expect(mockChat).toHaveBeenCalledTimes(2);
  });

  it('tracks cache size', async () => {
    expect(getRewriteCacheSize()).toBe(0);
    await rewriteQuery('q1');
    expect(getRewriteCacheSize()).toBe(1);
    await rewriteQuery('q2');
    expect(getRewriteCacheSize()).toBe(2);
    await rewriteQuery('q1'); // cache hit
    expect(getRewriteCacheSize()).toBe(2);
  });

  it('clears cache', async () => {
    await rewriteQuery('cached');
    expect(getRewriteCacheSize()).toBe(1);
    clearRewriteCache();
    expect(getRewriteCacheSize()).toBe(0);
  });

  it('re-fetches after cache clear', async () => {
    await rewriteQuery('cached');
    clearRewriteCache();
    await rewriteQuery('cached');
    expect(mockChat).toHaveBeenCalledTimes(2);
  });

  it('falls back to original query on empty LLM response', async () => {
    mockChat.mockResolvedValueOnce('');
    const result = await rewriteQuery('original question');
    expect(result).toBe('original question');
  });
});
