/**
 * Focused tests for the post-write processor extracted in Phase 4 Step 4A.
 *
 * Verifies the compositesEnabled boundary (composites are full-ingest-only),
 * backdate ordering, and link generation wiring.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGenerateLinks, mockBuildComposites } = vi.hoisted(() => ({
  mockGenerateLinks: vi.fn(),
  mockBuildComposites: vi.fn(),
}));

vi.mock('../search-pipeline.js', () => ({ generateLinks: mockGenerateLinks }));
vi.mock('../composite-grouping.js', () => ({
  buildComposites: mockBuildComposites,
}));
vi.mock('../namespace-retrieval.js', () => ({
  inferNamespace: vi.fn(() => 'test-ns'),
  deriveMajorityNamespace: vi.fn(() => 'test-ns'),
}));
vi.mock('../timing.js', () => ({
  timed: vi.fn(async (_name: string, fn: () => unknown) => fn()),
}));

const { runPostWriteProcessors } = await import('../ingest-post-write.js');

function makeDeps(overrides: Record<string, unknown> = {}) {
  const memory = {
    backdateMemories: vi.fn().mockResolvedValue(undefined),
    storeMemory: vi.fn().mockResolvedValue('composite-1'),
  };
  return {
    config: { compositeMinClusterSize: 2, ...overrides },
    repo: { ...memory, getPool: vi.fn().mockReturnValue({}) },
    stores: { memory, search: {}, link: {}, entity: null, lesson: null },
  } as any;
}

const baseFact = { fact: 'test', headline: 'h', importance: 0.5, keywords: ['k'], type: 'knowledge' as const, entities: [] as any[], relations: [] as any[] };

describe('runPostWriteProcessors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerateLinks.mockResolvedValue(2);
    mockBuildComposites.mockReturnValue([]);
  });

  it('backdates memories when sessionTimestamp is present', async () => {
    const deps = makeDeps();
    const ts = new Date('2026-04-17T00:00:00Z');
    await runPostWriteProcessors(deps, 'u1', {
      episodeId: 'ep1', sourceSite: 's', sourceUrl: '', storedFacts: [],
      memoryIds: ['m1'], embeddingCache: new Map(), sessionTimestamp: ts,
      compositesEnabled: false, timingPrefix: 'test',
    });
    expect(deps.repo.backdateMemories).toHaveBeenCalledWith(['m1'], ts);
  });

  it('skips backdate when sessionTimestamp is absent', async () => {
    const deps = makeDeps();
    await runPostWriteProcessors(deps, 'u1', {
      episodeId: 'ep1', sourceSite: 's', sourceUrl: '', storedFacts: [],
      memoryIds: ['m1'], embeddingCache: new Map(),
      compositesEnabled: false, timingPrefix: 'test',
    });
    expect(deps.repo.backdateMemories).not.toHaveBeenCalled();
  });

  it('returns link count from generateLinks', async () => {
    mockGenerateLinks.mockResolvedValue(5);
    const result = await runPostWriteProcessors(makeDeps(), 'u1', {
      episodeId: 'ep1', sourceSite: 's', sourceUrl: '', storedFacts: [],
      memoryIds: ['m1'], embeddingCache: new Map(),
      compositesEnabled: false, timingPrefix: 'test',
    });
    expect(result.linksCreated).toBe(5);
  });

  it('generates composites when compositesEnabled is true and above threshold', async () => {
    const emb = [0.1, 0.2];
    const cache = new Map([['m1', emb], ['m2', emb]]);
    const storedFacts = [
      { memoryId: 'm1', fact: { ...baseFact, fact: 'fact one' } },
      { memoryId: 'm2', fact: { ...baseFact, fact: 'fact two' } },
    ];
    mockBuildComposites.mockReturnValue([{
      content: 'composite', headline: 'h', overview: '', embedding: emb,
      importance: 0.5, keywords: ['k'], memberMemoryIds: ['m1', 'm2'],
    }]);
    const deps = makeDeps();
    const ts = new Date('2026-04-17T00:00:00Z');
    const result = await runPostWriteProcessors(deps, 'u1', {
      episodeId: 'ep1', sourceSite: 's', sourceUrl: '', storedFacts,
      memoryIds: ['m1', 'm2'], embeddingCache: cache,
      sessionTimestamp: ts, compositesEnabled: true, timingPrefix: 'test',
    });
    expect(result.compositesCreated).toBe(1);
    expect(deps.repo.storeMemory).toHaveBeenCalledTimes(1);
    expect(deps.repo.storeMemory).toHaveBeenCalledWith(expect.objectContaining({
      createdAt: ts,
      observedAt: ts,
    }));
  });

  it('skips composites when compositesEnabled is false even with storedFacts', async () => {
    const emb = [0.1, 0.2];
    const storedFacts = [
      { memoryId: 'm1', fact: { ...baseFact, fact: 'fact one' } },
      { memoryId: 'm2', fact: { ...baseFact, fact: 'fact two' } },
    ];
    const result = await runPostWriteProcessors(makeDeps(), 'u1', {
      episodeId: 'ep1', sourceSite: 's', sourceUrl: '', storedFacts,
      memoryIds: ['m1', 'm2'], embeddingCache: new Map([['m1', emb], ['m2', emb]]),
      compositesEnabled: false, timingPrefix: 'test',
    });
    expect(result.compositesCreated).toBe(0);
    expect(mockBuildComposites).not.toHaveBeenCalled();
  });

  it('skips composites when enabled but below minClusterSize threshold', async () => {
    const result = await runPostWriteProcessors(makeDeps(), 'u1', {
      episodeId: 'ep1', sourceSite: 's', sourceUrl: '',
      storedFacts: [{ memoryId: 'm1', fact: baseFact }],
      memoryIds: ['m1'], embeddingCache: new Map([['m1', [0.1]]]),
      compositesEnabled: true, timingPrefix: 'test',
    });
    expect(result.compositesCreated).toBe(0);
  });
});
