/**
 * Tests that performIngest enqueues a reflection job after AUDN commits,
 * governed by the reflectEnabled flag and reflectionJobs dep.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockConsensusExtractFacts, mockStoreCanonicalFact } = vi.hoisted(() => ({
  mockConsensusExtractFacts: vi.fn(),
  mockStoreCanonicalFact: vi.fn(),
}));

vi.mock('../../config.js', () => ({
  config: {
    audnCandidateThreshold: 0.7,
    compositeGroupingEnabled: false,
    compositeMinClusterSize: 99,
    entropyGateAlpha: 0.4,
    entropyGateEnabled: false,
    entropyGateThreshold: 0.9,
    fastAudnEnabled: false,
    fastAudnDuplicateThreshold: 0.95,
  },
}));
vi.mock('../search-pipeline.js', () => ({ generateLinks: vi.fn().mockResolvedValue(0) }));
vi.mock('../quick-extraction.js', () => ({ quickExtractFacts: vi.fn(() => []) }));
vi.mock('../embedding.js', () => ({ embedText: vi.fn().mockResolvedValue([0.1, 0.2]) }));
vi.mock('../write-security.js', () => ({
  assessWriteSecurity: vi.fn(() => ({ allowed: true, trust: { score: 0.9 } })),
  recordRejectedWrite: vi.fn(),
}));
vi.mock('../memory-storage.js', () => ({
  resolveDeterministicClaimSlot: vi.fn().mockResolvedValue(null),
  findSlotConflictCandidates: vi.fn().mockResolvedValue([]),
  storeCanonicalFact: mockStoreCanonicalFact,
}));
vi.mock('../conflict-policy.js', () => ({
  mergeCandidates: vi.fn((v: unknown[], s: unknown[]) => [...v, ...s]),
  applyClarificationOverrides: vi.fn(),
}));
vi.mock('../timing.js', () => ({
  timed: vi.fn(async (_n: string, fn: () => unknown) => fn()),
}));
vi.mock('../consensus-extraction.js', () => ({ consensusExtractFacts: mockConsensusExtractFacts }));
vi.mock('../extraction-cache.js', () => ({ cachedResolveAUDN: vi.fn() }));
vi.mock('../memory-network.js', () => ({ classifyNetwork: vi.fn() }));
vi.mock('../namespace-retrieval.js', () => ({
  inferNamespace: vi.fn(),
  deriveMajorityNamespace: vi.fn(),
}));
vi.mock('../entropy-gate.js', () => ({ computeEntropyScore: vi.fn(() => ({ accepted: true })) }));
vi.mock('../composite-grouping.js', () => ({ buildComposites: vi.fn(() => []) }));
vi.mock('../memory-audn.js', () => ({
  findFilteredCandidates: vi.fn().mockResolvedValue([]),
  resolveAndExecuteAudn: vi.fn(),
}));

const { performIngest } = await import('../memory-ingest.js');

function makeDeps(overrides: Record<string, unknown> = {}) {
  const repo = {
    storeEpisode: vi.fn().mockResolvedValue('episode-abc'),
    backdateMemories: vi.fn(),
    getPool: vi.fn().mockReturnValue({}),
  };
  const stores = {
    memory: repo,
    episode: repo,
    search: repo,
    link: repo,
    representation: repo,
    claim: {},
    entity: null,
    lesson: null,
  };
  return {
    config: {
      audnCandidateThreshold: 0.7,
      auditLoggingEnabled: false,
      compositeGroupingEnabled: false,
      compositeMinClusterSize: 99,
      entityGraphEnabled: false,
      entropyGateEnabled: false,
      entropyGateAlpha: 0.4,
      entropyGateThreshold: 0.9,
      fastAudnEnabled: false,
      fastAudnDuplicateThreshold: 0.95,
      lessonsEnabled: false,
      llmModel: 'gpt-4o-mini',
      linkExpansionEnabled: false,
      linkSimilarityThreshold: 0.5,
      userProfileChannelEnabled: false,
      entityAttributesEnabled: false,
    },
    stores,
    observationService: null,
    uriResolver: {},
    ...overrides,
  } as any;
}

describe('memory-ingest enqueues reflection job', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConsensusExtractFacts.mockResolvedValue([
      {
        fact: 'User likes TypeScript',
        headline: 'Likes TypeScript',
        importance: 0.8,
        type: 'preference',
        keywords: ['typescript'],
        entities: [],
        relations: [],
      },
    ]);
    mockStoreCanonicalFact.mockResolvedValue({ outcome: 'stored', memoryId: 'memory-1' });
  });

  it('calls reflectionJobs.enqueue when reflectEnabled is true', async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      reflectEnabled: true,
      reflectionJobs: { enqueue },
    });

    await performIngest(deps, 'user-1', 'User: I like TypeScript', 'chat');

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith('user-1', 'episode-abc');
  });

  it('does NOT call enqueue when reflectEnabled is false', async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      reflectEnabled: false,
      reflectionJobs: { enqueue },
    });

    await performIngest(deps, 'user-1', 'User: I like TypeScript', 'chat');

    expect(enqueue).not.toHaveBeenCalled();
  });

  it('does NOT call enqueue when reflectionJobs is absent', async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({ reflectEnabled: true });
    // reflectionJobs intentionally not provided

    await performIngest(deps, 'user-1', 'User: I like TypeScript', 'chat');

    expect(enqueue).not.toHaveBeenCalled();
  });

  it('does not throw when enqueue rejects (failure is swallowed)', async () => {
    const enqueue = vi.fn().mockRejectedValue(new Error('DB down'));
    const deps = makeDeps({
      reflectEnabled: true,
      reflectionJobs: { enqueue },
    });

    await expect(
      performIngest(deps, 'user-1', 'User: I like TypeScript', 'chat'),
    ).resolves.toBeDefined();
  });
});
