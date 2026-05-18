/**
 * Shared repository types and row normalizers.
 */

export interface MemoryMetadata {
  clarification_note?: string;
  cmo_id?: string;
  target_memory_id?: string;
  [key: string]: unknown;
}

/**
 * Metadata keys that core treats as load-bearing internals at runtime —
 * lineage/claim, dedup, extraction outputs, consolidation, lesson
 * extraction, and AUDN mutation. Inbound caller-controlled metadata
 * MUST NOT include any of these; `IngestBodySchema` rejects with 400.
 *
 * Adding a new internal `metadata.<key>` access in core MUST add the
 * key here, or the new key becomes spoofable from outside. The
 * static-analysis test in `src/__tests__/reserved-metadata-keys.test.ts`
 * enforces this: it scans `src/` for metadata access patterns and
 * fails CI if any found key is missing from this set.
 */
export const RESERVED_METADATA_KEYS = new Set<string>([
  // Lineage / claim — `src/services/memory-storage.ts`
  'cmo_id',
  // Deduplication — `src/services/composite-dedup.ts`,
  // `src/services/ingest-post-write.ts`
  'memberMemoryIds',
  'compositeVersion',
  // Extraction — `src/services/memcell-projection.ts`
  'headline',
  'entities',
  'relations',
  'keywords',
  // Consolidation — `src/services/consolidation-service.ts`
  'consolidated_from',
  'cluster_size',
  'avg_affinity',
  // Recap retrieval channel — `src/services/search-pipeline.ts`
  'recap',
  'topic',
  'member_count',
  // Lesson extraction — `src/services/lesson-service.ts`
  'sourceSite',
  'findingCount',
  'rules',
  'trustScore',
  'threshold',
  'contradictionConfidence',
  'supersededMemoryId',
  // AUDN mutation — `src/services/memory-audn.ts`
  'clarification_note',
  'target_memory_id',
  'contradiction_confidence',
  // Phase 4 document provenance — `src/services/document-indexer.ts`
  // `materializeMemories` stamps these on every chunk-derived memory
  // so SDK consumers that only read `memory.metadata` can resolve
  // provenance without hitting the typed `raw_document_id` /
  // `document_chunk_id` columns. Reserved so a caller can't spoof
  // them via user-supplied metadata.
  'raw_document_id',
  'document_chunk_id',
  // Phase 5 upload pipeline — `src/services/document-upload.ts` writes
  // `upload_result.stored_status` into `raw_storage_metadata` as an
  // INTERNAL sidecar Phase γ reads on the finalize-recovery path.
  // `raw_storage_metadata` is a separate JSONB column from `metadata`,
  // but reserving the key here is defense-in-depth in case a future
  // change merges or aliases the two.
  'upload_result',
  // Phase 6 reconciler reads the adapter's
  // `RawContentHeadResult.metadata.providerMetadata` to deep-merge
  // filecoin keys. Same defense-in-depth: the scanner picks up the
  // `.metadata.providerMetadata` access chain even though it's not
  // the user-controlled `metadata` JSONB column.
  'providerMetadata',
  // Phase 6 review-fix (hash_verify): the reconciler reads
  // `row.rawStorageMetadata.codec` to pass the codec sidecar into
  // `codec.decode()` before sha256-comparing the plaintext against
  // `content_hash`. Same defense-in-depth — `raw_storage_metadata` is
  // a separate column from the user-controlled `metadata`, but
  // reserving the key catches a future aliasing mistake.
  'codec',
]);

/**
 * Shared write-shape for memory rows. Used by the repository write path
 * and the MemoryStore interface so the two stay in lockstep.
 */
export interface StoreMemoryInput {
  userId: string;
  content: string;
  embedding: number[];
  memoryType?: string;
  importance: number;
  sourceSite: string;
  sourceUrl?: string;
  episodeId?: string;
  status?: 'active' | 'needs_clarification';
  metadata?: MemoryMetadata;
  keywords?: string;
  namespace?: string;
  summary?: string;
  overview?: string;
  trustScore?: number;
  createdAt?: Date;
  observedAt?: Date;
  network?: string;
  opinionConfidence?: number | null;
  observationSubject?: string | null;
  workspaceId?: string;
  agentId?: string;
  visibility?: 'agent_only' | 'restricted' | 'workspace';
  /**
   * BEAM v38: temporal state. `stateKey` is a stable identifier for an
   * evolving fact (e.g. `user:1:location`). `eventStart`/`eventEnd` define
   * the validity window (NULL eventEnd = currently active).
   */
  stateKey?: string | null;
  eventStart?: Date | null;
  eventEnd?: Date | null;
  /** Phase 2 provenance: raw_documents.id this memory was derived from. */
  rawDocumentId?: string;
  /** Phase 2 provenance: document_chunks.id that produced this memory's content. */
  documentChunkId?: string;
}

export type CanonicalMemoryObjectFamily = 'ingested_fact';

export interface CanonicalFactPayload {
  factText: string;
  factType: string;
  headline: string;
  keywords: string[];
}

export interface CanonicalMemoryObjectProvenance {
  episodeId: string | null;
  sourceSite: string;
  sourceUrl: string;
}

export interface CanonicalMemoryObjectLineage {
  mutationType: 'add' | 'update' | 'supersede' | 'delete';
  previousObjectId: string | null;
  claimId?: string | null;
  claimVersionId?: string | null;
  previousVersionId?: string | null;
  mutationReason?: string | null;
  actorModel?: string | null;
  contradictionConfidence?: number | null;
}

export interface CanonicalMemoryObjectRow {
  id: string;
  user_id: string;
  object_family: CanonicalMemoryObjectFamily;
  payload_format: string;
  canonical_payload: CanonicalFactPayload;
  provenance: CanonicalMemoryObjectProvenance;
  observed_at: Date;
  lineage: CanonicalMemoryObjectLineage;
  created_at: Date;
}

export interface MemoryRow {
  id: string;
  user_id: string;
  content: string;
  embedding: number[];
  memory_type: string;
  importance: number;
  source_site: string;
  source_url: string;
  episode_id: string | null;
  session_id?: string | null;
  status: 'active' | 'needs_clarification';
  metadata: MemoryMetadata;
  keywords: string;
  namespace: string | null;
  summary: string;
  overview: string;
  trust_score: number;
  observed_at: Date;
  created_at: Date;
  last_accessed_at: Date;
  access_count: number;
  expired_at: Date | null;
  deleted_at: Date | null;
  network: string;
  opinion_confidence: number | null;
  observation_subject: string | null;
  workspace_id?: string | null;
  agent_id?: string | null;
  visibility?: 'agent_only' | 'restricted' | 'workspace' | null;
  /** BEAM v38: temporal state — populated only when temporalStateEnabled. */
  state_key?: string | null;
  event_start?: Date | null;
  event_end?: Date | null;
}

export interface EpisodeRow {
  id: string;
  user_id: string;
  content: string;
  source_site: string;
  source_url: string;
  session_id: string | null;
  created_at: Date;
}

export interface SearchResult extends MemoryRow {
  similarity: number;
  score: number;
  semantic_similarity?: number;
  ranking_score?: number;
  relevance?: number;
  matched_facts?: string[];
  matched_fact_ids?: string[];
  retrieval_layer?: 'memory' | 'atomic_fact';
  /**
   * Origin of the row in the candidate pool. Absent for similarity-ranked
   * rows; set to `'tll-chain'` for rows hydrated by TLL chain expansion
   * after the relevance gate (see `hydrateChainMemories`).
   */
  retrieval_signal?: 'tll-chain';
}

export type AtomicFactType = 'preference' | 'project' | 'knowledge' | 'person' | 'plan';

export interface AtomicFactRow {
  id: string;
  user_id: string;
  parent_memory_id: string;
  fact_text: string;
  embedding: number[];
  fact_type: AtomicFactType;
  importance: number;
  source_site: string;
  source_url: string;
  episode_id: string | null;
  keywords: string;
  metadata: MemoryMetadata;
  workspace_id: string | null;
  agent_id: string | null;
  created_at: Date;
}

export type ForesightType = 'plan' | 'goal' | 'scheduled' | 'expected_state';

export interface ForesightRow {
  id: string;
  user_id: string;
  parent_memory_id: string;
  content: string;
  embedding: number[];
  foresight_type: ForesightType;
  source_site: string;
  source_url: string;
  episode_id: string | null;
  metadata: MemoryMetadata;
  valid_from: Date;
  valid_to: Date | null;
  workspace_id: string | null;
  agent_id: string | null;
  created_at: Date;
}

export interface ClaimRow {
  id: string;
  user_id: string;
  claim_type: string;
  status: string;
  current_version_id: string | null;
  slot_key: string | null;
  subject_entity_id: string | null;
  relation_type: RelationType | null;
  object_entity_id: string | null;
  valid_at: Date;
  invalid_at: Date | null;
  invalidated_at: Date | null;
  invalidated_by_version_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export type MutationType = 'add' | 'update' | 'supersede' | 'delete' | 'clarify';

export interface ClaimVersionRow {
  id: string;
  claim_id: string;
  user_id: string;
  memory_id: string | null;
  content: string;
  embedding: number[];
  importance: number;
  source_site: string;
  source_url: string;
  episode_id: string | null;
  valid_from: Date;
  valid_to: Date | null;
  superseded_by_version_id: string | null;
  mutation_type: MutationType | null;
  mutation_reason: string | null;
  previous_version_id: string | null;
  actor_model: string | null;
  contradiction_confidence: number | null;
  created_at: Date;
}

/**
 * Context for workspace-scoped operations. When present, all reads and writes
 * are scoped to the given workspace. When absent, the system operates in
 * single-agent mode (backward-compatible).
 */
export interface WorkspaceContext {
  workspaceId: string;
  agentId: string;
  /** Controls which agents can see memories written in this context. */
  visibility?: 'agent_only' | 'restricted' | 'workspace';
}

/**
 * Agent scope filter for workspace searches.
 * - 'all': search all agents in the workspace
 * - 'self': search only the calling agent's memories
 * - string: search a specific agent's memories by ID
 */
export type AgentScope = 'all' | 'self' | 'others' | string | string[];

export function clampImportance(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function parseEmbedding(value: unknown): number[] {
  if (Array.isArray(value)) return value.map(Number);
  if (typeof value !== 'string') return [];
  return value.slice(1, -1).split(',').filter(Boolean).map(Number);
}

export function parseMetadata(value: unknown): MemoryMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as MemoryMetadata;
}

export function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  if (typeof value !== 'string') return [];
  if (value.startsWith('{') && value.endsWith('}')) {
    return value.slice(1, -1).split(',').filter(Boolean);
  }
  return [];
}

export function normalizeMemoryRow(row: Record<string, unknown>): MemoryRow {
  return {
    ...row,
    embedding: parseEmbedding(row.embedding),
    metadata: parseMetadata(row.metadata),
  } as MemoryRow;
}

export function normalizeSearchRow(row: Record<string, unknown>): SearchResult {
  return {
    ...normalizeMemoryRow(row),
    matched_facts: parseStringArray(row.matched_facts),
    matched_fact_ids: parseStringArray(row.matched_fact_ids),
    retrieval_layer: (row.retrieval_layer as SearchResult['retrieval_layer']) ?? 'memory',
  } as SearchResult;
}

export function normalizeVersionRow(row: Record<string, unknown>): ClaimVersionRow {
  return { ...row, embedding: parseEmbedding(row.embedding) } as ClaimVersionRow;
}

/** Phase 5 — Entity graph types */

export type EntityType = 'person' | 'tool' | 'project' | 'organization' | 'place' | 'concept';

export interface EntityRow {
  id: string;
  user_id: string;
  name: string;
  normalized_name: string;
  entity_type: EntityType;
  embedding: number[];
  alias_names: string[];
  normalized_alias_names: string[];
  created_at: Date;
  updated_at: Date;
}

export interface MemoryEntityRow {
  memory_id: string;
  entity_id: string;
  created_at: Date;
}

export type RelationType =
  | 'uses' | 'works_on' | 'works_at' | 'located_in' | 'knows'
  | 'prefers' | 'created' | 'belongs_to' | 'studies' | 'manages';

export interface EntityRelationRow {
  id: string;
  user_id: string;
  source_entity_id: string;
  target_entity_id: string;
  relation_type: RelationType;
  source_memory_id: string | null;
  confidence: number;
  valid_from: Date;
  valid_to: Date | null;
  created_at: Date;
}

/** Aggregate mutation statistics for a user's memory store. */
export interface MutationSummary {
  totalVersions: number;
  activeVersions: number;
  supersededVersions: number;
  totalClaims: number;
  byMutationType: Record<string, number>;
}

/** Single-memory audit trail entry for inspecting lifecycle. */
export interface AuditTrailEntry {
  versionId: string;
  claimId: string;
  content: string;
  mutationType: MutationType | null;
  mutationReason: string | null;
  actorModel: string | null;
  contradictionConfidence: number | null;
  previousVersionId: string | null;
  supersededByVersionId: string | null;
  validFrom: Date;
  validTo: Date | null;
  memoryId: string | null;
}

export function normalizeEntityRow(row: Record<string, unknown>): EntityRow {
  return {
    ...row,
    embedding: parseEmbedding(row.embedding),
    alias_names: Array.isArray(row.alias_names) ? row.alias_names : [],
    normalized_alias_names: Array.isArray(row.normalized_alias_names) ? row.normalized_alias_names : [],
  } as EntityRow;
}

export function normalizeAtomicFactRow(row: Record<string, unknown>): AtomicFactRow {
  return {
    ...row,
    embedding: parseEmbedding(row.embedding),
    metadata: parseMetadata(row.metadata),
  } as AtomicFactRow;
}

export function normalizeForesightRow(row: Record<string, unknown>): ForesightRow {
  return {
    ...row,
    embedding: parseEmbedding(row.embedding),
    metadata: parseMetadata(row.metadata),
  } as ForesightRow;
}
