/**
 * Regression coverage for GTM-1103 noisy context retrieval.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createFavoriteColorNoisyRetrievalFixture,
  createSearchResult,
} from './test-fixtures.js';

const {
  mockRunSearchPipelineWithTrace,
  mockResolveSearchLimitDetailed,
  mockClassifyQueryDetailed,
  mockResolveRecallBypass,
  mockEmbedText,
} = vi.hoisted(() => ({
  mockRunSearchPipelineWithTrace: vi.fn(),
  mockResolveSearchLimitDetailed: vi.fn(),
  mockClassifyQueryDetailed: vi.fn(),
  mockResolveRecallBypass: vi.fn(),
  mockEmbedText: vi.fn(),
}));

vi.mock('../search-pipeline.js', () => ({ runSearchPipelineWithTrace: mockRunSearchPipelineWithTrace }));
vi.mock('../retrieval-policy.js', () => ({
  resolveSearchLimitDetailed: mockResolveSearchLimitDetailed,
  classifyQueryDetailed: mockClassifyQueryDetailed,
  resolveRecallBypass: mockResolveRecallBypass,
}));
vi.mock('../embedding.js', () => ({ embedText: mockEmbedText }));
vi.mock('../composite-staleness.js', () => ({
  excludeStaleComposites: vi.fn(passthroughCompositeFilter),
}));
vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => true),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

const { performSearch, performWorkspaceSearch } = await import('../memory-search.js');
const { config } = await import('../../config.js');

const TEST_USER = 'retrieval-relevance-regression-user';
const DIRECT_FACT_PRECISION_FLOOR = 0.8;

describe('retrieval relevance regression', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClassifyQueryDetailed.mockImplementation(classifyFixtureQuery);
    mockResolveRecallBypass.mockImplementation((_query: string, label: string, context: { asOf?: string; referenceTime?: Date; sourceSite?: string }) => {
      if (context.asOf || context.referenceTime) return 'as-of-query';
      if (context.sourceSite) return 'source-site-filter';
      return ['complex', 'multi-hop', 'aggregation'].includes(label) ? `recall-oriented-${label}-query` : null;
    });
    mockEmbedText.mockResolvedValue([1, 0, 0]);
    mockResolveSearchLimitDetailed.mockImplementation((query: string, limit?: number) => ({
      limit: limit ?? 5,
      classification: classifyFixtureQuery(query),
    }));
  });

  it('keeps answer-bearing direct fact memory and filters unrelated high-score noise', async () => {
    const fixture = createFavoriteColorNoisyRetrievalFixture();
    const trace = createTrace(fixture.all.map((memory) => memory.id));
    mockRunSearchPipelineWithTrace.mockResolvedValue({ filtered: fixture.all, trace, queryEmbedding: [1, 0, 0] });

    const result = await performSearch(createDeps(0.5), {
      userId: TEST_USER,
      query: 'What is my favorite color?',
      limit: 5,
      retrievalOptions: { skipRepairLoop: true, skipReranking: true },
    });

    const ids = result.memories.map((memory) => memory.id);
    expect(ids).toEqual([fixture.answer.id]);
    expect(precisionAtK(ids, new Set([fixture.answer.id]))).toBeGreaterThanOrEqual(DIRECT_FACT_PRECISION_FLOOR);
    expect(result.injectionText).toContain('favorite color is teal');
    expect(result.injectionText).not.toContain('spicy ramen');
    expect(result.injectionText).not.toContain('Flight receipts');
  });

  it('uses caller threshold before packaging even when config threshold is loose', async () => {
    const fixture = createFavoriteColorNoisyRetrievalFixture();
    const borderline = createSearchResult({
      id: 'borderline-food-noise',
      content: 'The user prefers crunchy snacks.',
      similarity: 0.42,
      score: 0.99,
      importance: 1,
      source_site: 'manual',
    });
    const noisyResults = [fixture.answer, borderline, ...fixture.all.slice(1)];
    mockRunSearchPipelineWithTrace.mockResolvedValue({
      filtered: noisyResults,
      trace: createTrace(noisyResults.map((memory) => memory.id)),
      queryEmbedding: [1, 0, 0],
    });

    const result = await performSearch(createDeps(0.1), {
      userId: TEST_USER,
      query: 'What is my favorite color?',
      limit: 5,
      retrievalOptions: { relevanceThreshold: 0.5, skipRepairLoop: true, skipReranking: true },
    });

    expect(result.memories.map((memory) => memory.id)).toEqual([fixture.answer.id]);
  });

  it('documents source and namespace filter decisions in the retrieval trace', async () => {
    const fixture = createFavoriteColorNoisyRetrievalFixture();
    const trace = createTrace(fixture.all.map((memory) => memory.id));
    mockRunSearchPipelineWithTrace.mockResolvedValue({ filtered: fixture.all, trace, queryEmbedding: [1, 0, 0] });

    await performSearch(createDeps(0.5), {
      userId: TEST_USER,
      query: 'What is my favorite color?',
    });

    expect(trace.stage).toHaveBeenCalledWith(
      'relevance-filter',
      [expect.objectContaining({ id: fixture.answer.id, relevance: 0.91 })],
      expect.objectContaining({
        threshold: 0.5,
        removedIds: expect.arrayContaining([
          fixture.unrelatedFood.id,
          fixture.gmail.id,
          fixture.drive.id,
          fixture.x.id,
        ]),
        decisions: expect.arrayContaining([
          expect.objectContaining({
            id: fixture.gmail.id,
            sourceSite: 'integration-google',
            sourceKind: 'integration',
            namespace: 'site/integration-google',
            decision: 'filtered',
            reason: 'integration-below-threshold',
          }),
        ]),
      }),
    );
  });

  it('does not classify local sources by drive or twitter substrings', async () => {
    const driverBlog = createSearchResult({
      id: 'driver-blog-local',
      content: 'A local article mentions keyboard drivers.',
      similarity: 0.2,
      score: 0.99,
      source_site: 'driver-blog.com',
    });
    const twitterishLocal = createSearchResult({
      id: 'twitterish-local',
      content: 'A local archive happens to include twitter in its host name.',
      similarity: 0.2,
      score: 0.99,
      source_site: 'not-twitter.example',
    });
    const trace = createTrace([driverBlog.id, twitterishLocal.id]);
    mockRunSearchPipelineWithTrace.mockResolvedValue({ filtered: [driverBlog, twitterishLocal], trace });

    await performSearch(createDeps(0.5), {
      userId: TEST_USER,
      query: 'What is my favorite color?',
    });

    expect(trace.stage).toHaveBeenCalledWith(
      'relevance-filter',
      [],
      expect.objectContaining({
        decisions: expect.arrayContaining([
          expect.objectContaining({
            id: driverBlog.id,
            sourceKind: 'local',
            reason: 'below-threshold',
          }),
          expect.objectContaining({
            id: twitterishLocal.id,
            sourceKind: 'local',
            reason: 'below-threshold',
          }),
        ]),
      }),
    );
  });

  it('traces workspace relevance filtering decisions', async () => {
    const fixture = createFavoriteColorNoisyRetrievalFixture();
    const workspaceResults = [fixture.answer, fixture.drive];
    const deps = createDeps(0.5);
    deps.stores.search.searchSimilarInWorkspace = vi.fn().mockResolvedValue(workspaceResults);
    const previousTraceEnabled = config.retrievalTraceEnabled;
    config.retrievalTraceEnabled = true;

    try {
      const result = await performWorkspaceSearch(
        deps,
        TEST_USER,
        'What is my favorite color?',
        { workspaceId: 'workspace-1', agentId: 'agent-1' },
        { retrievalOptions: { relevanceThreshold: 0.5 } },
      );

      expect(result.memories.map((memory) => memory.id)).toEqual([fixture.answer.id]);
      expect(result.retrievalSummary).toMatchObject({
        relevanceThreshold: 0.5,
        relevanceFilterSource: 'request',
        filteredCandidateIds: [fixture.drive.id],
        filterDecisions: expect.arrayContaining([
          expect.objectContaining({
            id: fixture.drive.id,
            sourceKind: 'integration',
            reason: 'integration-below-threshold',
          }),
        ]),
        stageNames: expect.arrayContaining(['workspace-search', 'relevance-filter', 'final']),
      });
    } finally {
      config.retrievalTraceEnabled = previousTraceEnabled;
    }
  });

  it('preserves broad integration retrieval when no caller threshold is supplied', async () => {
    await expectRecallPreservedForQuery('List all synced integration memories');
  });

  it('preserves complex-query recall when no caller threshold is supplied', async () => {
    await expectRecallPreservedForQuery('Why did my synced context mention color palettes?');
  });
});

async function expectRecallPreservedForQuery(query: string) {
  const fixture = createFavoriteColorNoisyRetrievalFixture();
  mockRunSearchPipelineWithTrace.mockResolvedValue({
    filtered: fixture.all,
    trace: createTrace(fixture.all.map((memory) => memory.id)),
    queryEmbedding: [1, 0, 0],
  });

  const result = await performSearch(createDeps(0.5), { userId: TEST_USER, query });

  expect(result.memories.map((memory) => memory.id)).toEqual(fixture.all.map((memory) => memory.id));
}

function classifyFixtureQuery(query: string) {
  if (query.toLowerCase().includes('list all')) {
    return { limit: 25, label: 'aggregation', matchedMarker: 'list all' };
  }
  if (query.toLowerCase().startsWith('why')) {
    return { limit: 8, label: 'complex', matchedMarker: 'why' };
  }
  return { limit: 5, label: 'simple' };
}

async function passthroughCompositeFilter(_repo: unknown, _userId: string, memories: unknown[]) {
  return { filtered: memories, removedCompositeIds: [] };
}

function createTrace(candidateIds: string[]) {
  return {
    event: vi.fn(),
    stage: vi.fn(),
    finalize: vi.fn(),
    setPackagingSummary: vi.fn(),
    setAssemblySummary: vi.fn(),
    setRetrievalSummary: vi.fn(),
    getRetrievalSummary: vi.fn(() => ({
      candidateIds,
      candidateCount: candidateIds.length,
      queryText: 'What is my favorite color?',
      skipRepair: true,
    })),
  };
}

function createDeps(similarityThreshold: number) {
  const memory = { touchMemory: vi.fn().mockResolvedValue(undefined) };
  return {
    config: {
      auditLoggingEnabled: false,
      consensusMinMemories: 2,
      consensusValidationEnabled: false,
      lessonsEnabled: false,
      similarityThreshold,
    },
    stores: { memory, search: {}, link: {}, claim: {}, entity: null, lesson: null, pool: {} },
    observationService: null,
    uriResolver: { resolve: vi.fn().mockResolvedValue(null), format: vi.fn() },
  } as any;
}

function precisionAtK(resultIds: string[], relevantIds: Set<string>): number {
  if (resultIds.length === 0) return 0;
  return resultIds.filter((id) => relevantIds.has(id)).length / resultIds.length;
}
