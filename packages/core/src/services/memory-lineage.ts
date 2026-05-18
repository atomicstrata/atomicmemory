/**
 * Internal claim-lineage emission seam for the existing lineage-producing write
 * paths only.
 *
 * This module centralizes the current claim/version/evidence/canonical-object
 * write sequences without changing their semantics. It deliberately models the
 * current consolidation anomaly as its own variant: consolidation creates a
 * claim/version pair but does not emit a mutation canonical memory object.
 *
 * Out of scope:
 * - schema changes
 * - new mutation types
 * - workspace/scope behavior changes
 * - routing lineage-bypassing paths through claim versions
 */

import type { ClaimSlotInput } from '../db/claim-repository.js';
import type { IngestRuntimeConfig } from './memory-service-types.js';
import type { ClaimTarget, FactInput } from './memory-service-types.js';

type MutationType = 'add' | 'update' | 'supersede' | 'delete';
type MutationProvenanceType = MutationType | 'clarify';

type MutationCanonicalObjectRepo = {
  storeCanonicalMemoryObject(input: {
    userId: string;
    objectFamily: 'ingested_fact';
    canonicalPayload: ReturnType<typeof buildCanonicalPayload>;
    provenance: { episodeId: string; sourceSite: string; sourceUrl: string };
    observedAt: Date | undefined;
    lineage: {
      mutationType: MutationType;
      previousObjectId: string | null;
      claimId?: string;
      claimVersionId?: string;
      previousVersionId?: string;
      mutationReason?: string;
      contradictionConfidence?: number | null;
      actorModel?: string | null;
    };
  }): Promise<string>;
};

type LineageClaimsPort = {
  createClaim(userId: string, claimType: string, validAt?: Date, claimSlot?: ClaimSlotInput | null): Promise<string>;
  createClaimVersion(input: {
    claimId: string;
    userId: string;
    memoryId?: string;
    content: string;
    embedding: number[];
    importance: number;
    sourceSite: string;
    sourceUrl?: string;
    episodeId?: string;
    validFrom?: Date;
    provenance?: {
      mutationType?: MutationProvenanceType;
      mutationReason?: string;
      previousVersionId?: string;
      actorModel?: string;
      contradictionConfidence?: number;
    };
  }): Promise<string>;
  setClaimCurrentVersion(claimId: string, versionId: string | null, status?: string, validAt?: Date): Promise<void>;
  addEvidence(input: { claimVersionId: string; episodeId?: string; memoryId?: string; quoteText?: string; speaker?: string }): Promise<void>;
  createUpdateVersion(input: {
    oldVersionId: string;
    claimId: string;
    userId: string;
    memoryId: string;
    content: string;
    embedding: number[];
    importance: number;
    sourceSite: string;
    sourceUrl?: string;
    episodeId?: string;
    validFrom?: Date;
    mutationReason?: string;
    actorModel?: string;
  }): Promise<string>;
  supersedeClaimVersion(userId: string, versionId: string, supersededByVersionId: string | null, validTo?: Date): Promise<void>;
  invalidateClaim(userId: string, claimId: string, invalidAt?: Date, invalidatedByVersionId?: string | null, status?: string): Promise<void>;
};

type LineageDeps = {
  claims: LineageClaimsPort;
  repo?: MutationCanonicalObjectRepo;
  config: Pick<IngestRuntimeConfig, 'llmModel'>;
};

type BackfillMemory = {
  id: string;
  content: string;
  embedding: number[];
  importance: number;
  sourceSite: string;
  sourceUrl: string;
  episodeId?: string;
  createdAt: Date;
  memoryType: string;
  cmoId: string | null;
};

type LineageEvent =
  | { kind: 'canonical-add'; userId: string; fact: FactInput; embedding: number[]; sourceSite: string; sourceUrl: string; episodeId: string; logicalTimestamp: Date | undefined; claimSlot: ClaimSlotInput | null; createProjection: (cmoId: string) => Promise<string | null> }
  | { kind: 'claim-backfill'; userId: string; memory: BackfillMemory }
  | { kind: 'consolidation-add'; userId: string; memoryId: string; content: string; embedding: number[]; importance: number; sourceSite: string; mutationReason: string }
  | { kind: 'canonical-update'; userId: string; fact: FactInput; updatedContent: string; updatedEmbedding: number[]; sourceSite: string; sourceUrl: string; episodeId: string; logicalTimestamp: Date | undefined; target: ClaimTarget; contradictionConfidence?: number | null }
  | { kind: 'canonical-supersede'; userId: string; fact: FactInput; embedding: number[]; sourceSite: string; sourceUrl: string; episodeId: string; logicalTimestamp: Date | undefined; target: ClaimTarget; newMemoryId: string; contradictionConfidence?: number | null }
  | { kind: 'canonical-delete'; userId: string; fact: FactInput; sourceSite: string; sourceUrl: string; episodeId: string; logicalTimestamp: Date | undefined; target: ClaimTarget; targetEmbedding: number[]; contradictionConfidence?: number | null };

export type LineageEmission = { claimId: string; versionId: string; memoryId: string | null; cmoId: string | null };

export async function emitLineageEvent(
  deps: LineageDeps,
  event: LineageEvent,
): Promise<LineageEmission | null> {
  switch (event.kind) {
    case 'canonical-add':
      return emitCanonicalAdd(deps, event);
    case 'claim-backfill':
      return emitBackfill(deps, event);
    case 'consolidation-add':
      return emitConsolidationAdd(deps, event);
    case 'canonical-update':
      return emitCanonicalUpdate(deps, event);
    case 'canonical-supersede':
      return emitCanonicalSupersede(deps, event);
    case 'canonical-delete':
      return emitCanonicalDelete(deps, event);
  }
}

function buildCanonicalPayload(fact: FactInput) {
  return {
    factText: fact.fact,
    factType: fact.type,
    headline: fact.headline,
    keywords: fact.keywords,
  };
}

async function emitCanonicalAdd(
  deps: LineageDeps,
  event: Extract<LineageEvent, { kind: 'canonical-add' }>,
): Promise<LineageEmission | null> {
  const cmoId = await requireRepo(deps).storeCanonicalMemoryObject({
    userId: event.userId,
    objectFamily: 'ingested_fact',
    canonicalPayload: buildCanonicalPayload(event.fact),
    provenance: { episodeId: event.episodeId, sourceSite: event.sourceSite, sourceUrl: event.sourceUrl },
    observedAt: event.logicalTimestamp,
    lineage: { mutationType: 'add', previousObjectId: null },
  });
  const memoryId = await event.createProjection(cmoId);
  if (!memoryId) return null;

  const claimId = await deps.claims.createClaim(
    event.userId,
    event.fact.type,
    event.logicalTimestamp,
    event.claimSlot,
  );
  const versionId = await deps.claims.createClaimVersion({
    claimId,
    userId: event.userId,
    memoryId,
    content: event.fact.fact,
    embedding: event.embedding,
    importance: event.fact.importance,
    sourceSite: event.sourceSite,
    sourceUrl: event.sourceUrl,
    episodeId: event.episodeId,
    validFrom: event.logicalTimestamp,
    provenance: { mutationType: 'add', actorModel: lineageActorModel(deps) },
  });
  await deps.claims.setClaimCurrentVersion(claimId, versionId, 'active', event.logicalTimestamp);
  await deps.claims.addEvidence({ claimVersionId: versionId, episodeId: event.episodeId, memoryId, quoteText: event.fact.fact });
  return { claimId, versionId, memoryId, cmoId };
}

async function emitBackfill(
  deps: LineageDeps,
  event: Extract<LineageEvent, { kind: 'claim-backfill' }>,
): Promise<LineageEmission> {
  const claimId = await deps.claims.createClaim(event.userId, event.memory.memoryType, event.memory.createdAt);
  const versionId = await deps.claims.createClaimVersion({
    claimId,
    userId: event.userId,
    memoryId: event.memory.id,
    content: event.memory.content,
    embedding: event.memory.embedding,
    importance: event.memory.importance,
    sourceSite: event.memory.sourceSite,
    sourceUrl: event.memory.sourceUrl,
    episodeId: event.memory.episodeId,
    validFrom: event.memory.createdAt,
  });
  await deps.claims.setClaimCurrentVersion(claimId, versionId, 'active', event.memory.createdAt);
  await deps.claims.addEvidence({
    claimVersionId: versionId,
    episodeId: event.memory.episodeId,
    memoryId: event.memory.id,
    quoteText: event.memory.content,
  });
  return { claimId, versionId, memoryId: event.memory.id, cmoId: event.memory.cmoId };
}

async function emitConsolidationAdd(
  deps: LineageDeps,
  event: Extract<LineageEvent, { kind: 'consolidation-add' }>,
): Promise<LineageEmission> {
  const claimId = await deps.claims.createClaim(event.userId, 'consolidated');
  const versionId = await deps.claims.createClaimVersion({
    claimId,
    userId: event.userId,
    memoryId: event.memoryId,
    content: event.content,
    embedding: event.embedding,
    importance: event.importance,
    sourceSite: event.sourceSite,
    provenance: {
      mutationType: 'add',
      mutationReason: event.mutationReason,
      actorModel: lineageActorModel(deps),
    },
  });
  await deps.claims.setClaimCurrentVersion(claimId, versionId);
  return { claimId, versionId, memoryId: event.memoryId, cmoId: null };
}

async function emitCanonicalUpdate(
  deps: LineageDeps,
  event: Extract<LineageEvent, { kind: 'canonical-update' }>,
): Promise<LineageEmission> {
  const mutationReason = `Updated from: "${event.fact.fact.slice(0, 100)}"`;
  const versionId = await deps.claims.createUpdateVersion({
    oldVersionId: event.target.versionId,
    claimId: event.target.claimId,
    userId: event.userId,
    memoryId: event.target.memoryId,
    content: event.updatedContent,
    embedding: event.updatedEmbedding,
    importance: event.fact.importance,
    sourceSite: event.sourceSite,
    sourceUrl: event.sourceUrl,
    episodeId: event.episodeId,
    validFrom: event.logicalTimestamp,
    mutationReason,
    actorModel: lineageActorModel(deps),
  });
  await deps.claims.addEvidence({
    claimVersionId: versionId,
    episodeId: event.episodeId,
    memoryId: event.target.memoryId,
    quoteText: event.fact.fact,
  });
  const cmoId = await createMutationCanonicalObject(deps, event, versionId, mutationReason, {
    ...event.fact,
    fact: event.updatedContent,
  });
  return { claimId: event.target.claimId, versionId, memoryId: event.target.memoryId, cmoId };
}

async function emitCanonicalSupersede(
  deps: LineageDeps,
  event: Extract<LineageEvent, { kind: 'canonical-supersede' }>,
): Promise<LineageEmission> {
  const mutationReason = `Superseded memory "${event.target.memoryId}" with new fact`;
  const versionId = await deps.claims.createClaimVersion({
    claimId: event.target.claimId,
    userId: event.userId,
    memoryId: event.newMemoryId,
    content: event.fact.fact,
    embedding: event.embedding,
    importance: event.fact.importance,
    sourceSite: event.sourceSite,
    sourceUrl: event.sourceUrl,
    episodeId: event.episodeId,
    validFrom: event.logicalTimestamp,
    provenance: {
      mutationType: 'supersede',
      mutationReason,
      previousVersionId: event.target.versionId,
      actorModel: lineageActorModel(deps),
      contradictionConfidence: event.contradictionConfidence ?? undefined,
    },
  });
  await deps.claims.supersedeClaimVersion(event.userId, event.target.versionId, versionId, event.logicalTimestamp ?? new Date());
  await deps.claims.setClaimCurrentVersion(event.target.claimId, versionId, 'active', event.logicalTimestamp);
  await deps.claims.addEvidence({
    claimVersionId: versionId,
    episodeId: event.episodeId,
    memoryId: event.newMemoryId,
    quoteText: event.fact.fact,
  });
  const cmoId = await createMutationCanonicalObject(deps, event, versionId, mutationReason, event.fact);
  return { claimId: event.target.claimId, versionId, memoryId: event.newMemoryId, cmoId };
}

async function emitCanonicalDelete(
  deps: LineageDeps,
  event: Extract<LineageEvent, { kind: 'canonical-delete' }>,
): Promise<LineageEmission> {
  const mutationReason = `Deleted memory "${event.target.memoryId}" — fact: "${event.fact.fact.slice(0, 100)}"`;
  const versionId = await deps.claims.createClaimVersion({
    claimId: event.target.claimId,
    userId: event.userId,
    content: `[DELETED] ${event.fact.fact}`,
    embedding: event.targetEmbedding,
    importance: 0,
    sourceSite: '',
    sourceUrl: '',
    episodeId: event.episodeId,
    validFrom: event.logicalTimestamp,
    provenance: {
      mutationType: 'delete',
      mutationReason,
      previousVersionId: event.target.versionId,
      actorModel: lineageActorModel(deps),
      contradictionConfidence: event.contradictionConfidence ?? undefined,
    },
  });
  await deps.claims.supersedeClaimVersion(event.userId, event.target.versionId, versionId, event.logicalTimestamp ?? new Date());
  await deps.claims.invalidateClaim(event.userId, event.target.claimId, event.logicalTimestamp ?? new Date(), versionId);
  const cmoId = await createMutationCanonicalObject(deps, event, versionId, mutationReason, event.fact);
  return { claimId: event.target.claimId, versionId, memoryId: null, cmoId };
}

async function createMutationCanonicalObject(
  deps: LineageDeps,
  event: Extract<LineageEvent, { kind: 'canonical-update' | 'canonical-supersede' | 'canonical-delete' }>,
  claimVersionId: string,
  mutationReason: string,
  fact: FactInput,
): Promise<string> {
  return requireRepo(deps).storeCanonicalMemoryObject({
    userId: event.userId,
    objectFamily: 'ingested_fact',
    canonicalPayload: buildCanonicalPayload(fact),
    provenance: { episodeId: event.episodeId, sourceSite: event.sourceSite, sourceUrl: event.sourceUrl },
    observedAt: event.logicalTimestamp,
    lineage: {
      mutationType: mutationTypeFor(event.kind),
      previousObjectId: event.target.cmoId,
      claimId: event.target.claimId,
      claimVersionId,
      previousVersionId: event.target.versionId,
      mutationReason,
      contradictionConfidence: event.contradictionConfidence ?? undefined,
      actorModel: lineageActorModel(deps),
    },
  });
}

function mutationTypeFor(
  kind: 'canonical-update' | 'canonical-supersede' | 'canonical-delete',
): 'update' | 'supersede' | 'delete' {
  if (kind === 'canonical-update') return 'update';
  if (kind === 'canonical-supersede') return 'supersede';
  return 'delete';
}

function requireRepo(deps: LineageDeps): MutationCanonicalObjectRepo {
  if (!deps.repo) {
    throw new Error('Lineage event requires canonical object repository access');
  }
  return deps.repo;
}

function lineageActorModel(deps: LineageDeps): string {
  return deps.config.llmModel;
}
