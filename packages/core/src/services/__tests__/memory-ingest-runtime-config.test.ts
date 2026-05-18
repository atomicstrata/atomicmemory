/**
 * Runtime config seam tests for memory-ingest.
 *
 * Verifies that memory-ingest uses deps.config for the already-threaded
 * quick-ingest, entropy-gate, and composite-grouping seams.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockGenerateLinks,
  mockConsensusExtractFacts,
  mockComputeEntropyScore,
  mockBuildComposites,
  mockFindFilteredCandidates,
} = vi.hoisted(() => ({
  mockGenerateLinks: vi.fn(),
  mockConsensusExtractFacts: vi.fn(),
  mockComputeEntropyScore: vi.fn(),
  mockBuildComposites: vi.fn(),
  mockFindFilteredCandidates: vi.fn(),
}));
const { mockStoreCanonicalFact } = vi.hoisted(() => ({
  mockStoreCanonicalFact: vi.fn(),
}));

const moduleConfig = {
  audnCandidateThreshold: 0.7,
  compositeGroupingEnabled: false,
  compositeMinClusterSize: 99,
  entropyGateAlpha: 0.4,
  entropyGateEnabled: false,
  entropyGateThreshold: 0.9,
  fastAudnEnabled: false,
  fastAudnDuplicateThreshold: 0.95,
};

vi.mock('../../config.js', () => ({ config: moduleConfig }));
vi.mock('../search-pipeline.js', () => ({ generateLinks: mockGenerateLinks }));
vi.mock('../quick-extraction.js', () => ({
  quickExtractFacts: vi.fn(() => [
    {
      fact: 'User prefers Rust',
      headline: 'Prefers Rust',
      importance: 0.8,
      type: 'preference',
      keywords: ['rust'],
      entities: [],
      relations: [],
    },
  ]),
}));
vi.mock('../embedding.js', () => ({
  embedText: vi.fn().mockResolvedValue([0.1, 0.2]),
}));
vi.mock('../write-security.js', () => ({
  assessWriteSecurity: vi.fn(() => ({
    allowed: true,
    trust: { score: 0.9 },
  })),
  recordRejectedWrite: vi.fn(),
}));
vi.mock('../memory-storage.js', () => ({
  resolveDeterministicClaimSlot: vi.fn().mockResolvedValue(null),
  findSlotConflictCandidates: vi.fn().mockResolvedValue([]),
  storeCanonicalFact: mockStoreCanonicalFact,
}));
vi.mock('../conflict-policy.js', () => ({
  mergeCandidates: vi.fn((vectorCandidates: unknown[], slotCandidates: unknown[]) => [
    ...vectorCandidates,
    ...slotCandidates,
  ]),
  applyClarificationOverrides: vi.fn(),
}));
vi.mock('../timing.js', () => ({
  timed: vi.fn(async (_name: string, fn: () => unknown) => fn()),
}));
vi.mock('../consensus-extraction.js', () => ({
  consensusExtractFacts: mockConsensusExtractFacts,
}));
vi.mock('../extraction-cache.js', () => ({
  cachedResolveAUDN: vi.fn(),
}));
vi.mock('../memory-network.js', () => ({
  classifyNetwork: vi.fn(),
}));
vi.mock('../namespace-retrieval.js', () => ({
  inferNamespace: vi.fn(),
  deriveMajorityNamespace: vi.fn(),
}));
vi.mock('../entropy-gate.js', () => ({
  computeEntropyScore: mockComputeEntropyScore,
}));
vi.mock('../composite-grouping.js', () => ({
  buildComposites: mockBuildComposites,
}));
vi.mock('../memory-audn.js', () => ({
  findFilteredCandidates: mockFindFilteredCandidates,
  resolveAndExecuteAudn: vi.fn(),
}));

const { performIngest, performQuickIngest } = await import('../memory-ingest.js');

/** Add stores shim mirroring repo/claims for deps objects in these tests. */
function withStores(deps: Record<string, unknown>) {
  const repo = deps.repo as Record<string, unknown>;
  const repoWithPool = { ...repo, getPool: vi.fn().mockReturnValue({}) };
  return { ...deps, repo: repoWithPool, stores: { memory: repoWithPool, episode: repoWithPool, search: repoWithPool, link: repoWithPool, representation: repoWithPool, claim: deps.claims ?? {}, entity: deps.entities ?? null, lesson: deps.lessons ?? null } };
}

describe('memory-ingest runtime config seam', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerateLinks.mockResolvedValue(1);
    mockStoreCanonicalFact.mockResolvedValue({ outcome: 'stored', memoryId: 'memory-1' });
    mockConsensusExtractFacts.mockResolvedValue([
      {
        fact: 'User prefers Rust',
        headline: 'Prefers Rust',
        importance: 0.8,
        type: 'preference',
        keywords: ['rust'],
        entities: [],
        relations: [],
      },
    ]);
    mockComputeEntropyScore.mockReturnValue({ accepted: true });
    mockBuildComposites.mockReturnValue([]);
    mockFindFilteredCandidates.mockResolvedValue([]);
  });

  it('passes deps.config into generateLinks during quick ingest', async () => {
    const runtimeConfig = {
      linkExpansionEnabled: true,
      linkSimilarityThreshold: 0.42,
    };
    const repo = {
      storeEpisode: vi.fn().mockResolvedValue('episode-1'),
      findNearDuplicates: vi.fn().mockResolvedValue([]),
    };
    const deps = {
      config: runtimeConfig,
      repo,
      claims: {},
      entities: null,
      lessons: null,
      observationService: null,
      uriResolver: {},
    } as any;

    const result = await performQuickIngest(
      withStores(deps) as any,
      'user-1',
      'User: I prefer Rust',
      'chat',
    );

    expect(result.linksCreated).toBe(1);
    expect(mockGenerateLinks).toHaveBeenCalledWith(
      expect.objectContaining({ search: expect.any(Object) }),
      'user-1',
      ['memory-1'],
      new Map([['memory-1', [0.1, 0.2]]]),
      runtimeConfig,
    );
  });

  it('uses deps.config for duplicate thresholds in quick ingest', async () => {
    const runtimeConfig = {
      audnCandidateThreshold: 0.42,
      fastAudnEnabled: true,
      fastAudnDuplicateThreshold: 0.83,
      linkExpansionEnabled: false,
      linkSimilarityThreshold: 0.5,
    };
    const repo = {
      storeEpisode: vi.fn().mockResolvedValue('episode-1'),
      findNearDuplicates: vi.fn().mockResolvedValue([
        { id: 'existing-1', content: 'User prefers Rust', similarity: 0.9, importance: 0.8 },
      ]),
    };
    const deps = {
      config: runtimeConfig,
      repo,
      claims: {},
      entities: null,
      lessons: null,
      observationService: null,
      uriResolver: {},
    } as any;

    const result = await performQuickIngest(withStores(deps) as any, 'user-1', 'User: I prefer Rust', 'chat');

    expect(repo.findNearDuplicates).toHaveBeenCalledWith('user-1', [0.1, 0.2], 0.42);
    expect(result.memoriesSkipped).toBe(1);
    expect(result.memoryIds).toEqual(['existing-1']);
    expect(mockStoreCanonicalFact).not.toHaveBeenCalled();
  });

  it('uses deps.config for entropy gate parameters during ingest', async () => {
    const runtimeConfig = {
      audnCandidateThreshold: 0.42,
      auditLoggingEnabled: false,
      compositeGroupingEnabled: false,
      compositeMinClusterSize: 99,
      entityGraphEnabled: false,
      entropyGateAlpha: 0.73,
      entropyGateEnabled: true,
      entropyGateThreshold: 0.21,
      fastAudnEnabled: false,
      fastAudnDuplicateThreshold: 0.83,
      lessonsEnabled: false,
      llmModel: 'runtime-llm',
      linkExpansionEnabled: false,
      linkSimilarityThreshold: 0.5,
    };
    const repo = {
      storeEpisode: vi.fn().mockResolvedValue('episode-1'),
      backdateMemories: vi.fn(),
    };
    const deps = {
      config: runtimeConfig,
      repo,
      claims: {},
      entities: null,
      lessons: null,
      observationService: null,
      uriResolver: {},
    } as any;

    await performIngest(withStores(deps) as any, 'user-1', 'User: I prefer Rust', 'chat');

    expect(mockComputeEntropyScore).toHaveBeenCalledWith(
      expect.objectContaining({
        windowEntities: ['rust'],
        windowEmbedding: [0.1, 0.2],
      }),
      { threshold: 0.21, alpha: 0.73 },
    );
  });

  it('uses deps.config for composite grouping gate during ingest', async () => {
    const runtimeConfig = {
      audnCandidateThreshold: 0.42,
      auditLoggingEnabled: false,
      compositeGroupingEnabled: true,
      compositeMinClusterSize: 1,
      entityGraphEnabled: false,
      entropyGateAlpha: 0.73,
      entropyGateEnabled: false,
      entropyGateThreshold: 0.21,
      fastAudnEnabled: false,
      fastAudnDuplicateThreshold: 0.83,
      lessonsEnabled: false,
      llmModel: 'runtime-llm',
      linkExpansionEnabled: false,
      linkSimilarityThreshold: 0.5,
    };
    const repo = {
      storeEpisode: vi.fn().mockResolvedValue('episode-1'),
      backdateMemories: vi.fn(),
    };
    const deps = {
      config: runtimeConfig,
      repo,
      claims: {},
      entities: null,
      lessons: null,
      observationService: null,
      uriResolver: {},
    } as any;

    const result = await performIngest(withStores(deps) as any, 'user-1', 'User: I prefer Rust', 'chat');

    expect(mockBuildComposites).toHaveBeenCalledWith([
      expect.objectContaining({
        memoryId: 'memory-1',
        content: 'User prefers Rust',
      }),
    ]);
    expect(result.compositesCreated).toBe(0);
  });

  it('threads transcript session date into canonical fact storage', async () => {
    const deps = {
      config: {
        audnCandidateThreshold: 0.42,
        auditLoggingEnabled: false,
        compositeGroupingEnabled: false,
        entityGraphEnabled: false,
        entropyGateEnabled: false,
        fastAudnEnabled: false,
        fastAudnDuplicateThreshold: 0.83,
        lessonsEnabled: false,
        linkExpansionEnabled: false,
      },
      repo: { storeEpisode: vi.fn().mockResolvedValue('episode-1'), backdateMemories: vi.fn() },
      claims: {},
      entities: null,
      lessons: null,
      observationService: null,
      uriResolver: {},
    } as any;

    await performIngest(
      withStores(deps) as any,
      'user-1',
      '[Session date: 2023-08-15T16:20:00.000Z]\nUser: I prefer Rust',
      'chat',
    );

    expect(mockStoreCanonicalFact).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ logicalTimestamp: new Date('2023-08-15T16:20:00.000Z') }),
    );
  });
});
