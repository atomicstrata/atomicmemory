/**
 * Deterministic claim slot helpers.
 * Slots only form for relation-backed facts whose entities already resolve to
 * canonical IDs. This gives the temporal layer a stable overwrite target
 * without guessing semantics for every free-form sentence.
 */

import { type RelationType, type EntityType } from '../db/repository-types.js';
import { type ExtractedRelation } from './extraction.js';

export interface CanonicalEntityRef {
  extractedName: string;
  entityId: string;
  canonicalName: string;
  entityType: EntityType;
}

export interface ClaimSlotDescriptor {
  slotKey: string;
  subjectEntityId: string;
  relationType: RelationType;
  objectEntityId: string;
}

export interface PersistedRelationSlot {
  sourceEntityId: string;
  targetEntityId: string;
  relationType: RelationType;
}

export function buildRelationClaimSlot(
  relations: ExtractedRelation[],
  canonicalEntities: Map<string, CanonicalEntityRef>,
): ClaimSlotDescriptor | null {
  const candidates = relations
    .map((relation) => buildRelationSlotCandidate(relation, canonicalEntities))
    .filter((candidate): candidate is ClaimSlotDescriptor => candidate !== null)
    .sort((left, right) => left.slotKey.localeCompare(right.slotKey));

  return candidates[0] ?? null;
}

export function buildPersistedRelationClaimSlot(
  relations: PersistedRelationSlot[],
): ClaimSlotDescriptor | null {
  const candidates = relations
    .filter((relation) => relation.sourceEntityId !== relation.targetEntityId)
    .map((relation) => ({
      slotKey: `relation:${relation.sourceEntityId}:${relation.relationType}:${relation.targetEntityId}`,
      subjectEntityId: relation.sourceEntityId,
      relationType: relation.relationType,
      objectEntityId: relation.targetEntityId,
    }))
    .sort((left, right) => left.slotKey.localeCompare(right.slotKey));

  return candidates[0] ?? null;
}

function buildRelationSlotCandidate(
  relation: ExtractedRelation,
  canonicalEntities: Map<string, CanonicalEntityRef>,
): ClaimSlotDescriptor | null {
  const source = canonicalEntities.get(relation.source.toLowerCase());
  const target = canonicalEntities.get(relation.target.toLowerCase());
  if (!source || !target || source.entityId === target.entityId) {
    return null;
  }

  return {
    slotKey: `relation:${source.entityId}:${relation.type}:${target.entityId}`,
    subjectEntityId: source.entityId,
    relationType: relation.type,
    objectEntityId: target.entityId,
  };
}
