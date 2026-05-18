/**
 * Runtime config seam tests for search-pipeline.
 *
 * Verifies that request-time runtime config can override cross-encoder
 * reranking even when the module singleton differs.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSearchResult } from './test-fixtures.js';

const mockConfig = {
  rerankSkipTopSimilarity: 0.85,
  rerankSkipMinGap: 0.05,
  mmrEnabled: false,
  queryAugmentationEnabled: false,
  entityGraphEnabled: false,
  hybridSearchEnabled: false,
  iterativeRetrievalEnabled: false,
  agenticRetrievalEnabled: false,
  queryExpansionEnabled: false,
  linkExpansionEnabled: false,
  linkExpansionMax: 0,
  linkExpansionBeforeMMR: false,
  mmrLambda: 0.5,
  crossEncoderEnabled: true,
  crossEncoderModel: 'module-cross-encoder',
  crossEncoderDtype: 'q8',
  retrievalProfileSettings: {
    repairPrimaryWeight: 1,
    repairRewriteWeight: 1,
    rankingMinSimilarity: 0.3,
  },
};

const { mockRerankCandidates } = vi.hoisted(() => ({
  mockRerankCandidates: vi.fn(),
}));
const { mockTraceStage } = vi.hoisted(() => ({
  mockTraceStage: vi.fn(),
}));

vi.mock('../../config.js', () => ({ config: mockConfig }));
vi.mock('../embedding.js', () => ({ embedText: vi.fn().mockResolvedValue([0.1, 0.2]) }));
vi.mock('../extraction.js', () => ({ rewriteQuery: vi.fn() }));
vi.mock('../retrieval-policy.js', () => ({
  resolveRerankDepth: vi.fn((limit: number) => limit),
  shouldRunRepairLoop: vi.fn(() => false),
  shouldAcceptRepair: vi.fn(),
  applyRankingEligibility: vi.fn((_query: string, candidates: unknown[]) => ({
    results: candidates,
    decisions: [],
    removedIds: [],
    threshold: null,
    reason: 'mocked',
    queryLabel: 'simple',
    triggered: false,
  })),
}));
vi.mock('../query-expansion.js', () => ({
  expandQueryViaEntities: vi.fn(),
  augmentQueryWithEntities: vi.fn(),
  coRetrieveByEntityNames: vi.fn(),
}));
vi.mock('../reranker.js', () => ({
  rerankCandidates: mockRerankCandidates,
}));
vi.mock('../retrieval-trace.js', () => ({
  TraceCollector: class {
    stage = mockTraceStage;
    event = vi.fn();
    finalize = vi.fn();
    setRetrievalSummary = vi.fn();
    setPackagingSummary = vi.fn();
    setAssemblySummary = vi.fn();
    getRetrievalSummary = vi.fn(() => undefined);
  },
}));
vi.mock('../abstract-query-policy.js', () => ({
  shouldUseAbstractHybridFallback: vi.fn(() => false),
}));
vi.mock('../agentic-retrieval.js', () => ({
  applyAgenticRetrieval: vi.fn(),
}));
vi.mock('../timing.js', () => ({
  timed: vi.fn(async (_name: string, fn: () => unknown) => fn()),
}));
vi.mock('../temporal-query-expansion.js', () => ({
  expandTemporalQuery: vi.fn(async () => ({ memories: [], keywords: [], anchorIds: [] })),
}));
vi.mock('../literal-query-expansion.js', () => ({
  expandLiteralQuery: vi.fn(async () => ({ memories: [], keywords: [] })),
  isLiteralDetailQuery: vi.fn(() => false),
}));
vi.mock('../subject-aware-ranking.js', () => ({
  expandSubjectQuery: vi.fn(async () => ({ memories: [], anchors: [] })),
  applySubjectAwareRanking: vi.fn((_query: string, results: unknown[]) => ({
    results,
    subjects: [],
    keywords: [],
    protectedFingerprints: [],
  })),
}));
vi.mock('../iterative-retrieval.js', () => ({
  applyIterativeRetrieval: vi.fn(),
}));
vi.mock('../current-state-ranking.js', () => ({
  applyCurrentStateRanking: vi.fn((_query: string, results: unknown[]) => ({
    triggered: false,
    results,
  })),
}));
vi.mock('../conciseness-preference.js', () => ({
  applyConcisenessPenalty: vi.fn((results: unknown[]) => results),
}));

const { runSearchPipelineWithTrace, generateLinks } = await import('../search-pipeline.js');

function twoLowSimilarityResults() {
  return [
    createSearchResult({ id: 'memory-1', score: 0.4, similarity: 0.4 }),
    createSearchResult({ id: 'memory-2', score: 0.39, similarity: 0.39 }),
  ];
}

function createStores(results: ReturnType<typeof createSearchResult>[]) {
  const search = { searchSimilar: vi.fn().mockResolvedValue(results) };
  const memory = { getMemory: vi.fn().mockResolvedValue(null) };
  const link = { findLinkCandidates: vi.fn().mockResolvedValue([]), createLinks: vi.fn().mockResolvedValue(0) };
  return { search, link, memory, entity: null, pool: {} } as any;
}

describe('runSearchPipelineWithTrace runtime config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.crossEncoderEnabled = true;
    mockConfig.crossEncoderModel = 'module-cross-encoder';
    mockConfig.crossEncoderDtype = 'q8';
    mockRerankCandidates.mockResolvedValue([]);
  });

  it('uses runtime config to disable cross-encoder reranking', async () => {
    const initialResults = twoLowSimilarityResults();
    const result = await runSearchPipelineWithTrace(
      createStores(initialResults), 'user-1', 'runtime config query', 2,
      undefined, undefined,
      { runtimeConfig: { ...mockConfig, crossEncoderEnabled: false } as any },
    );

    expect(result.filtered).toHaveLength(2);
    expect(mockRerankCandidates).not.toHaveBeenCalled();
  });

  it('uses runtime config to enable cross-encoder reranking even when module config disables it', async () => {
    mockConfig.crossEncoderEnabled = false;
    const initialResults = twoLowSimilarityResults();
    const rerankedResults = [...initialResults].reverse();
    mockRerankCandidates.mockResolvedValue(rerankedResults);

    const result = await runSearchPipelineWithTrace(
      createStores(initialResults), 'user-1', 'runtime config rerank query', 2,
      undefined, undefined,
      { runtimeConfig: { ...mockConfig, crossEncoderEnabled: true } as any },
    );

    expect(result.filtered).toEqual(rerankedResults);
    expect(mockRerankCandidates).toHaveBeenCalledWith(
      'runtime config rerank query',
      initialResults,
      { crossEncoderModel: 'module-cross-encoder', crossEncoderDtype: 'q8' },
    );
  });

  it('uses runtime config to enable agentic retrieval even when module config disables it', async () => {
    const initialResults = twoLowSimilarityResults();
    const agentic = await import('../agentic-retrieval.js');
    vi.mocked(agentic.applyAgenticRetrieval).mockResolvedValue({
      memories: initialResults, triggered: false, subQueries: [], reason: 'strong-initial-results',
    });

    await runSearchPipelineWithTrace(
      createStores(initialResults), 'user-1', 'runtime config agentic query', 2,
      undefined, undefined,
      { runtimeConfig: { ...mockConfig, agenticRetrievalEnabled: true, crossEncoderEnabled: false } as any },
    );

    expect(agentic.applyAgenticRetrieval).toHaveBeenCalled();
  });

  it('threads runtime reranker model and dtype through rerank and trace metadata', async () => {
    const initialResults = twoLowSimilarityResults();
    const rerankedResults = [...initialResults].reverse();
    mockRerankCandidates.mockResolvedValue(rerankedResults);
    const runtimeConfig = {
      ...mockConfig, crossEncoderModel: 'runtime-cross-encoder', crossEncoderDtype: 'fp16',
    } as any;

    await runSearchPipelineWithTrace(
      createStores(initialResults), 'user-1', 'runtime config query', 2,
      undefined, undefined, { runtimeConfig },
    );

    expect(mockRerankCandidates).toHaveBeenCalledWith(
      'runtime config query', initialResults,
      { crossEncoderModel: 'runtime-cross-encoder', crossEncoderDtype: 'fp16' },
    );
    expect(mockTraceStage).toHaveBeenCalledWith(
      'cross-encoder', rerankedResults,
      { model: 'runtime-cross-encoder', dtype: 'fp16' },
    );
  });

  it('does not auto-skip reranking for boost-heavy results with low semantic similarity', async () => {
    const initialResults = [
      createSearchResult({
        id: 'memory-1',
        score: 1.2,
        similarity: 0.4,
        semantic_similarity: 0.4,
      }),
      createSearchResult({
        id: 'memory-2',
        score: 1.0,
        similarity: 0.34,
        semantic_similarity: 0.34,
      }),
    ];
    mockRerankCandidates.mockResolvedValue(initialResults);

    await runSearchPipelineWithTrace(
      createStores(initialResults), 'user-1', 'low semantic similarity query', 2,
      undefined, undefined,
      { runtimeConfig: { ...mockConfig, crossEncoderEnabled: true } as any },
    );

    expect(mockRerankCandidates).toHaveBeenCalledOnce();
  });

  it('uses runtime config to enable link generation even when module config disables it', async () => {
    mockConfig.linkExpansionEnabled = false;
    const linkStores = {
      memory: { getMemory: vi.fn().mockResolvedValue({ id: 'memory-1' }) },
      link: {
        findLinkCandidates: vi.fn().mockResolvedValue([
          { id: 'linked-1', similarity: 0.77 },
        ]),
        createLinks: vi.fn().mockResolvedValue(1),
      },
      search: {}, entity: null, pool: {},
    } as any;

    const created = await generateLinks(
      linkStores,
      'user-1',
      ['memory-1'],
      new Map([['memory-1', [0.1, 0.2]]]),
      {
        linkExpansionEnabled: true,
        linkSimilarityThreshold: 0.42,
      },
    );

    expect(created).toBe(1);
    expect(linkStores.link.findLinkCandidates).toHaveBeenCalledWith(
      'user-1',
      [0.1, 0.2],
      0.42,
      'memory-1',
    );
    expect(linkStores.link.createLinks).toHaveBeenCalledWith([
      { sourceId: 'memory-1', targetId: 'linked-1', similarity: 0.77 },
    ]);
  });
});
