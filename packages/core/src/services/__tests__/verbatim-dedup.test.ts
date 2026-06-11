/**
 * Unit coverage for verbatim-ingest idempotency by `metadata.externalId`
 * (radar audit #6).
 *
 * `performStoreVerbatim` must be idempotent on `(user_id,
 * metadata->>'externalId')` over live rows: re-ingesting the same
 * `externalId` updates the existing live row in place (check-then-update)
 * instead of inserting a second row. Rows WITHOUT an `externalId` keep plain
 * insert behavior. These tests mock the memory store so the branch logic is
 * exercised without Postgres; the partial UNIQUE index that backstops the
 * invariant (migration 0003) is a Postgres-gated path verified separately.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../embedding.js', () => ({
  embedText: vi.fn(async () => [0.1, 0.2]),
}));
vi.mock('../write-security.js', () => ({
  assessWriteSecurity: vi.fn(() => ({
    allowed: true,
    blockedBy: null,
    trust: { score: 0.9, sanitization: { passed: true, findings: [], highestSeverity: 'none' } },
  })),
  recordRejectedWrite: vi.fn(),
}));

const { performStoreVerbatim } = await import('../memory-ingest.js');

interface StoreMocks {
  getMemoryByExternalId: ReturnType<typeof vi.fn>;
  storeMemory: ReturnType<typeof vi.fn>;
  updateMemoryContent: ReturnType<typeof vi.fn>;
  updateMemoryMetadata: ReturnType<typeof vi.fn>;
}

function makeDeps(existingRow: { id: string } | null): { deps: unknown; memory: StoreMocks } {
  const memory: StoreMocks = {
    getMemoryByExternalId: vi.fn(async () => existingRow),
    storeMemory: vi.fn(async () => 'new-memory-id'),
    updateMemoryContent: vi.fn(async () => undefined),
    updateMemoryMetadata: vi.fn(async () => undefined),
  };
  const deps = {
    config: { ingestTraceEnabled: false },
    stores: { episode: { storeEpisode: vi.fn(async () => 'episode-1') }, memory },
  };
  return { deps, memory };
}

describe('verbatim ingest dedup by externalId', () => {
  it('inserts a new row when no live row shares the externalId', async () => {
    const { deps, memory } = makeDeps(null);
    const result = await performStoreVerbatim(
      deps as never,
      'user-1',
      'atom body',
      'radar',
      '',
      { externalId: 'atom-1' },
    );
    expect(memory.storeMemory).toHaveBeenCalledTimes(1);
    expect(memory.updateMemoryContent).not.toHaveBeenCalled();
    expect(result.memoriesStored).toBe(1);
    expect(result.memoriesUpdated).toBe(0);
    expect(result.storedMemoryIds).toEqual(['new-memory-id']);
  });

  it('updates the existing live row instead of inserting a duplicate', async () => {
    const { deps, memory } = makeDeps({ id: 'existing-id' });
    const result = await performStoreVerbatim(
      deps as never,
      'user-1',
      'atom body v2',
      'radar',
      '',
      { externalId: 'atom-1' },
    );
    expect(memory.storeMemory).not.toHaveBeenCalled();
    expect(memory.updateMemoryContent).toHaveBeenCalledTimes(1);
    expect(memory.updateMemoryMetadata).toHaveBeenCalledWith('user-1', 'existing-id', { externalId: 'atom-1' });
    expect(result.memoriesStored).toBe(0);
    expect(result.memoriesUpdated).toBe(1);
    expect(result.updatedMemoryIds).toEqual(['existing-id']);
  });

  it('skips the dedup lookup and inserts when no externalId is present', async () => {
    const { deps, memory } = makeDeps({ id: 'existing-id' });
    const result = await performStoreVerbatim(deps as never, 'user-1', 'unkeyed body', 'upload');
    expect(memory.getMemoryByExternalId).not.toHaveBeenCalled();
    expect(memory.storeMemory).toHaveBeenCalledTimes(1);
    expect(result.memoriesStored).toBe(1);
  });

  it('recovers from the concurrent-insert race: re-reads and updates on unique violation', async () => {
    // Two requests for the same externalId both see no existing row; this one
    // loses the insert race (partial-unique index -> 23505) and must re-read the
    // winner's row and update it in place rather than surface a 500.
    const { deps, memory } = makeDeps(null);
    memory.getMemoryByExternalId.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'raced-id' });
    memory.storeMemory.mockRejectedValueOnce(Object.assign(new Error('duplicate key'), { code: '23505' }));
    const result = await performStoreVerbatim(deps as never, 'user-1', 'atom body', 'radar', '', { externalId: 'atom-1' });
    expect(memory.storeMemory).toHaveBeenCalledTimes(1);
    expect(memory.getMemoryByExternalId).toHaveBeenCalledTimes(2);
    expect(memory.updateMemoryContent).toHaveBeenCalledTimes(1);
    expect(result.memoriesUpdated).toBe(1);
    expect(result.updatedMemoryIds).toEqual(['raced-id']);
  });

  it('re-throws non-unique-violation store errors instead of masking them', async () => {
    const { deps, memory } = makeDeps(null);
    memory.storeMemory.mockRejectedValueOnce(Object.assign(new Error('connection lost'), { code: '08006' }));
    await expect(
      performStoreVerbatim(deps as never, 'user-1', 'atom body', 'radar', '', { externalId: 'atom-1' }),
    ).rejects.toThrow('connection lost');
    expect(memory.getMemoryByExternalId).toHaveBeenCalledTimes(1);
    expect(memory.updateMemoryContent).not.toHaveBeenCalled();
  });
});
