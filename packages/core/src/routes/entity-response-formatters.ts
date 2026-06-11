/**
 * Response formatters for the /v1/entities route family.
 * Maps internal DB row types to the public JSON wire shapes.
 */

import type { UserProfileRow } from '../db/repository-user-profiles.js';
import type { EntityAttributeRow } from '../db/repository-entity-attributes.js';
import type { EntityCard } from '../db/entity-cards-repository.js';
import type { EntityRelationRow, ClaimVersionRow } from '../db/repository-types.js';
import type { EntitySettingsRow } from '../db/entity-settings-repository.js';

export interface AttributeResponse {
  entity: string;
  attribute: string;
  value: string;
  type: string;
  source_memory_id: string | null;
  observed_at: string;
}

export interface RelationResponse {
  target_entity_id: string;
  relation_type: string;
  confidence: number;
  valid_to: string | null;
}

export interface CardResponse {
  entity_name: string;
  card_text: string;
  version: number;
  updated_at: string;
}

export interface ProfileBlock {
  summary: string;
  preferences: string[];
  instructions: string[];
  open_commitments: string[];
}

export interface EntityProfileResponse {
  entity_type: string;
  entity_id: string;
  profile: ProfileBlock | null;
  attributes: AttributeResponse[];
  memory_count: number;
  last_active: string | null;
  updated_at: string | null;
}

export interface EntitySummaryResponse {
  entity_type: string;
  entity_id: string;
  memory_count: number;
  last_active: string | null;
}

export interface EntityListResponse {
  entities: EntitySummaryResponse[];
  total: number;
  page: number;
  page_size: number;
}

export interface EntityDetailResponse {
  entity_type: string;
  entity_id: string;
  memory_count: number;
  attributes: AttributeResponse[];
  relations: RelationResponse[];
  recent_cards: CardResponse[];
  updated_at: string | null;
}

export interface DeleteEntityResponse {
  deleted: {
    memories: number;
    entity_attributes: number;
    profile: number;
    entities: number;
    entity_edges: number;
    entity_cards: number;
    entity_settings: number;
  };
}

export interface HistoryEntryResponse {
  version_id: string;
  event: string;
  content: string;
  timestamp: string;
  superseded_by: string | null;
}

export interface MemoryHistoryResponse {
  memory_id: string;
  history: HistoryEntryResponse[];
}

export function formatProfile(
  profileRow: UserProfileRow | null,
  attributes: EntityAttributeRow[],
  memoryCount: number,
  lastActive: Date | null,
  entityType: string,
  entityId: string,
): EntityProfileResponse {
  return {
    entity_type: entityType,
    entity_id: entityId,
    profile: profileRow
      ? {
          summary: profileRow.profile_text,
          preferences: [],
          instructions: [],
          open_commitments: [],
        }
      : null,
    attributes: attributes.map(formatAttribute),
    memory_count: memoryCount,
    last_active: lastActive ? lastActive.toISOString() : null,
    updated_at: profileRow ? profileRow.updated_at.toISOString() : null,
  };
}

export function formatAttribute(row: EntityAttributeRow): AttributeResponse {
  return {
    entity: row.entity_name,
    attribute: row.attribute_key,
    value: row.attribute_value,
    type: row.value_type,
    source_memory_id: row.source_memory_id,
    observed_at: row.observed_at.toISOString(),
  };
}

export function formatRelation(row: EntityRelationRow): RelationResponse {
  return {
    target_entity_id: row.target_entity_id,
    relation_type: row.relation_type,
    confidence: row.confidence,
    valid_to: row.valid_to ? row.valid_to.toISOString() : null,
  };
}

export function formatCard(card: EntityCard): CardResponse {
  return {
    entity_name: card.entityName,
    card_text: card.cardText,
    version: card.version,
    updated_at: card.updatedAt.toISOString(),
  };
}

export function formatHistoryEntry(row: ClaimVersionRow, index: number): HistoryEntryResponse {
  return {
    version_id: row.id,
    event: row.mutation_type ?? (index === 0 ? 'ADD' : 'UPDATE'),
    content: row.content,
    timestamp: row.valid_from.toISOString(),
    superseded_by: row.superseded_by_version_id ?? null,
  };
}

export interface EntitySettingsResponse {
  entity_id: string;
  extraction_prompt: string | null;
  memory_kinds: string[] | null;
  decay_enabled: boolean;
  updated_at: string;
}

/** I6 fix: map raw DB row to public response shape. */
export function formatSettings(row: EntitySettingsRow): EntitySettingsResponse {
  return {
    entity_id: row.user_id,
    extraction_prompt: row.extraction_prompt,
    memory_kinds: row.memory_kinds,
    decay_enabled: row.decay_enabled,
    updated_at: row.updated_at.toISOString(),
  };
}
