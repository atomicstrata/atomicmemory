/**
 * Unit tests for LLM-based memory consolidation synthesis.
 * Tests prompt construction, synthesis output handling, and error cases.
 * Uses mocked LLM to avoid API calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockChat = vi.fn();
vi.mock('../llm.js', () => ({
  llm: { chat: (...args: unknown[]) => mockChat(...args) },
}));
vi.mock('../embedding.js', () => ({
  embedText: vi.fn().mockResolvedValue(Array(256).fill(0.1)),
}));
vi.mock('../../config.js', () => ({
  config: {
    llmModel: 'test-model',
    affinityClusteringThreshold: 0.85,
    affinityClusteringMinSize: 3,
    affinityClusteringBeta: 0.5,
    affinityClusteringTemporalLambda: 0.1,
    auditLoggingEnabled: false,
  },
}));

const { synthesizeCluster } = await import('../consolidation-service.js');

describe('synthesizeCluster', () => {
  beforeEach(() => {
    mockChat.mockReset();
  });

  it('calls LLM with system prompt and numbered member contents', async () => {
    mockChat.mockResolvedValue('User prefers TypeScript for frontend and Go for backend.');

    const result = await synthesizeCluster([
      'User prefers TypeScript',
      'User uses Go for backend',
      'User likes strong typing',
    ]);

    expect(result).toBe('User prefers TypeScript for frontend and Go for backend.');
    expect(mockChat).toHaveBeenCalledOnce();

    const [messages] = mockChat.mock.calls[0];
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('consolidate');
    expect(messages[1].role).toBe('user');
    expect(messages[1].content).toContain('1. User prefers TypeScript');
    expect(messages[1].content).toContain('2. User uses Go for backend');
    expect(messages[1].content).toContain('3. User likes strong typing');
  });

  it('returns null for empty LLM response', async () => {
    mockChat.mockResolvedValue('');

    const result = await synthesizeCluster(['fact 1', 'fact 2', 'fact 3']);
    expect(result).toBeNull();
  });

  it('returns null for very short LLM response', async () => {
    mockChat.mockResolvedValue('OK');

    const result = await synthesizeCluster(['fact 1', 'fact 2', 'fact 3']);
    expect(result).toBeNull();
  });

  it('trims whitespace from LLM response', async () => {
    mockChat.mockResolvedValue('  Consolidated memory content.  \n');

    const result = await synthesizeCluster(['fact 1', 'fact 2']);
    expect(result).toBe('Consolidated memory content.');
  });

  it('returns null on LLM error without throwing', async () => {
    mockChat.mockRejectedValue(new Error('API rate limit'));

    const result = await synthesizeCluster(['fact 1', 'fact 2']);
    expect(result).toBeNull();
  });

  it('passes temperature 0 and maxTokens 500', async () => {
    mockChat.mockResolvedValue('Consolidated result.');

    await synthesizeCluster(['fact 1', 'fact 2']);

    const [, options] = mockChat.mock.calls[0];
    expect(options.temperature).toBe(0);
    expect(options.maxTokens).toBe(500);
  });
});
