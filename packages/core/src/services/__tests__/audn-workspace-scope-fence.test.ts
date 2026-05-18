/**
 * Regression fences for workspace scope threading through AUDN side branches.
 *
 * Verifies that the CLARIFY and opinion-confidence-collapse paths carry
 * workspace scope into their storeMemory calls, preventing workspace
 * facts from leaking into user-scoped needs_clarification rows.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockStoreCanonicalFact, mockStoreMemory, mockCachedResolveAUDN } = vi.hoisted(() => ({
  mockStoreCanonicalFact: vi.fn(),
  mockStoreMemory: vi.fn(),
  mockCachedResolveAUDN: vi.fn(),
}));

vi.mock('../embedding.js', () => ({ embedText: vi.fn().mockResolvedValue([0.1, 0.2]) }));
vi.mock('../memory-storage.js', () => ({
  storeCanonicalFact: mockStoreCanonicalFact,
  resolveDeterministicClaimSlot: vi.fn().mockResolvedValue(null),
  findSlotConflictCandidates: vi.fn().mockResolvedValue([]),
  applyEntityScopedDedup: vi.fn((_d, decision) => decision),
  ensureClaimTarget: vi.fn().mockResolvedValue({ claimId: 'c1', versionId: 'v1', memoryId: 'm1' }),
}));
vi.mock('../extraction-cache.js', () => ({ cachedResolveAUDN: mockCachedResolveAUDN }));
const { mockApplyClarificationOverrides } = vi.hoisted(() => ({
  mockApplyClarificationOverrides: vi.fn(),
}));
vi.mock('../conflict-policy.js', () => ({
  applyClarificationOverrides: mockApplyClarificationOverrides,
  mergeCandidates: vi.fn((...a: unknown[][]) => a.flat()),
}));
vi.mock('../timing.js', () => ({ timed: vi.fn(async (_n: string, fn: () => unknown) => fn()) }));
vi.mock('../memory-lineage.js', () => ({ emitLineageEvent: vi.fn().mockResolvedValue(null) }));
vi.mock('../deferred-audn.js', () => ({ shouldDeferAudn: vi.fn(() => false) }));
vi.mock('../../config.js', () => ({ config: {} }));

const { resolveAndExecuteAudn } = await import('../memory-audn.js');

const workspace = { workspaceId: 'ws-1', agentId: 'agent-1', visibility: 'workspace' as const };
const baseFact = {
  fact: 'test fact', headline: 'h', importance: 0.8,
  type: 'knowledge' as const, keywords: ['k'], entities: [], relations: [],
  opinionConfidence: null as number | null,
};

function makeDeps() {
  mockStoreMemory.mockResolvedValue('clarify-mem-1');
  return {
    config: { entityGraphEnabled: false, lessonsEnabled: false, fastAudnEnabled: false, fastAudnDuplicateThreshold: 0.95 },
    stores: {
      memory: {
        storeMemory: mockStoreMemory,
        getMemory: vi.fn(),
        updateOpinionConfidence: vi.fn(),
        expireMemory: vi.fn(),
        softDeleteMemory: vi.fn(),
        updateMemoryContent: vi.fn(),
        updateMemoryMetadata: vi.fn(),
      },
      search: {}, claim: {}, entity: null, lesson: null, representation: {
        replaceAtomicFactsForMemory: vi.fn(), replaceForesightForMemory: vi.fn(),
      },
    },
    repo: { getPool: vi.fn().mockReturnValue({}) },
    claims: {}, entities: null, lessons: null, observationService: null, uriResolver: {},
  } as any;
}

const candidates = [{ id: 'target-1', content: 'old fact', similarity: 0.85, importance: 0.5 }];

function makeTraceContext(
  fact = baseFact,
  logicalTimestamp?: Date,
  traceCandidates = candidates,
) {
  return {
    fact,
    logicalTimestamp,
    writeSecurity: { allowed: true, blockedBy: null, trust: { score: 0.9 } },
    candidates: traceCandidates.map((candidate) => ({
      id: candidate.id,
      similarity: candidate.similarity,
      contentPreview: candidate.content,
    })),
  };
}

describe('AUDN workspace scope fences', () => {
  beforeEach(() => vi.clearAllMocks());

  it('fast AUDN with no candidates falls through to normal ADD path', async () => {
    const deps = makeDeps();
    deps.config.fastAudnEnabled = true;
    const addDecision = {
      action: 'ADD' as const,
      targetMemoryId: null,
      updatedContent: null,
      contradictionConfidence: null,
    };
    mockCachedResolveAUDN.mockResolvedValue(addDecision);
    mockApplyClarificationOverrides.mockReturnValue(addDecision);
    mockStoreCanonicalFact.mockResolvedValue({ outcome: 'stored', memoryId: 'new-memory-1' });

    const result = await resolveAndExecuteAudn(
      deps, 'u1', baseFact, [0.1, 0.2], 'site', 'url', 'ep1',
      0.9, null, undefined, [], new Set(), workspace,
      makeTraceContext(baseFact, undefined, []),
    );

    expect(mockCachedResolveAUDN).toHaveBeenCalledWith(baseFact.fact, []);
    expect(mockStoreCanonicalFact).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ outcome: 'stored', memoryId: 'new-memory-1' });
  });

  it('CLARIFY branch carries workspace scope into storeMemory', async () => {
    const logicalTimestamp = new Date('2026-02-18T00:00:00.000Z');
    const clarifyDecision = {
      action: 'CLARIFY', targetMemoryId: 'target-1',
      clarificationNote: 'ambiguous', contradictionConfidence: 0.4,
    };
    mockCachedResolveAUDN.mockResolvedValue(clarifyDecision);
    mockApplyClarificationOverrides.mockReturnValue(clarifyDecision);

    await resolveAndExecuteAudn(
      makeDeps(), 'u1', baseFact, [0.1, 0.2], 'site', 'url', 'ep1',
      0.9, null, logicalTimestamp, candidates, new Set(), workspace,
      makeTraceContext(baseFact, logicalTimestamp),
    );

    expect(mockStoreMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-1',
        agentId: 'agent-1',
        visibility: 'workspace',
        status: 'needs_clarification',
        createdAt: logicalTimestamp,
        observedAt: logicalTimestamp,
      }),
    );
  });

  it('opinion-confidence-collapse carries workspace scope into storeMemory', async () => {
    const logicalTimestamp = new Date('2026-03-01T00:00:00.000Z');
    const deps = makeDeps();
    deps.stores.memory.getMemory.mockResolvedValue({
      id: 'target-1', network: 'opinion', opinion_confidence: 0.1,
    });
    const updateDecision = { action: 'UPDATE', targetMemoryId: 'target-1' };
    mockCachedResolveAUDN.mockResolvedValue(updateDecision);
    mockApplyClarificationOverrides.mockReturnValue(updateDecision);
    const opinionFact = { ...baseFact, network: 'opinion' as const };

    await resolveAndExecuteAudn(
      deps, 'u1', opinionFact, [0.1, 0.2], 'site', 'url', 'ep1',
      0.9, null, logicalTimestamp, candidates, new Set(), workspace,
      makeTraceContext(opinionFact, logicalTimestamp),
    );

    // Opinion confidence dropped to 0, so storeMemory carries needs_clarification.
    expect(mockStoreMemory).toHaveBeenCalledTimes(1);
    expect(mockStoreMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-1',
        agentId: 'agent-1',
        status: 'needs_clarification',
        createdAt: logicalTimestamp,
        observedAt: logicalTimestamp,
      }),
    );
  });
});
