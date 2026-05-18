/**
 * Tests for stale-composite filtering.
 *
 * These cases cover the phase-1 policy: if a composite points at any member
 * that is no longer active, exclude it from default retrieval until
 * regeneration exists.
 */

import { describe, expect, it, vi } from 'vitest';

import { excludeStaleComposites } from '../composite-staleness.js';
import { createSearchResult } from './test-fixtures.js';

describe('excludeStaleComposites', () => {
  it('keeps composites whose members are still active', async () => {
    const repo = { getMemory: vi.fn(async (id: string) => ({ id })) };
    await expectFilterResult(repo, ['a', 'b'], ['a', 'c1'], []);
  });

  it('removes composites with superseded or invalidated members', async () => {
    const repo = { getMemory: vi.fn(async (id: string) => (id === 'a' ? { id } : null)) };
    await expectFilterResult(repo, ['a', 'b'], ['a'], ['c1']);
  });

  it('treats dangling member ids the same as deleted members', async () => {
    const repo = { getMemory: vi.fn(async () => null) };
    await expectFilterResult(repo, ['missing-member'], ['a'], ['c1']);
  });
});

function makeAtomic(id: string) {
  return createSearchResult({ id, content: id, embedding: [1, 0, 0], memory_type: 'episodic', similarity: 0.9, score: 0.9, network: 'semantic' });
}

function makeComposite(id: string, memberMemoryIds: string[]) {
  return createSearchResult({ id, content: id, embedding: [1, 0, 0], memory_type: 'composite', metadata: { memberMemoryIds }, similarity: 0.9, score: 0.9, network: 'semantic' });
}

/** Run excludeStaleComposites and assert the filtered IDs and removed composite IDs. */
async function expectFilterResult(
  repo: { getMemory: (id: string, userId: string) => Promise<{ id: string } | null> },
  compositeMembers: string[],
  expectedFilteredIds: string[],
  expectedRemovedIds: string[],
) {
  const memories = [makeAtomic('a'), makeComposite('c1', compositeMembers)];
  const result = await excludeStaleComposites(repo, 'user-1', memories);
  expect(result.filtered.map((memory) => memory.id)).toEqual(expectedFilteredIds);
  expect(result.removedCompositeIds).toEqual(expectedRemovedIds);
}
