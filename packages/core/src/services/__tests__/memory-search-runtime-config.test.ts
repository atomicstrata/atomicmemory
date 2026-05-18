/**
 * Runtime config seam tests for memory-search.
 *
 * Verifies that performSearch threads deps.config into the search pipeline
 * and uses that same runtime-owned config to gate request-time lessons,
 * consensus validation, and audit side effects.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSearchResult } from './test-fixtures.js';

const {
  mockCheckLessons,
  mockValidateConsensus,
  mockEmitAuditEvent,
  mockRunSearchPipelineWithTrace,
} = vi.hoisted(() => ({
  mockCheckLessons: vi.fn(),
  mockValidateConsensus: vi.fn(),
  mockEmitAuditEvent: vi.fn(),
  mockRunSearchPipelineWithTrace: vi.fn(),
}));

vi.mock('../lesson-service.js', () => ({
  checkLessons: mockCheckLessons,
  recordContradictionLesson: vi.fn(),
}));
vi.mock('../consensus-validation.js', () => ({ validateConsensus: mockValidateConsensus }));
vi.mock('../audit-events.js', () => ({ emitAuditEvent: mockEmitAuditEvent }));
vi.mock('../retrieval-policy.js', () => ({
  resolveSearchLimitDetailed: vi.fn(() => ({
    limit: 5,
    classification: { label: 'simple', matchedMarker: null },
  })),
  classifyQueryDetailed: vi.fn(() => ({ label: 'simple' })),
  resolveRecallBypass: vi.fn(() => null),
}));
vi.mock('../search-pipeline.js', () => ({
  runSearchPipelineWithTrace: mockRunSearchPipelineWithTrace,
}));
vi.mock('../composite-staleness.js', () => ({
  excludeStaleComposites: vi.fn(async (_repo, _userId, memories) => ({
    filtered: memories,
    removedCompositeIds: [],
  })),
}));

const { performSearch } = await import('../memory-search.js');

function createTrace() {
  return {
    event: vi.fn(),
    stage: vi.fn(),
    finalize: vi.fn(),
    setPackagingSummary: vi.fn(),
    setAssemblySummary: vi.fn(),
    setRetrievalSummary: vi.fn(),
    getRetrievalSummary: vi.fn(() => undefined),
  };
}

function createDeps(runtimeConfig: {
  lessonsEnabled: boolean;
  consensusValidationEnabled: boolean;
  consensusMinMemories: number;
  auditLoggingEnabled: boolean;
}) {
  const repo = { touchMemory: vi.fn().mockResolvedValue(undefined), getPool: vi.fn().mockReturnValue({}) };
  return {
    config: runtimeConfig,
    repo,
    claims: {},
    entities: null,
    lessons: {},
    stores: { memory: repo, search: repo, link: repo, claim: {}, entity: null, lesson: {} },
    observationService: null,
    uriResolver: { resolve: vi.fn().mockResolvedValue(null), format: vi.fn() },
  } as any;
}

describe('performSearch runtime config seam', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckLessons.mockResolvedValue({ safe: true });
    mockValidateConsensus.mockResolvedValue({ removedMemoryIds: [], judgments: [] });
    mockRunSearchPipelineWithTrace.mockResolvedValue({
      filtered: [createSearchResult({ id: 'memory-1', content: 'alpha result', score: 0.9 })],
      trace: createTrace(),
      queryEmbedding: [1, 0, 0],
    });
  });

  it('threads deps.config into the pipeline and gates request-time side effects from it', async () => {
    const runtimeConfig = {
      lessonsEnabled: false,
      consensusValidationEnabled: false,
      consensusMinMemories: 2,
      auditLoggingEnabled: false,
    };

    const result = await performSearch(createDeps(runtimeConfig), {
      userId: 'user-1',
      query: 'find alpha',
    });

    expect(result.memories).toHaveLength(1);
    expect(mockRunSearchPipelineWithTrace.mock.calls[0]?.[6]?.runtimeConfig).toBe(runtimeConfig);
    expect(mockCheckLessons).not.toHaveBeenCalled();
    expect(mockValidateConsensus).not.toHaveBeenCalled();
    expect(mockEmitAuditEvent).not.toHaveBeenCalled();
  });
});
