/**
 * Domain-facing store interfaces for Phase 5.
 *
 * Each interface exposes only the methods its domain consumers need.
 * Implementations delegate to the existing split repository modules
 * (repository-read.ts, repository-write.ts, repository-links.ts, etc.).
 *
 * For ClaimStore, EntityStore, and LessonStore, the existing repository
 * classes already serve as implementations — these interfaces are extracted
 * from their public surfaces.
 */

import type pg from 'pg';
import type { EntityAttributesRepository } from './repository-entity-attributes.js';
import type { EntityValuesRepository } from './entity-values-repository.js';
import type { EntityCardsRepository } from './entity-cards-repository.js';
import type { ContradictionsRepository } from './contradictions-repository.js';
import type { BeliefEdgesRepository } from './belief-edges-repository.js';
import type {
  AgentScope,
  AtomicFactRow,
  CanonicalMemoryObjectLineage,
  ForesightRow,
  MemoryRow,
  SearchResult,
  EpisodeRow,
  StoreMemoryInput,
} from './repository-types.js';
import type { CandidateRow } from './repository-vector-search.js';

/** A topic-similarity candidate row returned by findTopicCandidates. */
export interface TopicCandidateRow extends CandidateRow {
  topic_abstraction: string;
}

/** Recap-layer store (Sprint 3 v1). Cross-session synthesis. */
export interface RecapStore {
  findUnconsolidatedClusters(userId: string, minSize: number, pivot?: 'topic' | 'session'): Promise<{
    topic: string;
    member_ids: string[];
    member_contents: string[];
    time_range_start: Date | null;
    time_range_end: Date | null;
  }[]>;
  storeRecap(input: {
    userId: string;
    recapText: string;
    recapEmbedding: number[];
    topic: string;
    memberMemoryIds: string[];
    timeRangeStart: Date | null;
    timeRangeEnd: Date | null;
  }): Promise<string>;
  findRecapCandidates(userId: string, queryEmbedding: number[], limit: number): Promise<{
    id: string;
    user_id: string;
    recap_text: string;
    recap_embedding: number[];
    topic: string;
    member_count: number;
    similarity: number;
  }[]>;
}
import type { StoreAtomicFactInput, StoreForesightInput } from './repository-representations.js';
import type { MemoryLink } from './repository-links.js';
import type { SummariesRepository } from './summaries-repository.js';
import type { ManagedBlobRefRow } from './raw-document-blob-repository.js';

// StoreMemoryInput is shared with the repository write path; re-exported
// here so existing consumers of `./stores.js` keep working.
export type { StoreMemoryInput };

// ---------------------------------------------------------------------------
// MemoryStore — memory CRUD + workspace variants
// ---------------------------------------------------------------------------

export interface MemoryStore {
  storeMemory(input: StoreMemoryInput): Promise<string>;
  getMemory(id: string, userId?: string): Promise<MemoryRow | null>;
  getMemoryIncludingDeleted(id: string, userId?: string): Promise<MemoryRow | null>;
  listMemories(userId: string, limit?: number, offset?: number, sourceSite?: string, episodeId?: string, sessionId?: string): Promise<MemoryRow[]>;
  softDeleteMemory(userId: string, id: string): Promise<void>;
  updateMemoryContent(userId: string, id: string, content: string, embedding: number[], importance: number, keywords?: string, trustScore?: number): Promise<void>;
  updateMemoryMetadata(userId: string, id: string, metadata: Record<string, unknown>): Promise<void>;
  expireMemory(userId: string, id: string): Promise<void>;
  touchMemory(id: string): Promise<void>;
  countMemories(userId?: string): Promise<number>;
  getMemoryStats(userId: string): Promise<{ count: number; avgImportance: number; sourceDistribution: Record<string, number> }>;
  deleteBySource(userId: string, sourceSite: string): Promise<{
    deletedMemories: number;
    deletedEpisodes: number;
    deletedDocuments: number;
    /** Managed-blob refs the caller hands to `cleanupManagedBlobs()`
     * after the DB tx commits. Each ref carries `rawDocumentId` so
     * the cleanup loop can sync the paired artifact by id. */
    blobs: ManagedBlobRefRow[];
  }>;
  deleteAll(userId?: string): Promise<void>;
  backdateMemories(ids: string[], timestamp: Date): Promise<void>;
  updateOpinionConfidence(userId: string, memoryId: string, newConfidence: number): Promise<void>;
  countNeedsClarification(userId: string): Promise<number>;
  storeCanonicalMemoryObject(input: {
    userId: string;
    objectFamily: 'ingested_fact';
    payloadFormat?: string;
    canonicalPayload: { factText: string; factType: string; headline: string; keywords: string[] };
    provenance: { episodeId: string | null; sourceSite: string; sourceUrl: string };
    observedAt?: Date;
    lineage: CanonicalMemoryObjectLineage;
  }): Promise<string>;
  // Workspace variants
  getMemoryInWorkspace(id: string, workspaceId: string, callerAgentId?: string): Promise<MemoryRow | null>;
  listMemoriesInWorkspace(workspaceId: string, limit?: number, offset?: number, callerAgentId?: string, sessionId?: string): Promise<MemoryRow[]>;
  softDeleteMemoryInWorkspace(id: string, workspaceId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// EpisodeStore
// ---------------------------------------------------------------------------

export interface EpisodeStore {
  storeEpisode(input: { userId: string; content: string; sourceSite: string; sourceUrl?: string; sessionId?: string; workspaceId?: string; agentId?: string }): Promise<string>;
  getEpisode(id: string): Promise<EpisodeRow | null>;
}

// ---------------------------------------------------------------------------
// SearchStore — vector/hybrid/keyword search + dedup finding
// ---------------------------------------------------------------------------

export interface SearchStore {
  searchSimilar(userId: string, queryEmbedding: number[], limit: number, sourceSite?: string, referenceTime?: Date, sessionId?: string): Promise<SearchResult[]>;
  searchHybrid(userId: string, queryText: string, queryEmbedding: number[], limit: number, sourceSite?: string, referenceTime?: Date, sessionId?: string): Promise<SearchResult[]>;
  searchKeyword(userId: string, queryText: string, limit: number, sourceSite?: string, sessionId?: string): Promise<SearchResult[]>;
  searchAtomicFactsHybrid(userId: string, queryText: string, queryEmbedding: number[], limit: number, sourceSite?: string, referenceTime?: Date, sessionId?: string): Promise<SearchResult[]>;
  findNearDuplicates(userId: string, embedding: number[], threshold: number, limit?: number): Promise<CandidateRow[]>;
  findKeywordCandidates(userId: string, keywords: string[], limit?: number, includeExpired?: boolean): Promise<CandidateRow[]>;
  findTopicCandidates(userId: string, queryEmbedding: number[], limit: number): Promise<TopicCandidateRow[]>;
  findTemporalNeighbors(userId: string, anchorTimestamps: Date[], queryEmbedding: number[], windowMinutes: number, excludeIds: Set<string>, limit: number, referenceTime?: Date): Promise<SearchResult[]>;
  fetchMemoriesByIds(userId: string, ids: string[], queryEmbedding: number[], referenceTime?: Date, includeExpired?: boolean): Promise<SearchResult[]>;
  // Workspace variants
  searchSimilarInWorkspace(workspaceId: string, queryEmbedding: number[], limit: number, agentScope?: AgentScope, callerAgentId?: string, referenceTime?: Date, sessionId?: string): Promise<SearchResult[]>;
  findNearDuplicatesInWorkspace(workspaceId: string, embedding: number[], threshold: number, limit?: number, agentScope?: AgentScope, callerAgentId?: string): Promise<CandidateRow[]>;
}

// ---------------------------------------------------------------------------
// SemanticLinkStore
// ---------------------------------------------------------------------------

export interface SemanticLinkStore {
  createLinks(links: MemoryLink[]): Promise<number>;
  findLinkCandidates(userId: string, embedding: number[], threshold: number, excludeId: string, limit?: number): Promise<Array<{ id: string; similarity: number }>>;
  findLinkedMemoryIds(memoryIds: string[], excludeIds: Set<string>, limit: number): Promise<string[]>;
  countLinks(): Promise<number>;
}

// ---------------------------------------------------------------------------
// RepresentationStore — atomic facts + foresight projections
// ---------------------------------------------------------------------------

export interface RepresentationStore {
  storeAtomicFacts(facts: StoreAtomicFactInput[]): Promise<string[]>;
  storeForesight(entries: StoreForesightInput[]): Promise<string[]>;
  listAtomicFactsForMemory(userId: string, parentMemoryId: string): Promise<AtomicFactRow[]>;
  listForesightForMemory(userId: string, parentMemoryId: string): Promise<ForesightRow[]>;
  replaceAtomicFactsForMemory(userId: string, parentMemoryId: string, facts: StoreAtomicFactInput[]): Promise<string[]>;
  replaceForesightForMemory(userId: string, parentMemoryId: string, entries: StoreForesightInput[]): Promise<string[]>;
}

// ---------------------------------------------------------------------------
// ClaimStore — narrowed to the methods domain consumers actually call
// ---------------------------------------------------------------------------

export type ClaimStore = Pick<import('./repository-claims.js').ClaimRepository,
  | 'addEvidence'
  | 'createClaim'
  | 'createClaimVersion'
  | 'createUpdateVersion'
  | 'findClaimByMemoryId'
  | 'getActiveClaimTargetBySlot'
  | 'getClaimVersionByMemoryId'
  | 'getRecentMutations'
  | 'getReversalChain'
  | 'getUserMutationSummary'
  | 'invalidateClaim'
  | 'listClaimsMissingSlots'
  | 'searchClaimVersions'
  | 'setClaimCurrentVersion'
  | 'supersedeClaimVersion'
  | 'updateClaimSlot'
  | 'deleteAll'
>;

// ---------------------------------------------------------------------------
// EntityStore — narrowed to the methods domain consumers actually call
// ---------------------------------------------------------------------------

export type EntityStore = Pick<import('./repository-entities.js').EntityRepository,
  | 'resolveEntity'
  | 'linkMemoryToEntity'
  | 'getEntitiesForMemory'
  | 'getEntity'
  | 'searchEntities'
  | 'findEntitiesByName'
  | 'findMemoryIdsByEntities'
  | 'findRelatedEntityIds'
  | 'findDeterministicEntity'
  | 'getRelationsForMemory'
  | 'upsertRelation'
  | 'countEntities'
>;

// ---------------------------------------------------------------------------
// LessonStore — narrowed to the methods domain consumers actually call
// ---------------------------------------------------------------------------

export type LessonStore = Pick<import('./repository-lessons.js').LessonRepository,
  | 'createLesson'
  | 'findSimilarLessons'
  | 'getLessonsByUser'
  | 'getLessonsByType'
  | 'deactivateLesson'
  | 'countActiveLessons'
  | 'deleteAll'
>;

// ---------------------------------------------------------------------------
// Bundled stores shape for runtime container
// ---------------------------------------------------------------------------

export interface CoreStores {
  memory: MemoryStore;
  episode: EpisodeStore;
  /** Recap layer (Sprint 3 v1). Optional/null disables Recap features. */
  recap: RecapStore | null;
  search: SearchStore;
  link: SemanticLinkStore;
  representation: RepresentationStore;
  claim: ClaimStore;
  entity: EntityStore | null;
  /** Entity-attribute index (EAI). Null when entityAttributesEnabled is off. */
  entityAttributes: EntityAttributesRepository | null;
  lesson: LessonStore | null;
  /**
   * Hierarchical retrieval summaries (TBC sprint). Null when
   * `hierarchicalRetrievalEnabled` is off — gates the 5th RRF arm
   * in search-pipeline.
   */
  summaries: SummariesRepository | null;
  /**
   * User-profile store (Sprint 3 v1.5 — H2). Null when
   * `userProfileChannelEnabled` is off.
   */
  userProfile: import('./repository-user-profiles.js').UserProfileRepository | null;
  /**
   * Reflection retrieval store (BEAM-0.85 Phase 1, Task 1.9). Null when
   * `reflectEnabled` is off — the reflect-retrieval helper short-circuits
   * on the disabled flag so callers always pass the store through.
   */
  reflections: import('./reflections-repository.js').ReflectionsRepository | null;
  /**
   * Reflection job queue (BEAM-0.85 Phase 1, Task 1.12). Null when
   * `reflectEnabled` is off.
   */
  reflectionJobs: import('./reflection-jobs-repository.js').ReflectionJobsRepository | null;
  /**
   * Belief-edges repository for the CR bilateral-contradiction specialist
   * (BEAM-0.85 Phase 2). Null when `tbcEnabled` is off — the CR specialist
   * dispatcher short-circuits when the repo is absent.
   */
  beliefEdges: BeliefEdgesRepository | null;
  /**
   * Entity-values store for the IE/KU literal-value specialist (BEAM-0.85
   * Phase 2). Null when `phase2SpecialistsEnabled` is off — the specialist
   * dispatcher short-circuits when the repo is absent.
   */
  entityValues: EntityValuesRepository | null;
  /**
   * Entity-cards store for the always-on ENTITY_CARD channel (BEAM-0.85 —
   * Honcho parity). Null when `entityCardEnabled` is off. When present, the
   * search pipeline reads cards by (userId, conversationId) and injects
   * them as `## ENTITY_STATE` at the top of every answer-LLM prompt.
   */
  entityCards: EntityCardsRepository | null;
  /**
   * Contradictions store for AUDN bilateral preservation (BEAM CR fix).
   * Null when `contradictionPreservationEnabled` is off. When present,
   * AUDN's DELETE/SUPERSEDE path keeps both memories and records the pair
   * here instead of discarding the older side.
   */
  contradictions: ContradictionsRepository | null;
  /**
   * Raw pool access for call sites that still need it (PPR, deferred-audn
   * reconciliation, link generation). Will be removed when those paths
   * move behind dedicated store methods.
   */
  pool: pg.Pool;
}
