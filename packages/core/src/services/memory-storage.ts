/**
 * Canonical fact storage, projection writing, entity linking, and claim slot resolution.
 * These helpers are used by both the ingest pipeline and the AUDN decision executor.
 */

import { type ClaimSlotInput } from '../db/claim-repository.js';
import { embedTexts } from './embedding.js';
import { type ExtractedEntity, type ExtractedRelation } from './extraction.js';
import { classifyNetwork } from './memory-network.js';
import { buildRelationClaimSlot } from './claim-slotting.js';
import { extractConflictKeywords, mergeCandidates, type CandidateMemory } from './conflict-policy.js';
import { buildAtomicFactProjection, buildForesightProjections } from './memcell-projection.js';
import { inferNamespace, classifyNamespace } from './namespace-retrieval.js';
import { generateL1Overview } from './tiered-context.js';
import { emitAuditEvent } from './audit-events.js';
import { derivePersistedClaimSlot } from './memory-crud.js';
import { emitLineageEvent } from './memory-lineage.js';
import {
  classifyTemporalStateForWrite,
  supersedeAfterStore,
  type TemporalStateClassification,
} from './temporal-state-write.js';
import type {
  AudnFactContext,
  ClaimTarget,
  FactInput,
  MemoryServiceDeps,
  Outcome,
} from './memory-service-types.js';

interface StoreProjectionOptions {
  cmoId?: string;
  logicalTimestamp?: Date;
  workspace?: import('../db/repository-types.js').WorkspaceContext;
  /** BEAM v38: temporal-state classification to land on the new row. */
  temporal?: TemporalStateClassification | null;
}

/** Store a new canonical fact: CMO, projection, claim, evidence, entities. */
export async function storeCanonicalFact(
  deps: MemoryServiceDeps,
  ctx: AudnFactContext,
): Promise<{ outcome: Outcome; memoryId: string | null }> {
  const { userId, fact, embedding, sourceSite, sourceUrl, episodeId, trustScore, claimSlot, logicalTimestamp, workspace } = ctx;
  // BEAM v38: classify temporal state BEFORE storing so we can land
  // `state_key` / `event_start` on the new row's first INSERT. Fails closed.
  const temporal = await maybeClassifyTemporalForFact(deps, ctx);
  const lineage = await emitLineageEvent({ claims: deps.stores.claim, repo: deps.stores.memory, config: deps.config }, {
    kind: 'canonical-add',
    userId,
    fact,
    embedding,
    sourceSite,
    sourceUrl,
    episodeId,
    logicalTimestamp,
    claimSlot: claimSlot ?? null,
    createProjection: async (cmoId) =>
      storeProjection(deps, userId, fact, embedding, sourceSite, sourceUrl, episodeId, trustScore, {
        cmoId,
        logicalTimestamp,
        workspace,
        temporal,
      }),
  });
  if (!lineage?.memoryId) return { outcome: 'skipped', memoryId: null };
  const memoryId = lineage.memoryId;
  // BEAM v38: close prior memory windows for this state_key. Fails closed.
  if (temporal) {
    await supersedeAfterStore({
      pool: deps.stores.pool,
      userId,
      stateKey: temporal.stateKey,
      newMemoryId: memoryId,
      eventStart: temporal.eventStart,
    });
  }
  if (deps.config.entityGraphEnabled && deps.stores.entity) {
    await resolveAndLinkEntities(deps, userId, memoryId, fact.entities, fact.relations, embedding, logicalTimestamp);
    if (!claimSlot) {
      const persistedSlot = await derivePersistedClaimSlot(deps, userId, memoryId);
      if (persistedSlot) {
        await deps.stores.claim.updateClaimSlot(userId, lineage.claimId, persistedSlot);
      }
    }
  }
  if (deps.observationService && fact.entities.length > 0) {
    const subjects = fact.entities.map((e) => e.name);
    deps.observationService.markDirty(userId, subjects).catch(
      (err) => console.error('[observation] markDirty failed:', err),
    );
  }
  return { outcome: 'stored', memoryId };
}

/**
 * BEAM v38: run the temporal-state classifier when the flag is on.
 * Returns null when the flag is off, when the memory is non-stateful,
 * or when the classifier rejects the LLM output. Re-throws on LLM
 * transport errors so the ingest fails closed.
 */
async function maybeClassifyTemporalForFact(
  deps: MemoryServiceDeps,
  ctx: AudnFactContext,
): Promise<TemporalStateClassification | null> {
  if (!deps.config.temporalStateEnabled) return null;
  const observedAt = ctx.logicalTimestamp ?? new Date();
  return classifyTemporalStateForWrite({
    userId: ctx.userId,
    memoryText: ctx.fact.fact,
    observedAt,
    model: deps.config.llmModel,
  });
}

export async function storeProjection(
  deps: MemoryServiceDeps,
  userId: string,
  fact: FactInput,
  embedding: number[],
  sourceSite: string,
  sourceUrl: string,
  episodeId: string,
  trustScore: number,
  options: StoreProjectionOptions = {},
): Promise<string | null> {
  const namespace = deps.config.namespaceClassificationEnabled
    ? await classifyNamespace(fact.fact, sourceSite, fact.keywords)
    : inferNamespace(fact.fact, sourceSite, fact.keywords);

  const overview = generateL1Overview(fact.fact);
  const network = fact.network ?? classifyNetwork(fact as any).network;
  const memoryId = await deps.stores.memory.storeMemory({
    userId, content: fact.fact, embedding,
    memoryType: fact.type === 'knowledge' ? 'semantic' : 'episodic',
    importance: fact.importance, sourceSite, sourceUrl, episodeId,
    metadata: options.cmoId ? { cmo_id: options.cmoId } : undefined,
    keywords: fact.keywords.join(' '),
    namespace: namespace ?? undefined,
    summary: fact.headline,
    overview: overview !== fact.fact ? overview : '',
    trustScore, network,
    opinionConfidence: fact.opinionConfidence ?? null,
    workspaceId: options.workspace?.workspaceId,
    agentId: options.workspace?.agentId,
    visibility: options.workspace?.visibility,
    createdAt: options.logicalTimestamp,
    observedAt: options.logicalTimestamp,
    stateKey: options.temporal?.stateKey,
    eventStart: options.temporal?.eventStart,
    eventEnd: options.temporal?.eventEnd ?? null,
  });

  const atomicFact = buildAtomicFactProjection(fact, embedding);
  await deps.stores.representation.storeAtomicFacts([{
    userId, parentMemoryId: memoryId,
    factText: atomicFact.factText, embedding: atomicFact.embedding,
    factType: atomicFact.factType, importance: atomicFact.importance,
    sourceSite, sourceUrl, episodeId,
    keywords: atomicFact.keywords.join(' '), metadata: atomicFact.metadata,
    workspaceId: options.workspace?.workspaceId, agentId: options.workspace?.agentId,
  }]);

  const foresight = buildForesightProjections(fact, embedding);
  if (foresight.length > 0) {
    await deps.stores.representation.storeForesight(foresight.map((entry) => ({
      userId, parentMemoryId: memoryId,
      content: entry.content, embedding: entry.embedding, foresightType: entry.foresightType,
      sourceSite, sourceUrl, episodeId,
      metadata: entry.metadata, validFrom: entry.validFrom, validTo: entry.validTo,
      workspaceId: options.workspace?.workspaceId, agentId: options.workspace?.agentId,
    })));
  }

  if (deps.config.auditLoggingEnabled) {
    emitAuditEvent('memory:ingest', userId, {
      factType: fact.type, importance: fact.importance, trustScore,
    }, { memoryId, sourceSite });
  }

  return memoryId;
}

export async function resolveDeterministicClaimSlot(
  deps: MemoryServiceDeps,
  userId: string,
  fact: FactInput,
): Promise<ClaimSlotInput | null> {
  if (!deps.stores.entity || fact.entities.length === 0 || fact.relations.length === 0) {
    return null;
  }

  const canonicalEntries = await Promise.all(
    fact.entities.map(async (entity) => {
      const match = await deps.stores.entity!.findDeterministicEntity(userId, entity.type, entity.name);
      if (!match) return null;
      return [
        entity.name.toLowerCase(),
        {
          extractedName: entity.name,
          entityId: match.id,
          canonicalName: match.name,
          entityType: match.entity_type,
        },
      ] as const;
    }),
  );

  const canonicalMap = new Map(
    canonicalEntries.filter((entry): entry is NonNullable<typeof entry> => entry !== null),
  );
  return buildRelationClaimSlot(fact.relations, canonicalMap);
}

/**
 * Entity-scoped dedup: if AUDN proposed UPDATE or NOOP targeting a memory
 * that shares no entities with the new fact, promote to ADD.
 */
export async function applyEntityScopedDedup(
  deps: MemoryServiceDeps,
  decision: import('./extraction.js').AUDNDecision,
  userId: string,
  factEntities: ExtractedEntity[],
): Promise<import('./extraction.js').AUDNDecision> {
  if (decision.action !== 'UPDATE' && decision.action !== 'NOOP') return decision;
  if (!decision.targetMemoryId || !deps.stores.entity || factEntities.length === 0) return decision;

  const existingEntities = await deps.stores.entity!.getEntitiesForMemory(decision.targetMemoryId);
  if (existingEntities.length === 0) return decision;

  const factEntityNames = new Set(factEntities.map((e) => e.name.toLowerCase()));
  const hasSharedEntity = existingEntities.some(
    (e) => factEntityNames.has(e.name.toLowerCase()) ||
           e.alias_names.some((a) => factEntityNames.has(a.toLowerCase())),
  );

  if (!hasSharedEntity) {
    return { ...decision, action: 'ADD', targetMemoryId: null, updatedContent: null };
  }

  return decision;
}

/**
 * Resolve extracted entities (dedup by embedding + type), link them to the
 * memory, then store any extracted relations between entities.
 */
async function resolveAndLinkEntities(
  deps: MemoryServiceDeps,
  userId: string,
  memoryId: string,
  entities: ExtractedEntity[],
  relations: ExtractedRelation[],
  factEmbedding: number[],
  logicalTimestamp?: Date,
): Promise<void> {
  if (!deps.stores.entity || entities.length === 0) return;

  const entityEmbeddings = await embedTexts(entities.map((e) => e.name));
  const nameToEntityId = await resolveEntities(deps, userId, memoryId, entities, entityEmbeddings);
  await storeRelations(deps, userId, memoryId, relations, nameToEntityId);

  await maybeAppendTll(deps, userId, memoryId, nameToEntityId, logicalTimestamp);
}

/**
 * Phase 4 — TLL append: per-entity event-chain extension. Each new memory
 * referencing an entity becomes the new tip of that entity's chain. Used at
 * retrieval-time for EO/MSR/TR queries. Best-effort, fire-and-forget to
 * keep ingest hot path fast.
 *
 * The chain orders by observation_date ASC, so we use the memory's
 * observed_at (the conversation timestamp) instead of new Date() (the
 * ingest-arrival timestamp). Otherwise out-of-order or backfilled
 * conversations would chain by ingest time, breaking event ordering.
 */
async function maybeAppendTll(
  deps: MemoryServiceDeps,
  userId: string,
  memoryId: string,
  nameToEntityId: Map<string, string>,
  logicalTimestamp?: Date,
): Promise<void> {
  if (!deps.tllRepository) return;
  const entityIds = [...nameToEntityId.values()];
  if (entityIds.length === 0) return;

  const observationDate = await resolveTllObservationDate(deps, userId, memoryId, logicalTimestamp);
  // Fire-and-forget: TLL append is best-effort augmentation of the
  // ingest hot path. A failure here should NOT block ingest, which is
  // why we deliberately drop the promise. The `[tll-append-failed]`
  // structured prefix is what observability tooling greps for; pair
  // with `tll_expansion_failed` on the read path.
  deps.tllRepository
    .append(userId, memoryId, entityIds, observationDate)
    .catch((err) =>
      console.error(
        '[tll-append-failed]',
        err instanceof Error ? err.message : String(err),
      ),
    );
}

/**
 * Resolve the observation_date used for TLL chain ordering. Prefers the
 * caller-supplied logical timestamp (the canonical conversation time);
 * falls back to the memory row's observed_at column when the caller didn't
 * supply one. Last-resort fallback to new Date() only fires if the row
 * lookup fails — never silently drop the append.
 */
async function resolveTllObservationDate(
  deps: MemoryServiceDeps,
  userId: string,
  memoryId: string,
  logicalTimestamp: Date | undefined,
): Promise<Date> {
  if (logicalTimestamp) return logicalTimestamp;
  try {
    const memory = await deps.stores.memory.getMemory(memoryId, userId);
    if (memory?.observed_at) return memory.observed_at;
  } catch (err) {
    console.error('[tll] failed to resolve observed_at:', err instanceof Error ? err.message : err);
  }
  return new Date();
}

/** Resolve each extracted entity and link it to the memory. */
async function resolveEntities(
  deps: MemoryServiceDeps,
  userId: string,
  memoryId: string,
  entities: ExtractedEntity[],
  entityEmbeddings: number[][],
): Promise<Map<string, string>> {
  const nameToEntityId = new Map<string, string>();
  for (let i = 0; i < entities.length; i++) {
    try {
      const entityId = await deps.stores.entity!.resolveEntity({
        userId,
        name: entities[i].name,
        entityType: entities[i].type,
        embedding: entityEmbeddings[i],
      });
      await deps.stores.entity!.linkMemoryToEntity(memoryId, entityId);
      nameToEntityId.set(entities[i].name.toLowerCase(), entityId);
    } catch (err) {
      console.error(`Entity resolution failed for "${entities[i].name}": ${err instanceof Error ? err.message : err}`);
    }
  }
  return nameToEntityId;
}

/** Store extracted relations between resolved entities. */
async function storeRelations(
  deps: MemoryServiceDeps,
  userId: string,
  memoryId: string,
  relations: ExtractedRelation[],
  nameToEntityId: Map<string, string>,
): Promise<void> {
  for (const relation of relations) {
    const sourceId = nameToEntityId.get(relation.source.toLowerCase());
    const targetId = nameToEntityId.get(relation.target.toLowerCase());
    if (!sourceId || !targetId || sourceId === targetId) continue;

    try {
      await deps.stores.entity!.upsertRelation({
        userId,
        sourceEntityId: sourceId,
        targetEntityId: targetId,
        relationType: relation.type,
        sourceMemoryId: memoryId,
      });
    } catch (err) {
      console.error(`Relation storage failed for "${relation.source}" -> "${relation.target}": ${err instanceof Error ? err.message : err}`);
    }
  }
}

/** Ensure a claim target exists for the given memory, creating one if needed. */
export async function ensureClaimTarget(deps: MemoryServiceDeps, userId: string, memoryId: string): Promise<ClaimTarget> {
  const memory = await deps.stores.memory.getMemoryIncludingDeleted(memoryId, userId);
  if (!memory) throw new Error(`Target memory not found: ${memoryId}`);
  const cmoId = typeof memory.metadata.cmo_id === 'string' ? memory.metadata.cmo_id : null;
  const version = await deps.stores.claim.getClaimVersionByMemoryId(userId, memoryId);
  if (version) return { claimId: version.claim_id, versionId: version.id, memoryId, cmoId };

  const lineage = await emitLineageEvent({ claims: deps.stores.claim, config: deps.config }, {
    kind: 'claim-backfill',
    userId,
    memory: {
      id: memory.id,
      content: memory.content,
      embedding: memory.embedding,
      importance: memory.importance,
      sourceSite: memory.source_site,
      sourceUrl: memory.source_url,
      episodeId: memory.episode_id ?? undefined,
      createdAt: memory.created_at,
      memoryType: memory.memory_type,
      cmoId,
    },
  });
  if (!lineage) throw new Error(`Claim backfill unexpectedly skipped for memory: ${memory.id}`);
  return { claimId: lineage.claimId, versionId: lineage.versionId, memoryId: memory.id, cmoId };
}

export async function findConflictCandidates(deps: MemoryServiceDeps, userId: string, factText: string, embedding: number[]): Promise<CandidateMemory[]> {
  const [vectorCandidates, keywordCandidates] = await Promise.all([
    deps.stores.search.findNearDuplicates(userId, embedding, deps.config.audnCandidateThreshold),
    deps.stores.search.findKeywordCandidates(userId, extractConflictKeywords(factText)),
  ]);
  return mergeCandidates(vectorCandidates, keywordCandidates);
}

export async function findSlotConflictCandidates(
  deps: MemoryServiceDeps,
  userId: string,
  claimSlot: ClaimSlotInput | null,
): Promise<CandidateMemory[]> {
  if (!claimSlot) return [];
  const target = await deps.stores.claim.getActiveClaimTargetBySlot(userId, claimSlot.slotKey);
  if (!target) return [];
  const memory = await deps.stores.memory.getMemory(target.memoryId, userId);
  if (!memory) return [];
  return [{
    id: memory.id,
    content: memory.content,
    similarity: 1,
    importance: memory.importance,
  }];
}
