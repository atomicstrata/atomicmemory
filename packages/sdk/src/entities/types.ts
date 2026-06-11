/**
 * @file Public types for the AtomicMemory Entity API.
 *
 * All shapes mirror the wire contract from /v1/entities. Fields use
 * camelCase here; the client translates from the server's snake_case.
 */

export type EntityType = 'user' | 'agent' | 'session';

export interface EntityAttribute {
  entity: string;
  attribute: string;
  value: string;
  type: string;
  sourceMemoryId: string | null;
  observedAt: string;
}

export interface EntityRelation {
  targetEntityId: string;
  relationType: string;
  confidence: number;
  validTo: string | null;
}

export interface EntityCard {
  entityName: string;
  cardText: string;
  version: number;
  updatedAt: string;
}

export interface EntityProfileBlock {
  summary: string;
  preferences: string[];
  instructions: string[];
  openCommitments: string[];
}

export interface EntityProfile {
  entityType: EntityType;
  entityId: string;
  profile: EntityProfileBlock | null;
  attributes: EntityAttribute[];
  memoryCount: number;
  lastActive: string | null;
  updatedAt: string | null;
}

export interface EntitySummary {
  entityType: EntityType;
  entityId: string;
  memoryCount: number;
  lastActive: string | null;
}

export interface EntityListResult {
  entities: EntitySummary[];
  total: number;
  page: number;
  pageSize: number;
}

export interface EntityDetail {
  entityType: EntityType;
  entityId: string;
  memoryCount: number;
  attributes: EntityAttribute[];
  relations: EntityRelation[];
  recentCards: EntityCard[];
  updatedAt: string | null;
}

export interface DeleteEntityResult {
  deleted: {
    memories: number;
    entityAttributes: number;
    profile: number;
    entities: number;
    entityEdges: number;
    entityCards: number;
  };
}

export interface MemoryHistoryEntry {
  versionId: string;
  event: string;
  content: string;
  timestamp: string;
  supersededBy: string | null;
}

export interface MemoryHistory {
  memoryId: string;
  history: MemoryHistoryEntry[];
}

export interface EntitySettings {
  entityId: string;
  extractionPrompt: string | null;
  memoryKinds: string[] | null;
  decayEnabled: boolean;
  updatedAt: string;
}

export interface MergeEntitiesResult {
  merged: {
    memoriesMoved: number;
    attributesMoved: number;
    cardsMoved: number;
  };
  targetEntityId: string;
}

export interface ListEntitiesOptions {
  entityType?: EntityType;
  page?: number;
  pageSize?: number;
}

export interface GetAttributesOptions {
  attribute?: string;
  entity?: string;
  limit?: number;
}

export interface PatchEntitySettingsInput {
  extractionPrompt?: string;
  memoryKinds?: string[];
  decayEnabled?: boolean;
}
