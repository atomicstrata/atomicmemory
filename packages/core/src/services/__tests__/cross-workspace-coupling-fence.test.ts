/**
 * Cross-workspace coupling regression fence.
 *
 * Phase 5 routed workspace ingest through canonical lineage, but claim slots,
 * entities, and entity relations remain user-scoped. This is intentional for
 * Phase 5 — cross-workspace AUDN reconciliation is a Phase 6 concern.
 *
 * This test uses stateful in-memory fakes (not unit-level mocks) and runs the
 * real storeCanonicalFact path twice with two distinct workspace contexts for
 * the same user. It then asserts that the second workspace write resolved
 * against entity state created by the first — proving the cross-workspace
 * coupling behaviorally, not just by signature inspection.
 *
 * When Phase 6 introduces workspace_id on entities, this test will start
 * failing and must be updated to assert scope isolation instead.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryServiceDeps, AudnFactContext } from '../memory-service-types.js';
import type { WorkspaceContext, EntityRow } from '../../db/repository-types.js';

const { mockEmitLineageEvent } = vi.hoisted(() => ({ mockEmitLineageEvent: vi.fn() }));

vi.mock('../memory-lineage.js', () => ({ emitLineageEvent: mockEmitLineageEvent }));
vi.mock('../embedding.js', () => ({
  embedText: vi.fn().mockResolvedValue([0.1, 0.2]),
  embedTexts: vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2])),
}));
vi.mock('../namespace-retrieval.js', () => ({
  classifyNamespace: vi.fn().mockResolvedValue(null),
  inferNamespace: vi.fn(() => null),
  deriveMajorityNamespace: vi.fn(() => null),
}));
vi.mock('../memory-network.js', () => ({
  classifyNetwork: vi.fn(() => ({ network: 'factual' })),
}));
vi.mock('../tiered-context.js', () => ({
  generateL1Overview: vi.fn(() => ''),
}));
vi.mock('../audit-events.js', () => ({ emitAuditEvent: vi.fn() }));
vi.mock('../../config.js', () => ({ config: {} }));

const { storeCanonicalFact } = await import('../memory-storage.js');

/** Stateful in-memory entity store. Mimics user-scoped resolution semantics. */
function createStatefulEntityStore() {
  let nextId = 1;
  const entitiesByKey = new Map<string, EntityRow>();
  const memoryLinks: Array<{ memoryId: string; entityId: string }> = [];
  const resolveInputs: unknown[] = [];

  const keyFor = (userId: string, type: string, name: string) =>
    `${userId}::${type}::${name.toLowerCase()}`;

  return {
    store: {
      async resolveEntity(input: { userId: string; name: string; entityType: string; embedding: number[] } & Record<string, unknown>) {
        resolveInputs.push(input);
        const k = keyFor(input.userId, input.entityType, input.name);
        let entity = entitiesByKey.get(k);
        if (!entity) {
          entity = { id: `entity-${nextId++}`, user_id: input.userId, name: input.name, entity_type: input.entityType } as EntityRow;
          entitiesByKey.set(k, entity);
        }
        return entity.id;
      },
      async linkMemoryToEntity(memoryId: string, entityId: string) {
        memoryLinks.push({ memoryId, entityId });
      },
      async upsertRelation() { /* no-op for this test */ },
      async findDeterministicEntity() { return null; },
      async getRelationsForMemory() { return []; },
    } as any,
    /** Inspect the entity map directly. */
    getEntityIds: () => Array.from(entitiesByKey.values()).map((e) => e.id),
    getEntityKeys: () => Array.from(entitiesByKey.keys()),
    getMemoryLinks: () => memoryLinks,
    getResolveInputs: () => resolveInputs,
  };
}

function makeDeps(entityStore: any): MemoryServiceDeps {
  return {
    config: {
      entityGraphEnabled: true, auditLoggingEnabled: false,
      namespaceClassificationEnabled: false, lessonsEnabled: false,
    } as any,
    stores: {
      memory: {
        storeMemory: vi.fn(async () => `memory-${Math.random().toString(36).slice(2, 8)}`),
      },
      representation: {
        storeAtomicFacts: vi.fn().mockResolvedValue([]),
        storeForesight: vi.fn().mockResolvedValue([]),
      },
      claim: { updateClaimSlot: vi.fn() },
      entity: entityStore,
    } as any,
    observationService: null,
    tllRepository: null,
    firstMentionService: null,
    uriResolver: {} as any,
  };
}

function makeCtx(workspace: WorkspaceContext): AudnFactContext {
  return {
    userId: 'shared-user',
    fact: {
      fact: 'User works at Acme', headline: 'works at Acme', importance: 0.8,
      type: 'knowledge', keywords: ['acme'],
      entities: [
        { name: 'User', type: 'person' },
        { name: 'Acme', type: 'organization' },
      ],
      relations: [{ source: 'User', target: 'Acme', type: 'works_at' }],
      opinionConfidence: null,
    } as any,
    embedding: [0.1, 0.2],
    sourceSite: 'test', sourceUrl: 'url', episodeId: 'ep1',
    trustScore: 0.9, workspace,
  };
}

describe('cross-workspace coupling — intentional Phase 5 behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Lineage invokes createProjection then returns a fake memoryId
    mockEmitLineageEvent.mockImplementation(async (_deps: any, event: any) => {
      if (event.createProjection) {
        await event.createProjection('cmo-1');
      }
      return { memoryId: `mem-${Math.random().toString(36).slice(2, 8)}`, claimId: 'c1' };
    });
  });

  it('workspace B write resolves against entities created by workspace A', async () => {
    const { store, getEntityIds, getEntityKeys } = createStatefulEntityStore();
    const deps = makeDeps(store);
    const workspaceA: WorkspaceContext = { workspaceId: 'ws-A', agentId: 'agent-A' };
    const workspaceB: WorkspaceContext = { workspaceId: 'ws-B', agentId: 'agent-B' };

    // Ingest same fact from workspace A
    await storeCanonicalFact(deps, makeCtx(workspaceA));
    const idsAfterA = [...getEntityIds()];
    expect(idsAfterA).toHaveLength(2); // User, Acme

    // Ingest same fact from workspace B (same user, same entities)
    await storeCanonicalFact(deps, makeCtx(workspaceB));
    const idsAfterB = [...getEntityIds()];

    // Phase 5 behavior: no new entities created — workspace B reused workspace A's entities
    expect(idsAfterB).toEqual(idsAfterA);
    expect(getEntityKeys().every((k) => k.startsWith('shared-user::'))).toBe(true);
  });

  it('entity map keys carry userId only — no workspace discriminator', async () => {
    const { store, getEntityKeys } = createStatefulEntityStore();
    const deps = makeDeps(store);

    await storeCanonicalFact(deps, makeCtx({ workspaceId: 'ws-A', agentId: 'agent-A' }));
    const keys = getEntityKeys();

    // Every key is (userId::type::name) — no workspaceId component
    for (const k of keys) {
      expect(k.split('::')).toHaveLength(3);
      expect(k).toMatch(/^shared-user::/);
      expect(k).not.toMatch(/ws-A/);
    }
  });

  it('resolveEntity is called with no workspace/agent fields (Phase 6 flip point)', async () => {
    const { store, getResolveInputs } = createStatefulEntityStore();
    const deps = makeDeps(store);

    await storeCanonicalFact(deps, makeCtx({ workspaceId: 'ws-A', agentId: 'agent-A' }));
    const inputs = getResolveInputs() as Array<Record<string, unknown>>;
    expect(inputs.length).toBeGreaterThan(0);

    // Phase 5: resolveEntity input contains ONLY userId/name/entityType/embedding.
    // Phase 6 will add workspaceId here — when that happens, this assertion fails
    // and must be updated to assert the new scope isolation semantics.
    for (const input of inputs) {
      expect(Object.keys(input).sort()).toEqual(['embedding', 'entityType', 'name', 'userId']);
      expect(input).not.toHaveProperty('workspaceId');
      expect(input).not.toHaveProperty('agentId');
    }
  });
});
