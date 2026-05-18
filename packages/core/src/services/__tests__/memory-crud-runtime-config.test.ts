/**
 * Runtime config seam tests for memory-crud consolidation delegation.
 *
 * Verifies that the service-layer CRUD helper forwards deps.config into the
 * consolidation execution seam instead of letting lineage fall back to the
 * module singleton.
 */

import { describe, expect, it, vi } from 'vitest';

const { mockExecuteConsolidation } = vi.hoisted(() => ({
  mockExecuteConsolidation: vi.fn().mockResolvedValue({
    clustersConsolidated: 0,
    memoriesArchived: 0,
    memoriesCreated: 0,
    consolidatedMemoryIds: [],
  }),
}));

vi.mock('../../config.js', () => ({
  config: {
    auditLoggingEnabled: false,
    decayRetentionThreshold: 0.5,
    decayMinAgeDays: 30,
  },
}));
vi.mock('../consolidation-service.js', () => ({
  findConsolidationCandidates: vi.fn(),
  executeConsolidation: mockExecuteConsolidation,
}));
vi.mock('../memory-lifecycle.js', () => ({
  evaluateDecayCandidates: vi.fn(),
  checkMemoryCap: vi.fn(),
}));
vi.mock('../audit-events.js', () => ({ emitAuditEvent: vi.fn() }));
vi.mock('../deferred-audn.js', () => ({
  shouldDeferAudn: vi.fn(),
  deferMemoryForReconciliation: vi.fn(),
  reconcileUser: vi.fn(),
  reconcileAll: vi.fn(),
  getReconciliationStatus: vi.fn(),
}));
vi.mock('../claim-slotting.js', () => ({
  buildPersistedRelationClaimSlot: vi.fn(),
}));

const { performExecuteConsolidation } = await import('../memory-crud.js');

describe('memory-crud runtime config seam', () => {
  it('passes deps.config into executeConsolidation', async () => {
    const memoryStore = { kind: 'memory-store' };
    const claimStore = { kind: 'claim-store' };
    const deps = {
      repo: { kind: 'repo' },
      claims: { kind: 'claims' },
      stores: { memory: memoryStore, claim: claimStore },
      config: { llmModel: 'runtime-llm' },
    } as any;

    await performExecuteConsolidation(deps, 'user-1');

    expect(mockExecuteConsolidation).toHaveBeenCalledWith(
      memoryStore,
      claimStore,
      'user-1',
      undefined,
      deps.config,
    );
  });
});
