/**
 * Regression coverage for flat-mode current-state packaging when a precise
 * current atomic competes with an overlapping composite and an older atomic.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/* vi.hoisted must be per-file (vitest hoisting requirement). */
const searchMocks = vi.hoisted(() => {
  return { pipeline: vi.fn(), touch: vi.fn(), get: vi.fn(), stage: vi.fn(), event: vi.fn(), finalize: vi.fn() };
});
const { pipeline: mockRunSearchPipelineWithTrace, touch: mockTouchMemory, get: mockGetMemory, stage: mockTraceStage, event: mockTraceEvent, finalize: mockTraceFinalize } = searchMocks;

import { createSearchResult, setupSearchPipelineTest, createSearchPipelineMockFactory } from './test-fixtures.js';
vi.mock('../search-pipeline.js', () => createSearchPipelineMockFactory(mockRunSearchPipelineWithTrace));

describe('current-state composite packaging', () => {
  const context = setupSearchPipelineTest(
    { mockRunSearchPipelineWithTrace, mockTouchMemory, mockGetMemory, mockTraceStage, mockTraceEvent, mockTraceFinalize },
    { beforeAll, beforeEach },
  );
  const { trace } = context;

  beforeEach(() => {
    mockGetMemory.mockImplementation(async (id: string) => ({ id }));
  });

  it('keeps the current atomic first and suppresses the overlapping composite in flat mode', async () => {
    const composite = makeMemory(
      'composite-timeline',
      'composite',
      0.99,
      { memberMemoryIds: ['atomic-current', 'atomic-old'] },
      'The user considered MongoDB earlier but now wants PostgreSQL with pgvector.',
    );
    const current = makeMemory(
      'atomic-current',
      'episodic',
      0.96,
      {},
      'As of March 2026, the current backend is PostgreSQL with pgvector.',
    );
    const old = makeMemory(
      'atomic-old',
      'episodic',
      0.92,
      {},
      'As of January 2026, the backend was MongoDB.',
    );

    mockRunSearchPipelineWithTrace.mockResolvedValue({
      filtered: [composite, current, old],
      trace,
    });

    const result = await context.service.search(
      'user-1',
      'What backend does the user want for production now?',
      'test',
      5,
      undefined,
      undefined,
      undefined,
      { retrievalMode: 'flat', skipRepairLoop: true, skipReranking: true },
    );

    expect(result.memories.map((memory) => memory.id)).toEqual(['atomic-current', 'atomic-old']);
    expect(result.memories[0]?.content).toContain('current backend is PostgreSQL');
    expect(result.injectionText).toContain('current backend is PostgreSQL');
    expect(result.injectionText).not.toContain('considered MongoDB earlier');
    expect(trace.stage).toHaveBeenCalledWith(
      'flat-packaging-dedup',
      [
        expect.objectContaining({ id: current.id, content: current.content }),
        expect.objectContaining({ id: old.id, content: old.content }),
      ],
      expect.objectContaining({ removedIds: ['composite-timeline'] }),
    );
  });
});

function makeMemory(
  id: string,
  memoryType: string,
  score: number,
  metadata: Record<string, unknown> = {},
  content = id,
) {
  return createSearchResult({ id, content, embedding: [1, 0, 0], memory_type: memoryType, metadata, similarity: score, score, network: 'semantic' });
}
