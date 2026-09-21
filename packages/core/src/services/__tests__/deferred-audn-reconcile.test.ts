/**
 * Deferred AUDN reconciliation passes the configured prompt variant through AUDN.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockCachedResolveAUDN = vi.fn();
const mockClearDeferredFlag = vi.fn();
const mockGetMemory = vi.fn();
const mockSoftDeleteMemory = vi.fn();

vi.mock('../../config.js', () => ({
  config: {
    deferredAudnEnabled: true,
    deferredAudnBatchSize: 20,
    deferredAudnConcurrency: 1,
    auditLoggingEnabled: false,
    extractionPromptVariant: 'compact',
  },
}));

vi.mock('../extraction-cache.js', () => ({
  cachedResolveAUDN: (...args: unknown[]) => mockCachedResolveAUDN(...args),
}));

vi.mock('../../db/repository-deferred-audn.js', () => ({
  findDeferredMemories: vi.fn(),
  findAllDeferredMemories: vi.fn(),
  clearDeferredFlag: (...args: unknown[]) => mockClearDeferredFlag(...args),
  countDeferredMemories: vi.fn(),
  markMemoryDeferred: vi.fn(),
}));

vi.mock('../embedding.js', () => ({
  embedText: vi.fn(async () => [0.1, 0.2]),
}));

const { reconcileUser } = await import('../deferred-audn.js');
const { findDeferredMemories } = await import('../../db/repository-deferred-audn.js');

beforeEach(() => {
  vi.clearAllMocks();
  mockCachedResolveAUDN.mockResolvedValue({
    action: 'ADD',
    targetMemoryId: null,
    updatedContent: null,
    clarificationNote: null,
    contradictionConfidence: null,
  });
  mockGetMemory.mockResolvedValue({ id: 'target', importance: 0.5, deleted_at: null });
});

describe('deferred AUDN reconciliation', () => {
  it('passes config.extractionPromptVariant into cachedResolveAUDN', async () => {
    vi.mocked(findDeferredMemories).mockResolvedValueOnce([{
      id: 'mem-1',
      userId: 'user-1',
      content: 'User prefers Vite.',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      candidates: [{ id: 'mem-2', content: 'User likes Vite.', similarity: 0.88 }],
    }]);

    const repo = {
      getMemory: mockGetMemory,
      softDeleteMemory: mockSoftDeleteMemory,
      updateMemoryContent: vi.fn(),
    };

    await reconcileUser({} as never, repo as never, 'user-1', 1);

    expect(mockCachedResolveAUDN).toHaveBeenCalledWith(
      'User prefers Vite.',
      expect.any(Array),
      'compact',
    );
  });
});
