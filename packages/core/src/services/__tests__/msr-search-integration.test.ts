/**
 * Integration test for MSR cross-conversation aggregation in performSearch.
 *
 * Mocks the retrieval pipeline and the LLM provider, then exercises the full
 * `performSearch` orchestration with `MSR_AGGREGATOR_ENABLED=true`. Asserts
 * that the resulting `injectionText` contains a `## CROSS-SESSION SUMMARY`
 * channel produced by the aggregator.
 *
 * No DB and no network — everything outside memory-search.ts is mocked.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSearchResult } from './test-fixtures.js';

const {
  mockRunSearchPipelineWithTrace,
  mockResolveSearchLimitDetailed,
  mockClassifyQueryDetailed,
  mockResolveRecallBypass,
  mockEmbedText,
  mockLlmChat,
} = vi.hoisted(() => ({
  mockRunSearchPipelineWithTrace: vi.fn(),
  mockResolveSearchLimitDetailed: vi.fn(),
  mockClassifyQueryDetailed: vi.fn(),
  mockResolveRecallBypass: vi.fn(),
  mockEmbedText: vi.fn(),
  mockLlmChat: vi.fn(),
}));

vi.mock('../search-pipeline.js', () => ({
  runSearchPipelineWithTrace: mockRunSearchPipelineWithTrace,
}));
vi.mock('../retrieval-policy.js', () => ({
  resolveSearchLimitDetailed: mockResolveSearchLimitDetailed,
  classifyQueryDetailed: mockClassifyQueryDetailed,
  resolveRecallBypass: mockResolveRecallBypass,
}));
vi.mock('../embedding.js', () => ({ embedText: mockEmbedText }));
vi.mock('../composite-staleness.js', () => ({
  excludeStaleComposites: vi.fn(async (_repo, _userId, memories) => ({
    filtered: memories,
    removedCompositeIds: [],
  })),
}));
vi.mock('../llm.js', () => ({
  llm: { chat: mockLlmChat },
}));
vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => true),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
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
    getRetrievalSummary: vi.fn(() => ({
      candidateIds: [],
      candidateCount: 0,
      queryText: 'q',
      skipRepair: true,
    })),
  };
}

function createDeps(msrAggregatorEnabled: boolean) {
  return {
    config: {
      similarityThreshold: 0,
      auditLoggingEnabled: false,
      consensusMinMemories: 2,
      consensusValidationEnabled: false,
      lessonsEnabled: false,
      phase2SpecialistsEnabled: false,
      episodesChannelEnabled: false,
      userProfileChannelEnabled: false,
      entityAttributesEnabled: false,
      entityCardEnabled: false,
      contradictionSurfacingEnabled: false,
      abstentionRescueEnabled: false,
      confidencePrefixAdaptiveEnabled: false,
      msrAggregatorEnabled,
      llmModel: 'claude-haiku-4-5',
    },
    stores: {
      memory: { touchMemory: vi.fn().mockResolvedValue(undefined) },
      search: {},
      link: {},
      claim: {},
      entity: null,
      lesson: null,
      pool: {},
      recap: null,
      userProfile: null,
      entityAttributes: null,
      entityCards: null,
      contradictions: null,
    },
    observationService: null,
    uriResolver: { resolve: vi.fn().mockResolvedValue(null), format: vi.fn() },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const MSR_QUERY =
  'How many different features did I mention wanting to handle across my weather app conversations?';

describe('performSearch — MSR aggregator integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClassifyQueryDetailed.mockReturnValue({ label: 'aggregation' });
    mockResolveSearchLimitDetailed.mockReturnValue({
      limit: 10,
      classification: { label: 'aggregation', matchedMarker: 'how many' },
    });
    mockResolveRecallBypass.mockReturnValue('recall-oriented-aggregation-query');
    mockEmbedText.mockResolvedValue([1, 0, 0]);
  });

  it('inserts ## CROSS-SESSION SUMMARY when MSR detected and flag enabled', async () => {
    const memories = [
      createSearchResult({ id: 'm1', episode_id: 'conv-a', content: 'Wants forecast.', similarity: 0.9, score: 0.9 }),
      createSearchResult({ id: 'm2', episode_id: 'conv-a', content: 'Wants alerts.', similarity: 0.88, score: 0.88 }),
      createSearchResult({ id: 'm3', episode_id: 'conv-b', content: 'Wants graphs.', similarity: 0.85, score: 0.85 }),
    ];
    mockRunSearchPipelineWithTrace.mockResolvedValue({
      filtered: memories,
      trace: createTrace(),
      queryEmbedding: [1, 0, 0],
      chainResult: { chains: [] },
      reflections: [],
      questionType: 0,
    });
    mockLlmChat.mockResolvedValue('Discussed forecast and alerts.');

    const result = await performSearch(createDeps(true), { userId: 'user-1', query: MSR_QUERY });

    expect(result.injectionText).toContain('## CROSS-SESSION SUMMARY');
    expect(result.injectionText).toContain('## CONVERSATION 1 SUMMARY');
    expect(result.injectionText).toContain('Discussed forecast and alerts.');
    // conv-b had a single memory → verbatim pass-through, no second LLM call
    expect(result.injectionText).toContain('Wants graphs.');
    expect(mockLlmChat).toHaveBeenCalledTimes(1);
  });

  it('does NOT insert the channel when flag is disabled (default off)', async () => {
    const memories = [
      createSearchResult({ id: 'm1', episode_id: 'conv-a', content: 'Wants forecast.', similarity: 0.9, score: 0.9 }),
      createSearchResult({ id: 'm2', episode_id: 'conv-a', content: 'Wants alerts.', similarity: 0.88, score: 0.88 }),
    ];
    mockRunSearchPipelineWithTrace.mockResolvedValue({
      filtered: memories,
      trace: createTrace(),
      queryEmbedding: [1, 0, 0],
      chainResult: { chains: [] },
      reflections: [],
      questionType: 0,
    });

    const result = await performSearch(createDeps(false), { userId: 'user-1', query: MSR_QUERY });

    expect(result.injectionText).not.toContain('## CROSS-SESSION SUMMARY');
    expect(mockLlmChat).not.toHaveBeenCalled();
  });

  it('does NOT insert the channel when the query is not MSR (e.g. KU)', async () => {
    const memories = [
      createSearchResult({ id: 'm1', episode_id: 'conv-a', content: 'Latest dashboard version is 3.2.', similarity: 0.9, score: 0.9 }),
      createSearchResult({ id: 'm2', episode_id: 'conv-a', content: 'Dashboard was upgraded last week.', similarity: 0.88, score: 0.88 }),
    ];
    mockRunSearchPipelineWithTrace.mockResolvedValue({
      filtered: memories,
      trace: createTrace(),
      queryEmbedding: [1, 0, 0],
      chainResult: { chains: [] },
      reflections: [],
      questionType: 0,
    });

    const result = await performSearch(createDeps(true), {
      userId: 'user-1',
      query: "What's the latest version of my dashboard?",
    });

    expect(result.injectionText).not.toContain('## CROSS-SESSION SUMMARY');
    expect(mockLlmChat).not.toHaveBeenCalled();
  });
});
