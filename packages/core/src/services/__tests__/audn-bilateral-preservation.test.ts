/**
 * Unit tests for AUDN bilateral preservation (BEAM CR fix).
 *
 * Verifies that when `contradictionPreservationEnabled` is true, AUDN's
 * DELETE and SUPERSEDE outcomes route through the bilateral path:
 *   - the older memory is NOT soft-deleted / expired,
 *   - the new memory is stored,
 *   - both memories get contradiction flags via the contradictions store,
 *   - a `memory_contradictions` row is recorded,
 *   - the outcome is 'preserved_contradiction' with the new memory id,
 *   - mutations fail closed (errors propagate, never silent ADD).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createConflictPolicyConfigMockFactory } from './test-fixtures.js';

vi.mock('../../config.js', () => createConflictPolicyConfigMockFactory());

// Mock cross-module dependencies that the bilateral path does NOT itself
// exercise. The bilateral path calls `storeProjection` (memory-storage.js)
// and the contradictions store, plus `getMemoryIncludingDeleted`.
const {
  mockStoreProjection,
  mockEnsureClaimTarget,
  mockFindConflictCandidates,
  mockFindSlotConflictCandidates,
  mockApplyEntityScopedDedup,
} = vi.hoisted(() => ({
  mockStoreProjection: vi.fn(),
  mockEnsureClaimTarget: vi.fn(),
  mockFindConflictCandidates: vi.fn(),
  mockFindSlotConflictCandidates: vi.fn(),
  mockApplyEntityScopedDedup: vi.fn(),
}));

vi.mock('../memory-storage.js', () => ({
  storeCanonicalFact: vi.fn(),
  storeProjection: mockStoreProjection,
  applyEntityScopedDedup: mockApplyEntityScopedDedup,
  ensureClaimTarget: mockEnsureClaimTarget,
  findConflictCandidates: mockFindConflictCandidates,
  findSlotConflictCandidates: mockFindSlotConflictCandidates,
}));

vi.mock('../extraction-cache.js', () => ({
  cachedResolveAUDN: vi.fn(),
}));

vi.mock('../embedding.js', () => ({
  embedText: vi.fn().mockResolvedValue([0.1, 0.2]),
}));

vi.mock('../timing.js', () => ({
  timed: vi.fn(async (_n: string, fn: () => unknown) => fn()),
}));

vi.mock('../deferred-audn.js', () => ({
  shouldDeferAudn: vi.fn(() => false),
  deferMemoryForReconciliation: vi.fn(),
}));

vi.mock('../conflict-policy.js', () => ({
  mergeCandidates: vi.fn((a: unknown[], b: unknown[]) => [...a, ...b]),
  applyClarificationOverrides: vi.fn((d: unknown) => d),
}));

vi.mock('../memory-lineage.js', () => ({
  emitLineageEvent: vi.fn().mockResolvedValue({ cmoId: 'cmo-1', memoryId: 'm-new' }),
}));

vi.mock('../audit-events.js', () => ({
  emitAuditEvent: vi.fn(),
}));

vi.mock('../lesson-service.js', () => ({
  recordContradictionLesson: vi.fn(),
}));

vi.mock('../memcell-projection.js', () => ({
  buildAtomicFactProjection: vi.fn(),
  buildForesightProjections: vi.fn(() => []),
}));

const { executeAudnDecision } = await import('../audn-decision-executor.js');

interface FakeMemoryStore {
  getMemoryIncludingDeleted: ReturnType<typeof vi.fn>;
  expireMemory: ReturnType<typeof vi.fn>;
  softDeleteMemory: ReturnType<typeof vi.fn>;
  updateMemoryMetadata: ReturnType<typeof vi.fn>;
  getMemory: ReturnType<typeof vi.fn>;
}

interface FakeContradictions {
  record: ReturnType<typeof vi.fn>;
  markContradictionFlagsBilateral: ReturnType<typeof vi.fn>;
}

function makeDeps(
  opts: {
    preservationEnabled: boolean;
    withStore: boolean;
  },
) {
  const memory: FakeMemoryStore = {
    getMemoryIncludingDeleted: vi.fn().mockResolvedValue({
      id: 'm-old',
      content: 'User prefers TypeScript.',
      embedding: [0.1, 0.2],
    }),
    expireMemory: vi.fn(),
    softDeleteMemory: vi.fn(),
    updateMemoryMetadata: vi.fn(),
    getMemory: vi.fn().mockResolvedValue(null),
  };
  const contradictions: FakeContradictions | null = opts.withStore
    ? {
        record: vi.fn().mockResolvedValue('contradiction-uuid'),
        markContradictionFlagsBilateral: vi.fn(),
      }
    : null;
  return {
    memory,
    contradictions,
    deps: {
      config: {
        contradictionPreservationEnabled: opts.preservationEnabled,
        auditLoggingEnabled: false,
        lessonsEnabled: false,
        entityGraphEnabled: false,
      },
      stores: {
        memory,
        contradictions,
        claim: {},
        representation: {
          replaceAtomicFactsForMemory: vi.fn(),
          replaceForesightForMemory: vi.fn(),
          storeAtomicFacts: vi.fn(),
          storeForesight: vi.fn(),
        },
        entity: null,
        lesson: null,
      },
    } as unknown as Parameters<typeof executeAudnDecision>[0],
  };
}

const FACT = {
  fact: 'User prefers Python.',
  headline: 'Prefers Python',
  importance: 0.5,
  type: 'preference' as const,
  keywords: ['python'],
  entities: [],
  relations: [],
};

function makeCtx() {
  return {
    userId: 'u-1',
    fact: FACT,
    embedding: [0.1, 0.2],
    sourceSite: 'test',
    sourceUrl: '',
    episodeId: 'ep-1',
    trustScore: 1,
    claimSlot: null,
    logicalTimestamp: undefined,
  };
}

const DELETE_DECISION = {
  action: 'DELETE' as const,
  targetMemoryId: 'm-old',
  updatedContent: null,
  contradictionConfidence: 0.85,
};

const SUPERSEDE_DECISION = {
  action: 'SUPERSEDE' as const,
  targetMemoryId: 'm-old',
  updatedContent: null,
  contradictionConfidence: 0.9,
};

describe('AUDN bilateral preservation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnsureClaimTarget.mockResolvedValue({
      claimId: 'c-1', versionId: 'v-1', memoryId: 'm-old', cmoId: null,
    });
    mockStoreProjection.mockResolvedValue('m-new');
    mockApplyEntityScopedDedup.mockImplementation(async (_d, decision) => decision);
  });

  it('DELETE: keeps both rows, records contradiction, returns preserved_contradiction', async () => {
    const { deps, memory, contradictions } = makeDeps({
      preservationEnabled: true, withStore: true,
    });
    const result = await executeAudnDecision(
      deps, DELETE_DECISION, new Set(['m-old']), makeCtx(),
    );
    expect(result.outcome).toBe('preserved_contradiction');
    expect(result.memoryId).toBe('m-new');
    expect(memory.softDeleteMemory).not.toHaveBeenCalled();
    expect(memory.expireMemory).not.toHaveBeenCalled();
    expect(mockStoreProjection).toHaveBeenCalledTimes(1);
    expect(contradictions!.record).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'u-1', leftMemoryId: 'm-old', rightMemoryId: 'm-new',
      leftSummary: 'User prefers TypeScript.',
      rightSummary: 'User prefers Python.',
    }));
    expect(contradictions!.markContradictionFlagsBilateral).toHaveBeenCalledWith(
      'u-1', 'm-old', 'm-new',
    );
  });

  it('SUPERSEDE: keeps both rows, records contradiction', async () => {
    const { deps, memory, contradictions } = makeDeps({
      preservationEnabled: true, withStore: true,
    });
    const result = await executeAudnDecision(
      deps, SUPERSEDE_DECISION, new Set(['m-old']), makeCtx(),
    );
    expect(result.outcome).toBe('preserved_contradiction');
    expect(memory.expireMemory).not.toHaveBeenCalled();
    expect(memory.softDeleteMemory).not.toHaveBeenCalled();
    expect(contradictions!.record).toHaveBeenCalledTimes(1);
  });

  it('falls through to legacy DELETE when flag is off', async () => {
    const { deps, memory, contradictions } = makeDeps({
      preservationEnabled: false, withStore: true,
    });
    const result = await executeAudnDecision(
      deps, DELETE_DECISION, new Set(['m-old']), makeCtx(),
    );
    expect(result.outcome).toBe('deleted');
    expect(memory.softDeleteMemory).toHaveBeenCalledWith('u-1', 'm-old');
    expect(contradictions!.record).not.toHaveBeenCalled();
  });

  it('falls through to legacy DELETE when contradictions store is missing', async () => {
    const { deps, memory } = makeDeps({
      preservationEnabled: true, withStore: false,
    });
    const result = await executeAudnDecision(
      deps, DELETE_DECISION, new Set(['m-old']), makeCtx(),
    );
    expect(result.outcome).toBe('deleted');
    expect(memory.softDeleteMemory).toHaveBeenCalledWith('u-1', 'm-old');
  });

  it('fails closed when target memory cannot be found', async () => {
    const { deps, memory } = makeDeps({
      preservationEnabled: true, withStore: true,
    });
    memory.getMemoryIncludingDeleted.mockResolvedValueOnce(null);
    await expect(
      executeAudnDecision(deps, DELETE_DECISION, new Set(['m-old']), makeCtx()),
    ).rejects.toThrow(/target memory m-old not found/);
  });

  it('fails closed when storeProjection returns no id', async () => {
    const { deps } = makeDeps({
      preservationEnabled: true, withStore: true,
    });
    mockStoreProjection.mockResolvedValueOnce(null);
    await expect(
      executeAudnDecision(deps, DELETE_DECISION, new Set(['m-old']), makeCtx()),
    ).rejects.toThrow(/storeProjection returned no id/);
  });
});
