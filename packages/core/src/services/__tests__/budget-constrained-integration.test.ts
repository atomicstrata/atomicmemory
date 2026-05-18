/**
 * Integration coverage for the `budget_constrained` contract.
 *
 * Exercises the real `performSearch` pipeline (mocking only the
 * search-pipeline / embedding boundaries, not the packaging
 * internals) so allocator + renderer + response-assembly all run
 * end-to-end. Verifies the cross-repo contract that downstream
 * consumers (TS SDK, Python SDK, route serializer) can rely on:
 *
 *   - excluded ids never appear in `memories`, `citations`, or
 *     `tierAssignments`
 *   - tight-budget tiered queries → `budgetConstrained: true`
 *   - generous budgets → `budgetConstrained: false`
 *   - unconstrained / non-allocator paths (flat, URI, undefined
 *     budget) report `false` honestly
 *   - quota-only demotion under huge budgets stays unflagged
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSearchResult } from './test-fixtures.js';
import type { SearchResult } from '../../db/repository-types.js';
import type { MemoryServiceDeps } from '../memory-service-types.js';

const stubs = vi.hoisted(() => ({
  pipeline: vi.fn(),
  resolveLimit: vi.fn(),
  classify: vi.fn(),
  recallBypass: vi.fn(),
  embed: vi.fn(),
}));

vi.mock('../search-pipeline.js', () => ({ runSearchPipelineWithTrace: stubs.pipeline }));
vi.mock('../retrieval-policy.js', () => ({
  resolveSearchLimitDetailed: stubs.resolveLimit,
  classifyQueryDetailed: stubs.classify,
  resolveRecallBypass: stubs.recallBypass,
}));
vi.mock('../embedding.js', () => ({ embedText: stubs.embed }));
const passthroughCompositeFilter = vi.hoisted(() =>
  vi.fn(async (_repo: unknown, _u: string, m: SearchResult[]) => ({ filtered: m, removedCompositeIds: [] as string[] })),
);
vi.mock('../composite-staleness.js', () => ({ excludeStaleComposites: passthroughCompositeFilter }));
vi.mock('node:fs', () => {
  const noop = () => undefined;
  return { existsSync: () => true, mkdirSync: noop, writeFileSync: noop };
});

const { performSearch } = await import('../memory-search.js');

const TEST_USER = 'budget-constrained-user';

beforeEach(() => {
  vi.clearAllMocks();
  const classification = { label: 'simple', matchedMarker: null };
  stubs.classify.mockReturnValue(classification);
  stubs.recallBypass.mockReturnValue(null);
  stubs.embed.mockResolvedValue([1, 0, 0]);
  stubs.resolveLimit.mockImplementation((_q: string, limit?: number) => ({ limit: limit ?? 5, classification }));
});

interface RunSearchOptions {
  retrievalMode?: 'flat' | 'tiered';
  tokenBudget?: number;
  deps?: MemoryServiceDeps;
  query?: string;
}

async function runSearch(memories: SearchResult[], options: RunSearchOptions) {
  stubs.pipeline.mockResolvedValue({ filtered: memories, trace: makeTrace(memories) });
  return performSearch(options.deps ?? createDeps(), {
    userId: TEST_USER,
    query: options.query ?? 'q',
    retrievalOptions: {
      retrievalMode: options.retrievalMode ?? 'tiered',
      tokenBudget: options.tokenBudget,
      skipRepairLoop: true,
      skipReranking: true,
    },
  });
}

describe('budget_constrained contract — integration', () => {
  it('tight tiered budget excludes tail and aligns memories/citations/tierAssignments', async () => {
    const memories = [
      makeMemory('top-keep', 'KEEP_A'.repeat(8), 0.9),
      makeMemory('mid-drop', 'DROP_B'.repeat(8), 0.8),
      makeMemory('tail-drop', 'DROP_C'.repeat(8), 0.7),
    ];
    const result = await runSearch(memories, { tokenBudget: 18 });

    expect(result.budgetConstrained).toBe(true);
    expect(result.memories.length).toBeLessThan(memories.length);
    const includedIds = new Set(result.memories.map((m) => m.id));
    expect(result.citations.every((id) => includedIds.has(id))).toBe(true);
    for (const a of result.tierAssignments ?? []) {
      expect(includedIds.has(a.memoryId)).toBe(true);
    }
  });

  it('generous tiered budget reports budgetConstrained=false', async () => {
    const memories = [makeMemory('a', 'short', 0.9), makeMemory('b', 'short', 0.8)];
    const result = await runSearch(memories, { tokenBudget: 100000 });
    expect(result.budgetConstrained).toBe(false);
    expect(result.memories).toHaveLength(memories.length);
  });

  it('flat mode reports budgetConstrained=false even with tight budget', async () => {
    const memories = [makeMemory('a', 'A'.repeat(80), 0.9), makeMemory('b', 'B'.repeat(80), 0.8)];
    const result = await runSearch(memories, { retrievalMode: 'flat', tokenBudget: 5 });
    expect(result.budgetConstrained).toBe(false);
  });

  it('undefined tokenBudget is unbounded and reports budgetConstrained=false', async () => {
    const result = await runSearch(
      [
        makeMemory('a', 'A'.repeat(4000), 0.9),
        makeMemory('b', 'B'.repeat(4000), 0.8),
        makeMemory('c', 'C'.repeat(4000), 0.7),
      ],
      {},
    );
    expect(result.budgetConstrained).toBe(false);
    expect(result.memories).toHaveLength(3);
    expect(result.assemblySummary?.tokenBudget).toBeNull();
  });

  it('quota-only demotion under huge budget is NOT flagged as budget-constrained', async () => {
    const memories = Array.from({ length: 8 }, (_, i) => makeMemory(`m${i}`, `s${i}`, 1 - i * 0.05));
    const result = await runSearch(memories, { tokenBudget: 1_000_000 });
    expect(result.budgetConstrained).toBe(false);
    expect(result.memories).toHaveLength(memories.length);
  });

  it('atomicmem:// URI path reports budgetConstrained=false (no allocator runs)', async () => {
    const memories = [makeMemory('uri-mem', 'content', 0.9)];
    const deps = createDepsWithUriResolver({
      resolve: vi.fn().mockResolvedValue({ data: memories, type: 'memory' }),
      format: vi.fn().mockReturnValue('uri injection text'),
    });
    const result = await runSearch([], { tokenBudget: 5, deps, query: 'atomicmem://memory/uri-mem' });
    expect(result.budgetConstrained).toBe(false);
    expect(stubs.pipeline).not.toHaveBeenCalled();
  });
});

function makeMemory(id: string, summary: string, score: number): SearchResult {
  return createSearchResult({
    id,
    content: `content for ${id}`,
    summary,
    overview: `overview for ${id}`,
    score,
    similarity: score,
    importance: 0.5,
    source_site: 'test',
    namespace: 'test',
  });
}

function makeTrace(memories: SearchResult[]) {
  return {
    stage: vi.fn(),
    event: vi.fn(),
    finalize: vi.fn(),
    setRetrievalSummary: vi.fn(),
    setPackagingSummary: vi.fn(),
    setAssemblySummary: vi.fn(),
    getRetrievalSummary: () => ({ candidateIds: memories.map((m) => m.id), candidateCount: memories.length, queryText: '', skipRepair: true }),
    getPackagingSummary: () => undefined,
    getAssemblySummary: () => undefined,
  };
}

interface UriResolverStub {
  resolve: ReturnType<typeof vi.fn>;
  format: ReturnType<typeof vi.fn>;
}

function createDeps(): MemoryServiceDeps {
  return createDepsWithUriResolver({
    resolve: vi.fn().mockResolvedValue(null),
    format: vi.fn(),
  });
}

// `MemoryServiceDeps` references several deeply-typed runtime interfaces
// (`CoreRuntimeConfig`, `CoreStores`) that this integration test mocks
// at the search/embedding boundary, not at the deps surface. The cast
// is the established pattern across the repo for tests that exercise
// pipeline behavior without rebuilding the full dependency graph.
function createDepsWithUriResolver(uriResolver: UriResolverStub): MemoryServiceDeps {
  return {
    config: {
      lessonsEnabled: false,
      consensusValidationEnabled: false,
      consensusMinMemories: 5,
      auditLoggingEnabled: false,
    },
    stores: {
      lesson: null,
      memory: { touchMemory: vi.fn().mockResolvedValue(undefined) },
      claim: { searchClaimVersions: vi.fn().mockResolvedValue([]) },
      search: {},
      link: {},
      entity: {},
      pool: {},
    },
    observationService: null,
    tllRepository: null,
    firstMentionService: null,
    uriResolver,
  } as unknown as MemoryServiceDeps;
}
