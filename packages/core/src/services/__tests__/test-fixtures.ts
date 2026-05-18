/**
 * Shared test fixture factories for SearchResult, MemoryRow, and related types.
 *
 * Centralizes mock object construction so test files stay DRY and type-correct.
 * Every required field from the SearchResult/MemoryRow interfaces is included
 * in the defaults; tests override only the fields they care about.
 */

import type { MemoryRow, SearchResult } from '../../db/repository-types.js';

const DEFAULT_NOW = new Date('2026-03-27T00:00:00.000Z');

/** Shared base fields for both MemoryRow and SearchResult. */
function baseMemoryDefaults(): MemoryRow {
  return {
    id: 'test-id',
    user_id: 'test-user',
    content: 'test content',
    embedding: [],
    memory_type: 'semantic',
    importance: 0.5,
    source_site: 'test',
    source_url: '',
    episode_id: null,
    status: 'active',
    metadata: {},
    keywords: '',
    namespace: null,
    summary: '',
    overview: '',
    trust_score: 1.0,
    observed_at: DEFAULT_NOW,
    created_at: DEFAULT_NOW,
    last_accessed_at: DEFAULT_NOW,
    access_count: 0,
    expired_at: null,
    deleted_at: null,
    network: 'episodic',
    opinion_confidence: null,
    observation_subject: null,
  };
}

/** Build a fully typed SearchResult with sane defaults. Override any field. */
export function createSearchResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return { ...baseMemoryDefaults(), similarity: 0.8, score: 0.8, ...overrides };
}

/** Deterministic fixture for direct fact retrieval with noisy integrations. */
export function createFavoriteColorNoisyRetrievalFixture() {
  const answer = createSearchResult({
    id: 'favorite-color-answer',
    content: 'The user favorite color is teal.',
    similarity: 0.91,
    score: 0.91,
    source_site: 'manual',
    namespace: 'user/preferences',
  });
  const unrelatedFood = createNoiseMemory('unrelated-food-preference', 'The user likes spicy ramen.', 'manual');
  const gmail = createNoiseMemory('integration-gmail-noise', 'Flight receipts mention seat 14C.', 'integration-google');
  const drive = createNoiseMemory('integration-drive-noise', 'Quarterly planning doc mentions budget owners.', 'integration-drive');
  const x = createNoiseMemory('integration-x-noise', 'A saved X post mentions CSS color palettes.', 'integration-x');
  return { answer, unrelatedFood, gmail, drive, x, all: [answer, unrelatedFood, gmail, drive, x] };
}

function createNoiseMemory(id: string, content: string, sourceSite: string): SearchResult {
  return createSearchResult({
    id,
    content,
    similarity: 0.18,
    score: 0.98,
    importance: 1,
    source_site: sourceSite,
    namespace: `site/${sourceSite}`,
  });
}

/** Build a fully typed MemoryRow with sane defaults. Override any field. */
export function createMemoryRow(overrides: Partial<MemoryRow> = {}): MemoryRow {
  return { ...baseMemoryDefaults(), ...overrides };
}

/**
 * Create a session-packaging test memory with auto-incrementing ID.
 * Shared by session-packaging.test.ts and session-packaging-tiers.test.ts.
 */
let sessionMemoryCounter = 0;
export function createSessionTestMemory(
  prefix: string,
  overrides: { content: string; episode_id?: string | null; created_at?: Date },
): SearchResult {
  sessionMemoryCounter++;
  return createSearchResult({
    id: `${prefix}-${sessionMemoryCounter}`,
    content: overrides.content,
    memory_type: 'atomic',
    importance: 0.7,
    episode_id: overrides.episode_id ?? null,
    created_at: overrides.created_at ?? new Date('2023-01-15'),
    network: 'semantic',
    similarity: 0.8,
    score: 5.0,
  });
}

/** Reset the session memory counter (call in module scope or beforeEach). */
export function resetSessionMemoryCounter(start = 0): void {
  sessionMemoryCounter = start;
}

/**
 * Return the vi.mock factory object for '../../config.js' with
 * a minimal config for conflict-policy tests.
 */
export function createConflictPolicyConfigMockFactory() {
  return {
    config: {
      clarificationConflictThreshold: 0.8,
      audnSafeReuseMinSimilarity: 0.95,
    },
  };
}

/**
 * Return the vi.mock factory object for '../search-pipeline.js'.
 * The mockRunSearchPipelineWithTrace function is passed in since it must
 * be created in the test file via vi.hoisted to survive module hoisting.
 */
export function createSearchPipelineMockFactory(
  mockRunSearchPipelineWithTrace: (...args: unknown[]) => unknown,
) {
  return {
    runSearchPipelineWithTrace: (...args: unknown[]) => mockRunSearchPipelineWithTrace(...args),
    generateLinks: () => {},
  };
}

/**
 * Create a parameterized CandidateMemory factory with custom defaults.
 * Returns a function that merges overrides into those defaults.
 * Shared by audn-stability and conflict-policy test suites.
 */
export function createCandidateFactory(
  defaults: { id: string; content: string; similarity: number; importance: number },
) {
  return (overrides: Partial<{ id: string; content: string; similarity: number; importance: number }> = {}) => ({
    ...defaults,
    ...overrides,
  });
}

/**
 * Create a parameterized AUDNDecision factory with custom defaults.
 * Returns a function that merges overrides into those defaults.
 * Shared by audn-stability and conflict-policy test suites.
 */
export function createDecisionFactory(
  defaults: {
    action: string;
    targetMemoryId: string | null;
    updatedContent: string | null;
    contradictionConfidence: number | null;
    clarificationNote: string | null;
  },
) {
  return (overrides: Partial<typeof defaults> = {}) => ({
    ...defaults,
    ...overrides,
  });
}

/**
 * Create test context for search-pipeline mock tests (e.g. composite packaging,
 * stale retrieval). Returns the fake repo, claims, trace, service, and a
 * beforeEach callback that resets all mocks.
 */
function createSearchPipelineMockContext(mocks: {
  mockRunSearchPipelineWithTrace: import('vitest').Mock;
  mockTouchMemory: import('vitest').Mock;
  mockGetMemory: import('vitest').Mock;
  mockTraceStage: import('vitest').Mock;
  mockTraceEvent: import('vitest').Mock;
  mockTraceFinalize: import('vitest').Mock;
}) {
  const repo = {
    getMemory: (...args: unknown[]) => (mocks.mockGetMemory as Function)(...args),
    touchMemory: (...args: unknown[]) => (mocks.mockTouchMemory as Function)(...args),
    getPool: () => ({}),
  } as any;
  const claims = {} as any;
  const trace = {
    stage: mocks.mockTraceStage,
    event: mocks.mockTraceEvent,
    finalize: mocks.mockTraceFinalize,
    setRetrievalSummary: () => {},
    setPackagingSummary: () => {},
    setAssemblySummary: () => {},
    getRetrievalSummary: () => undefined,
    getPackagingSummary: () => undefined,
    getAssemblySummary: () => undefined,
  };

  /* Lazy-init service in beforeAll to avoid require() CJS resolution issues. */
  const ctx: { service: import('../memory-service.js').MemoryService } = {} as any;

  function resetMocks() {
    mocks.mockGetMemory.mockReset();
    mocks.mockTouchMemory.mockReset();
    mocks.mockRunSearchPipelineWithTrace.mockReset();
    mocks.mockTraceStage.mockReset();
    mocks.mockTraceEvent.mockReset();
    mocks.mockTraceFinalize.mockReset();
    mocks.mockTouchMemory.mockResolvedValue(undefined);
  }

  async function initService() {
    const { MemoryService } = await import('../memory-service.js');
    ctx.service = new MemoryService(repo, claims);
  }

  return {
    repo,
    claims,
    trace,
    get service() { return ctx.service; },
    resetMocks,
    initService,
  };
}

/**
 * Wire up a search pipeline mock context with standard beforeAll/beforeEach lifecycle.
 * Reduces boilerplate duplication across search-pipeline-based test files.
 */
export function setupSearchPipelineTest(
  mocks: Parameters<typeof createSearchPipelineMockContext>[0],
  hooks: {
    beforeAll: (fn: () => Promise<void>) => void;
    beforeEach: (fn: () => void) => void;
  },
) {
  const context = createSearchPipelineMockContext(mocks);
  hooks.beforeAll(async () => { await context.initService(); });
  hooks.beforeEach(() => { context.resetMocks(); });
  return context;
}
