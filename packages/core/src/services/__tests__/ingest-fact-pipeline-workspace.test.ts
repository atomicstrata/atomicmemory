/**
 * Behavioral fence for the workspace ingest path in processFactThroughPipeline.
 *
 * Phase 5 Step 10: workspace ingest now routes through storeCanonicalFact
 * and resolveAndExecuteAudn, gaining claim lineage, atomic facts, and
 * foresight projections. This test verifies the unified path works
 * correctly for workspace-scoped facts.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockStoreCanonicalFact, mockResolveAndExecuteAudn } = vi.hoisted(() => ({
  mockStoreCanonicalFact: vi.fn(),
  mockResolveAndExecuteAudn: vi.fn(),
}));

vi.mock('../embedding.js', () => ({
  embedText: vi.fn().mockResolvedValue([0.1, 0.2]),
}));
vi.mock('../write-security.js', () => ({
  assessWriteSecurity: vi.fn(() => ({ allowed: true, trust: { score: 0.9 } })),
  recordRejectedWrite: vi.fn(),
}));
vi.mock('../timing.js', () => ({
  timed: vi.fn(async (_name: string, fn: () => unknown) => fn()),
}));
vi.mock('../memory-storage.js', () => ({
  storeCanonicalFact: mockStoreCanonicalFact,
  resolveDeterministicClaimSlot: vi.fn().mockResolvedValue(null),
  findSlotConflictCandidates: vi.fn().mockResolvedValue([]),
}));
vi.mock('../memory-audn.js', () => ({
  findFilteredCandidates: vi.fn().mockResolvedValue([]),
  resolveAndExecuteAudn: mockResolveAndExecuteAudn,
}));
vi.mock('../conflict-policy.js', () => ({
  mergeCandidates: vi.fn((...args: unknown[][]) => args.flat()),
}));
vi.mock('../entropy-gate.js', () => ({
  computeEntropyScore: vi.fn(() => ({ accepted: true })),
}));

const { processFactThroughPipeline } = await import('../ingest-fact-pipeline.js');

const workspace = { workspaceId: 'ws-1', agentId: 'agent-1', visibility: 'workspace' as const };
const baseFact = {
  fact: 'User prefers Rust', headline: 'Prefers Rust', importance: 0.8,
  type: 'knowledge' as const, keywords: ['rust'], entities: [], relations: [],
  opinionConfidence: null,
};

function makeDeps() {
  const memory = {
    storeMemory: vi.fn().mockResolvedValue('ws-mem-1'),
    updateMemoryContent: vi.fn().mockResolvedValue(undefined),
    softDeleteMemory: vi.fn().mockResolvedValue(undefined),
  };
  const search = { findNearDuplicatesInWorkspace: vi.fn().mockResolvedValue([]) };
  return {
    config: { audnCandidateThreshold: 0.7 },
    repo: { ...memory, ...search },
    stores: { memory, search, claim: {}, entity: null, lesson: null, representation: {}, episode: {}, link: {} },
    claims: {},
    entities: null,
    lessons: null,
    observationService: null,
    uriResolver: {},
  } as any;
}

function makeOptions(overrides = {}) {
  return {
    workspace,
    entropyGate: false,
    fullAudn: true,
    supersededTargets: new Set<string>(),
    entropyCtx: { seenEntities: new Set<string>(), previousEmbedding: null },
    timingPrefix: 'ws-test',
    ...overrides,
  };
}

describe('processFactThroughPipeline — workspace path (Phase 5 Step 10)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStoreCanonicalFact.mockResolvedValue({ outcome: 'stored', memoryId: 'ws-mem-1' });
  });

  it('calls storeCanonicalFact with workspace context when no candidates', async () => {
    const result = await processFactThroughPipeline(
      makeDeps(), 'u1', baseFact, 'site', 'url', 'ep1', makeOptions(),
    );
    expect(result.outcome).toBe('stored');
    expect(mockStoreCanonicalFact).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ workspace }),
    );
  });

  it('routes to resolveAndExecuteAudn when candidates exist', async () => {
    const deps = makeDeps();
    deps.stores.search.findNearDuplicatesInWorkspace.mockResolvedValue([
      { id: 'existing', similarity: 0.9, content: 'old', importance: 0.5 },
    ]);
    mockResolveAndExecuteAudn.mockResolvedValue({ outcome: 'skipped', memoryId: null });

    const result = await processFactThroughPipeline(
      deps, 'u1', baseFact, 'site', 'url', 'ep1', makeOptions(),
    );
    expect(result.outcome).toBe('skipped');
    expect(mockResolveAndExecuteAudn).toHaveBeenCalledWith(
      expect.anything(), 'u1', baseFact, expect.any(Array),
      'site', 'url', 'ep1', 0.9, null, undefined,
      expect.any(Array), expect.any(Set), workspace,
      expect.objectContaining({
        fact: baseFact,
        writeSecurity: expect.objectContaining({ allowed: true }),
        candidates: expect.any(Array),
      }),
    );
  });

  it('passes workspace through to resolveAndExecuteAudn', async () => {
    const deps = makeDeps();
    deps.stores.search.findNearDuplicatesInWorkspace.mockResolvedValue([
      { id: 'existing', similarity: 0.85, content: 'old', importance: 0.5 },
    ]);
    mockResolveAndExecuteAudn.mockResolvedValue({ outcome: 'updated', memoryId: 'existing' });

    await processFactThroughPipeline(
      deps, 'u1', baseFact, 'site', 'url', 'ep1', makeOptions(),
    );
    const args = mockResolveAndExecuteAudn.mock.calls[0] ?? [];
    expect(args.at(-2)).toEqual(workspace);
    expect(args.at(-1)).toEqual(expect.objectContaining({
      fact: baseFact,
      writeSecurity: expect.objectContaining({ allowed: true }),
      candidates: [
        expect.objectContaining({ id: 'existing', similarity: 0.85 }),
      ],
    }));
  });
});
