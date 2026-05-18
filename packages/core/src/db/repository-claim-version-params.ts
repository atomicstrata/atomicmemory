/**
 * Positional-parameter assembly for the `memory_claims` and
 * `memory_claim_versions` inserts in `repository-claims.ts`. Extracted so
 * the per-field `??` defaults live next to a small set of single-purpose
 * helpers rather than inflating the call sites in the repository class.
 */

import pgvector from 'pgvector/pg';

import type { ClaimSlotInput, MutationProvenance } from './repository-claims.js';
import { clampImportance } from './repository-types.js';

/**
 * Named input contract for createClaimVersion / createClaimVersionWithClient.
 * One shape shared by both call sites and importable by callers that want
 * to construct a typed payload outside the repository class.
 */
export interface CreateClaimVersionInput {
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
  provenance?: MutationProvenance;
}

/**
 * Build the seven positional parameters for INSERT INTO memory_claims.
 * Slot fields collapse to four NULLs when the caller did not pass a slot;
 * keeping the early return here means createClaimWithClient stays a thin
 * SQL site without per-field branching.
 */
export function buildCreateClaimParams(
  userId: string,
  claimType: string,
  validAt: Date | undefined,
  slot: ClaimSlotInput | null | undefined,
): unknown[] {
  return [
    userId,
    claimType,
    ...resolveSlotFields(slot),
    validAt ?? new Date(),
  ];
}

function resolveSlotFields(slot: ClaimSlotInput | null | undefined): unknown[] {
  if (!slot) return [null, null, null, null];
  return [slot.slotKey, slot.subjectEntityId, slot.relationType, slot.objectEntityId];
}

/**
 * Build the 15 positional parameters for INSERT INTO memory_claim_versions.
 * The 5 mutation-provenance columns are isolated in
 * `extractMutationProvenanceParams` so this builder carries only the
 * top-level `??` defaults (memoryId / sourceUrl / episodeId).
 */
export function buildClaimVersionInsertParams(
  input: CreateClaimVersionInput,
  validFrom: Date,
): unknown[] {
  return [
    input.claimId,
    input.userId,
    input.memoryId ?? null,
    input.content,
    pgvector.toSql(input.embedding),
    clampImportance(input.importance),
    input.sourceSite,
    input.sourceUrl ?? '',
    input.episodeId ?? null,
    validFrom,
    ...extractMutationProvenanceParams(input.provenance),
  ];
}

/**
 * Project a MutationProvenance bag onto the five SQL columns that follow
 * valid_from in memory_claim_versions. When no provenance is supplied,
 * every column is NULL — this is the v1.0.x ingest path that predates the
 * provenance bag, so the SQL must accept it.
 */
function extractMutationProvenanceParams(provenance: MutationProvenance | undefined): unknown[] {
  if (!provenance) return [null, null, null, null, null];
  return [
    provenance.mutationType,
    provenance.mutationReason ?? null,
    provenance.previousVersionId ?? null,
    provenance.actorModel ?? null,
    provenance.contradictionConfidence ?? null,
  ];
}
