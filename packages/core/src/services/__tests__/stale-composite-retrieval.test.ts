/**
 * Regression coverage for stale composite suppression in the default search path.
 *
 * This test mocks the search pipeline output directly so it verifies the
 * retrieval policy without coupling to a live database.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/* vi.hoisted must be per-file (vitest hoisting requirement). */
const mockRunSearchPipelineWithTrace = vi.hoisted(() => vi.fn());
const mockTouchMemory = vi.hoisted(() => vi.fn());
const mockGetMemory = vi.hoisted(() => vi.fn());
const mockTraceStage = vi.hoisted(() => vi.fn());
const mockTraceEvent = vi.hoisted(() => vi.fn());
const mockTraceFinalize = vi.hoisted(() => vi.fn());

import { createSearchResult, setupSearchPipelineTest, createSearchPipelineMockFactory } from './test-fixtures.js';
vi.mock('../search-pipeline.js', () => createSearchPipelineMockFactory(mockRunSearchPipelineWithTrace));

describe('stale composite retrieval', () => {
  const context = setupSearchPipelineTest(
    { mockRunSearchPipelineWithTrace, mockTouchMemory, mockGetMemory, mockTraceStage, mockTraceEvent, mockTraceFinalize },
    { beforeAll, beforeEach },
  );
  const { trace } = context;

  it('filters a composite when one covered member no longer resolves as active', async () => {
    const atomic = makeMemory('atomic-current', 'episodic');
    const composite = makeMemory('composite-stale', 'composite', {
      memberMemoryIds: ['atomic-current', 'atomic-old'],
    });
    mockRunSearchPipelineWithTrace.mockResolvedValue({
      filtered: [composite, atomic],
      trace,
    });
    mockGetMemory.mockImplementation(async (id: string) => (
      id === 'atomic-current' ? { id } : null
    ));

    const result = await context.service.search(
      'user-1',
      'Summarize the current backend preference.',
      'test',
      5,
      undefined,
      undefined,
      undefined,
      { skipRepairLoop: true, skipReranking: true },
    );

    expect(result.memories.map((memory) => memory.id)).toEqual(['atomic-current']);
    expect(trace.stage).toHaveBeenCalledWith(
      'stale-composite-filter',
      [atomic],
      expect.objectContaining({ removedIds: ['composite-stale'] }),
    );
    expect(mockTouchMemory).toHaveBeenCalledWith('atomic-current');
  });
});

function makeMemory(
  id: string,
  memoryType: string,
  metadata: Record<string, unknown> = {},
) {
  return createSearchResult({ id, content: id, embedding: [1, 0, 0], memory_type: memoryType, metadata, similarity: 0.9, score: 0.9, network: 'semantic' });
}
