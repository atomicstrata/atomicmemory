/**
 * Integration test: TLL chain augmentation end-to-end through `performSearch`.
 *
 * Drives a `shouldUseTLL`-positive query past the relevance gate so
 * `appendTllAugmentation` actually fires, then asserts the response
 * renders without throwing and the augmented row carries the expected
 * shape. Catches the class of bug where `hydrateChainMemories` returns a
 * partial `SearchResult` that crashes downstream formatters
 * (`retrieval-format.ts buildCommonAttrs` calls `.toFixed()` on
 * `similarity` and `score`).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSearchResult } from './test-fixtures.js';

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
  excludeStaleComposites: vi.fn(async (_repo: unknown, _userId: string, memories: unknown[]) => ({
    filtered: memories,
    removedCompositeIds: [],
  })),
}));
vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => true),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

const { performSearch } = await import('../memory-search.js');
const { buildInjection } = await import('../retrieval-format.js');

const TEST_USER = 'tll-augmentation-integration-user';
const SEED_ID = '11111111-1111-1111-1111-111111111111';
const CHAIN_ID = '22222222-2222-2222-2222-222222222222';
const CHAIN_ID_A = '22222222-2222-2222-2222-22222222222a';
const CHAIN_ID_B = '22222222-2222-2222-2222-22222222222b';
const CHAIN_ID_C = '22222222-2222-2222-2222-22222222222c';
const WORKSPACE_LEAK_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const WORKSPACE_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const ENTITY_ID = '33333333-3333-3333-3333-333333333333';
const ORDERING_QUERY = 'what is the history of my editor preferences';

beforeEach(() => {
  vi.clearAllMocks();
  mockClassifyQueryDetailed.mockReturnValue({ limit: 5, label: 'simple' });
  mockResolveRecallBypass.mockReturnValue(null);
  mockEmbedText.mockResolvedValue([1, 0, 0]);
  mockResolveSearchLimitDetailed.mockReturnValue({ limit: 5, classification: { limit: 5, label: 'simple' } });
});

describe('TLL augmentation through performSearch', () => {
  it('renders augmented chain rows through buildInjection without throwing', async () => {
    const seed = createSearchResult({ id: SEED_ID, content: 'switched to vim', similarity: 0.91, score: 0.91 });
    mockRunSearchPipelineWithTrace.mockResolvedValue({
      filtered: [seed],
      trace: createTrace([SEED_ID]),
    });

    const result = await performSearch(createDeps({ chainIds: [CHAIN_ID] }, 0.65), {
      userId: TEST_USER,
      query: ORDERING_QUERY,
    });

    const ids = result.memories.map((m) => m.id);
    expect(ids).toContain(SEED_ID);
    expect(ids).toContain(CHAIN_ID);
    const chainRow = result.memories.find((m) => m.id === CHAIN_ID);
    expect(chainRow?.retrieval_signal).toBe('tll-chain');
    expect(typeof chainRow?.similarity).toBe('number');
    expect(typeof chainRow?.score).toBe('number');
    expect(typeof chainRow?.source_site).toBe('string');
    expect(() => buildInjection(result.memories, ORDERING_QUERY, 'flat')).not.toThrow();
  });

  it('issues a hydration query that preserves input order via unnest WITH ORDINALITY', async () => {
    // Order preservation in production comes from `ORDER BY req.ord` in
    // the SQL; the repo-level tests verify chronological ordering against
    // a real DB. This test asserts the contract is encoded in the SQL —
    // i.e. that hydrateChainMemories joins against an ORDINALITY unnest
    // and orders by it. Without that clause, `WHERE id = ANY(...)` would
    // return rows in arbitrary DB order regardless of caller intent.
    const seed = createSearchResult({ id: SEED_ID, content: 'switched editors', similarity: 0.91, score: 0.91 });
    mockRunSearchPipelineWithTrace.mockResolvedValue({
      filtered: [seed],
      trace: createTrace([SEED_ID]),
    });
    const deps = createDeps({ chainIds: [CHAIN_ID_A, CHAIN_ID_B, CHAIN_ID_C] }, 0.65);

    await performSearch(deps, { userId: TEST_USER, query: ORDERING_QUERY });

    const hydrateCall = deps.stores.pool.query.mock.calls.find(
      ([sql]: [string]) => /JOIN\s+memories/i.test(sql),
    );
    expect(hydrateCall).toBeDefined();
    expect(hydrateCall?.[0]).toMatch(/unnest\(\s*\$2::uuid\[\]\s*\)\s+WITH\s+ORDINALITY/i);
    expect(hydrateCall?.[0]).toMatch(/ORDER\s+BY\s+req\.ord/i);
  });

  it('drops workspace-scoped memories from the global TLL augmentation path', async () => {
    const seed = createSearchResult({ id: SEED_ID, content: 'used vim', similarity: 0.91, score: 0.91 });
    mockRunSearchPipelineWithTrace.mockResolvedValue({
      filtered: [seed],
      trace: createTrace([SEED_ID]),
    });

    const result = await performSearch(
      createDeps({ chainIds: [WORKSPACE_LEAK_ID, CHAIN_ID], leakWorkspaceId: WORKSPACE_ID }, 0.65),
      { userId: TEST_USER, query: ORDERING_QUERY },
    );

    const ids = result.memories.map((m) => m.id);
    expect(ids).not.toContain(WORKSPACE_LEAK_ID);
    expect(ids).toContain(CHAIN_ID);
  });

  it('survives a high caller-supplied relevanceThreshold (chain-membership bypass)', async () => {
    // Augmented rows are appended after `applySearchRelevanceFilter`, so
    // they don't pass through the gate today. Defensive `relevance: 1.0`
    // on hydrated rows locks in the bypass invariant against future
    // filter drift — even if a downstream filter starts checking
    // `memory.relevance >= threshold`, chain rows survive.
    // Seed must survive the gate so augmentation runs; the assertion is
    // about the augmented row carrying relevance: 1.0, regardless of how
    // strict the caller's threshold is.
    const seed = createSearchResult({ id: SEED_ID, content: 'switched to vim', similarity: 1.0, score: 1.0 });
    mockRunSearchPipelineWithTrace.mockResolvedValue({
      filtered: [seed],
      trace: createTrace([SEED_ID]),
    });

    const result = await performSearch(createDeps({ chainIds: [CHAIN_ID] }, 0.65), {
      userId: TEST_USER,
      query: ORDERING_QUERY,
      retrievalOptions: { relevanceThreshold: 0.99 },
    });

    const chainRow = result.memories.find((m) => m.id === CHAIN_ID);
    expect(chainRow?.retrieval_signal).toBe('tll-chain');
    expect(chainRow?.relevance).toBe(1.0);
  });

  it('does not augment for non-TLL queries even with a populated chain', async () => {
    const seed = createSearchResult({ id: SEED_ID, content: 'I use vim', similarity: 0.91, score: 0.91 });
    mockRunSearchPipelineWithTrace.mockResolvedValue({
      filtered: [seed],
      trace: createTrace([SEED_ID]),
    });

    const result = await performSearch(createDeps({ chainIds: [CHAIN_ID] }, 0.65), {
      userId: TEST_USER,
      query: 'what editor do I use',
    });

    expect(result.memories.map((m) => m.id)).toEqual([SEED_ID]);
  });
});

function createTrace(candidateIds: string[]) {
  return {
    event: vi.fn(),
    stage: vi.fn(),
    finalize: vi.fn(),
    setPackagingSummary: vi.fn(),
    setAssemblySummary: vi.fn(),
    setRetrievalSummary: vi.fn(),
    getRetrievalSummary: vi.fn(() => ({
      candidateIds, candidateCount: candidateIds.length, queryText: ORDERING_QUERY, skipRepair: true,
    })),
  };
}

interface DepsOptions {
  /** Memory IDs `chainsFor` returns; hydrate must preserve this order. */
  chainIds: string[];
  /**
   * If set, the row at the head of `chainIds` is hydrated with this
   * `workspace_id` to verify the global path's `workspace_id IS NULL`
   * filter drops it.
   */
  leakWorkspaceId?: string;
}

/**
 * Build a deps object whose pool stub services both queries the TLL
 * augmentation path makes:
 *   1. `entitiesForMemories` — `SELECT DISTINCT entity_id FROM memory_entities ...`
 *   2. `hydrateChainMemories` — `SELECT m.* FROM unnest(...) JOIN memories m ...
 *      WHERE ... AND m.workspace_id IS NULL ORDER BY req.ord`
 *
 * The hydration stub honors both invariants under test: workspace
 * isolation (drops rows whose `workspace_id` is non-null when the SQL
 * filter is present) and ordering (matches input array order).
 */
function createDeps(options: DepsOptions, similarityThreshold: number) {
  const tllRepository = {
    chainsFor: vi.fn(async (_userId: string, _entityIds: string[]) => options.chainIds),
  };
  const pool = {
    query: vi.fn(async (sql: string, params: unknown[]) => {
      if (/FROM\s+memory_entities/i.test(sql)) return { rows: [{ entity_id: ENTITY_ID }] };
      if (/JOIN\s+memories/i.test(sql)) return { rows: hydrateRows(sql, params, options) };
      return { rows: [] };
    }),
  };
  return {
    config: {
      auditLoggingEnabled: false,
      consensusMinMemories: 2,
      consensusValidationEnabled: false,
      lessonsEnabled: false,
      similarityThreshold,
    },
    stores: {
      memory: { touchMemory: vi.fn().mockResolvedValue(undefined) },
      search: {}, link: {}, claim: {}, entity: null, lesson: null,
      pool,
    },
    observationService: null,
    tllRepository,
    firstMentionService: null,
    uriResolver: { resolve: vi.fn().mockResolvedValue(null), format: vi.fn() },
  } as any;
}

function hydrateRows(sql: string, params: unknown[], options: DepsOptions): Record<string, unknown>[] {
  // Real Postgres receives `unnest($2::uuid[]) WITH ORDINALITY` here; the
  // stub mirrors that contract by reading the requested ids from $2 and
  // returning corresponding fixture rows.
  const requestedIds = (params[1] as string[]) ?? [];
  const filtersWorkspace = /workspace_id\s+IS\s+NULL/i.test(sql);
  const rows: Record<string, unknown>[] = [];
  for (const id of requestedIds) {
    const isWorkspace = options.leakWorkspaceId !== undefined && id === requestedIds[0];
    if (isWorkspace && filtersWorkspace) continue;
    rows.push(makeMemoryRowFixture(id, `chain-content-${id.slice(-1)}`, isWorkspace ? options.leakWorkspaceId : null));
  }
  return rows;
}

/** Plain object shaped like a `memories` row — `normalizeMemoryRow` finishes the job. */
function makeMemoryRowFixture(id: string, content: string, workspaceId: string | null = null): Record<string, unknown> {
  const now = new Date('2026-04-01T00:00:00.000Z');
  return {
    id, user_id: TEST_USER, content, embedding: '[0.1,0.2,0.3]',
    memory_type: 'semantic', importance: 0.5, source_site: 'manual', source_url: '',
    episode_id: null, status: 'active', metadata: '{}', keywords: '', namespace: null,
    summary: '', overview: '', trust_score: 1.0,
    observed_at: now, created_at: now, last_accessed_at: now, access_count: 0,
    expired_at: null, deleted_at: null, network: 'experience',
    opinion_confidence: null, observation_subject: null,
    workspace_id: workspaceId, agent_id: null, visibility: null,
  };
}
