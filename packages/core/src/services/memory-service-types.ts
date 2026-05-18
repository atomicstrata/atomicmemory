/**
 * Internal types shared between memory-service and its helpers.
 */

import { type TrustScore } from './trust-scoring.js';
import { type ExtractedEntity, type ExtractedRelation } from './extraction.js';
import { type MemoryNetwork } from './memory-network.js';
import type { AUDNAction } from './extraction.js';
import type { BeliefOperator } from './typed-belief-calculus.js';
import { type ClaimSlotInput } from '../db/claim-repository.js';

export interface FactInput {
  fact: string;
  headline: string;
  importance: number;
  type: 'preference' | 'project' | 'knowledge' | 'person' | 'plan';
  keywords: string[];
  entities: ExtractedEntity[];
  relations: ExtractedRelation[];
  network?: MemoryNetwork;
  opinionConfidence?: number | null;
}

export interface ClaimTarget {
  claimId: string;
  versionId: string;
  memoryId: string;
  cmoId: string | null;
}

export type Outcome = 'stored' | 'updated' | 'deleted' | 'skipped' | 'preserved_contradiction';

export type IngestTraceAction = AUDNAction | 'SKIP';

export type IngestTraceReasonCode =
  | 'verbatim-store'
  | 'write-security-sanitization'
  | 'write-security-trust'
  | 'entropy-gate'
  | 'direct-store-no-candidates'
  | 'workspace-direct-store'
  | 'fast-audn-noop'
  | 'quick-duplicate-noop'
  | 'deferred-audn-store'
  | 'llm-audn-add'
  | 'llm-audn-noop'
  | 'llm-audn-clarify'
  | 'llm-audn-update'
  | 'llm-audn-delete'
  | 'llm-audn-supersede'
  | 'llm-audn-bilateral-preserve'
  | 'invalid-target-fallback'
  | 'tbc-affirm'
  | 'tbc-update'
  | 'tbc-retract'
  | 'tbc-supersede'
  | 'tbc-promote'
  | 'tbc-demote'
  | 'tbc-evidence-for'
  | 'tbc-counter';

export interface IngestTraceCandidate {
  id: string;
  similarity: number;
  contentPreview: string;
}

export interface IngestTraceDecision {
  source: 'direct-store' | 'fast-audn' | 'quick-dedup' | 'deferred-audn' | 'llm-audn' | 'write-security' | 'entropy-gate' | 'verbatim' | 'tbc';
  action: IngestTraceAction;
  reasonCode: IngestTraceReasonCode;
  targetMemoryId: string | null;
  rawAction?: string;
  candidateIds?: string[];
  /**
   * Phase 2 (TBC): chosen typed belief operator when the ingest routed
   * through the Typed Belief Calculus resolver. Absent when the AUDN
   * path executed (default).
   */
  beliefOperator?: BeliefOperator;
}

export interface IngestFactTrace {
  factText: string;
  headline: string;
  factType: FactInput['type'] | 'verbatim';
  importance: number;
  logicalTimestamp?: string;
  writeSecurity?: {
    allowed: boolean;
    blockedBy: string | null;
    trustScore: number;
  };
  entropyGate?: {
    score: number;
    entityNovelty: number;
    semanticNovelty: number;
    accepted: boolean;
  };
  candidates?: IngestTraceCandidate[];
  decision: IngestTraceDecision;
  outcome: Outcome;
  memoryId: string | null;
  /**
   * Phase 2 (TBC): chosen typed belief operator surfaced at the top level
   * so observability consumers can filter traces without inspecting
   * `decision.beliefOperator`. Absent when the AUDN path executed.
   */
  beliefOperator?: BeliefOperator;
}

export interface FactResult {
  outcome: Outcome;
  memoryId: string | null;
  embedding?: number[];
  trace?: IngestFactTrace;
}

export interface AtomicFactProjection {
  factText: string;
  embedding: number[];
  factType: FactInput['type'];
  importance: number;
  keywords: string[];
  metadata?: Record<string, unknown>;
}

export interface ForesightProjection {
  content: string;
  embedding: number[];
  foresightType: 'plan' | 'goal' | 'scheduled' | 'expected_state';
  validFrom?: Date;
  validTo?: Date | null;
  metadata?: Record<string, unknown>;
}

const TRUST_PASS: TrustScore = {
  score: 1.0, domainTrust: 1.0, contentPenalty: 0, injectionPenalty: 0,
  sanitization: { passed: true, findings: [], highestSeverity: 'none' as const },
};

/** Mutable state accumulated across a batch for entropy gating. */
export interface EntropyContext {
  seenEntities: Set<string>;
  previousEmbedding: number[] | null;
}

/** Retrieval/search mode for search results. */
export type RetrievalMode = 'flat' | 'tiered' | 'abstract-aware';

/** Retrieval strategy controls which indexed representation powers search. */
export type SearchStrategy = 'memory' | 'fact-hybrid';

/**
 * Shared context bundle passed through the AUDN decision pipeline.
 * Reduces parameter count across tryOpinionIntercept, storeClarification,
 * executeMutationDecision, and related helpers.
 */
export interface AudnFactContext {
  userId: string;
  fact: FactInput;
  embedding: number[];
  sourceSite: string;
  sourceUrl: string;
  episodeId: string;
  trustScore: number;
  claimSlot?: ClaimSlotInput | null;
  logicalTimestamp?: Date;
  /** Phase 5 Step 10: workspace scope for workspace-originated facts. */
  workspace?: import('../db/repository-types.js').WorkspaceContext;
}

export interface IngestResult {
  episodeId: string;
  factsExtracted: number;
  memoriesStored: number;
  memoriesUpdated: number;
  memoriesDeleted: number;
  memoriesSkipped: number;
  /**
   * IDs of memories newly created during this ingest (outcome === 'stored').
   * Length matches `memoriesStored`.
   */
  storedMemoryIds: string[];
  /**
   * IDs of memories mutated during this ingest (outcome === 'updated').
   * Length matches `memoriesUpdated`.
   */
  updatedMemoryIds: string[];
  /**
   * Union of stored + updated IDs in traversal order. Internal consumers
   * (post-write processors, in-process callers) iterate over every
   * touched memory without caring about the outcome split.
   */
  memoryIds: string[];
  linksCreated: number;
  compositesCreated: number;
  ingestTraceId?: string;
}

export interface RetrievalResult {
  memories: import('../db/repository-types.js').SearchResult[];
  injectionText: string;
  citations: string[];
  retrievalMode: RetrievalMode;
  tierAssignments?: import('./tiered-loading.js').TierAssignment[];
  expandIds?: string[];
  estimatedContextTokens?: number;
  /**
   * True when the requested token budget changed the package content
   * relative to the unconstrained tiered package. See
   * InjectionBuildResult.budgetConstrained for the precise contract.
   * Required field — every code path that constructs a RetrievalResult
   * must set it so the wire contract (`/memories/search` response
   * `budget_constrained`) is always source-truthful.
   */
  budgetConstrained: boolean;
  lessonCheck?: import('./lesson-service.js').LessonCheckResult;
  consensusResult?: import('./consensus-validation.js').ConsensusResult;
  packagingSignal?: import('./retrieval-format.js').PackagingSignal;
  retrievalSummary?: import('./retrieval-trace.js').RetrievalTraceSummary;
  packagingSummary?: import('./retrieval-trace.js').PackagingTraceSummary;
  assemblySummary?: import('./retrieval-trace.js').AssemblyTraceSummary;
  /**
   * Phase 2 specialist answer (BEAM-0.85 Phase 2). Present when a specialist
   * handled the query — its value is the literal answer to return to the user,
   * bypassing the harness's LLM call. The `injection_text` field still
   * contains the retrieved-memory context for observability; callers that
   * understand this field should return `specialist_answer` directly without
   * an additional LLM pass.
   */
  specialistAnswer?: string;
}

/** Options controlling retrieval packaging. */
export interface RetrievalOptions {
  retrievalMode?: RetrievalMode;
  tokenBudget?: number;
  searchStrategy?: SearchStrategy;
  /** Minimum normalized relevance required before injection packaging. */
  relevanceThreshold?: number;
  /** Skip the LLM repair loop for latency-critical paths. */
  skipRepairLoop?: boolean;
  /** Skip cross-encoder reranking for latency-critical paths. */
  skipReranking?: boolean;
  /**
   * Active conversation ID for cross-channel injection. Currently used by the
   * always-on ENTITY_CARD channel to read per-conversation cards before
   * assembling the answer prompt. Absent → cards are not injected.
   */
  conversationId?: string;
}

/**
 * Canonical runtime read-path scope contract.
 *
 * Used by search, expand, and (eventually) list/get/delete to dispatch
 * between user-scoped and workspace-scoped operations. The workspace
 * variant carries agentId for visibility enforcement and agentScope for
 * filtering which agents' memories to include.
 *
 * Note: ingest uses WorkspaceContext directly (needs visibility field
 * for writes). MemoryScope covers reads only until a unified
 * write-context type is introduced (Phase 5).
 */
export type MemoryScope =
  | { kind: 'user'; userId: string }
  | { kind: 'workspace'; userId: string; workspaceId: string; agentId: string; agentScope?: import('../db/repository-types.js').AgentScope };

/** Options bag for scope-dispatching search methods. */
export interface ScopedSearchOptions {
  sourceSite?: string;
  limit?: number;
  asOf?: string;
  referenceTime?: Date;
  namespaceScope?: string;
  sessionId?: string;
  retrievalOptions?: RetrievalOptions;
  /** When true, skips the LLM repair loop (used by /search/fast). */
  fast?: boolean;
  /**
   * Request-scoped effective config overlaying the startup singleton.
   * When provided, replaces `deps.config` for the duration of the call.
   * Populated by the route layer after merging a validated body-level
   * `config_override`. Absent → startup config flows through unchanged.
   */
  effectiveConfig?: MemoryServiceDeps['config'];
}

/** Supported observability payload for retrieval responses. */
export interface RetrievalObservability {
  retrieval?: import('./retrieval-trace.js').RetrievalTraceSummary;
  packaging?: import('./retrieval-trace.js').PackagingTraceSummary;
  assembly?: import('./retrieval-trace.js').AssemblyTraceSummary;
}

/**
 * Internal dependency bundle for memory service sub-modules.
 * Exposes the repositories and optional services needed by ingest, search, and CRUD.
 */
export interface MemoryServiceDeps {
  config: import('../app/runtime-container.js').CoreRuntimeConfig & IngestRuntimeConfig;
  /** Domain-facing store interfaces (Phase 5). */
  stores: import('../db/stores.js').CoreStores;
  observationService: import('./observation-service.js').ObservationService | null;
  /** Phase 4 TLL — per-entity event chains for EO/MSR/TR retrieval. */
  tllRepository: import('../db/repository-tll.js').TllRepository | null;
  /** First-mention events — chronological topic-introduction list. */
  firstMentionService: import('./first-mention-service.js').FirstMentionService | null;
  uriResolver: import('./atomicmem-uri.js').URIResolver;
  /**
   * Async Reflect work queue (BEAM-0.85 Phase 1). When present and
   * reflectEnabled is true, ingest enqueues a reflection job after AUDN
   * commits the memory. Enqueue failure NEVER blocks the ingest response.
   */
  reflectionJobs?: import('../db/reflection-jobs-repository.js').ReflectionJobsRepository;
  /**
   * Feature gate for the async Reflect step. Must be true AND reflectionJobs
   * must be provided for enqueue to run. Default false (no enqueue).
   */
  reflectEnabled?: boolean;
  /**
   * Optional Phase-3 raw-content adapter. Wired when the deployment
   * runs `rawStorageMode='managed_blob'` so reset-source / wipe paths
   * can clean up blob bytes after the DB cascade. `null` for
   * pointer-only deployments — cascades still run, blob lists come
   * back empty.
   */
  rawContentStore?: import('../storage/raw-content-store.js').RawContentStore | null;
  /**
   * Phase 4a per-row provider dispatch registry. Composition-root code
   * passes a multi-provider registry when
   * `RAW_STORAGE_LEGACY_PROVIDERS` is set; otherwise the registry
   * wraps the single active `rawContentStore`.
   */
  storeRegistry?: import('../storage/store-registry.js').RawContentStoreRegistry;
}

/** Explicit ingest/runtime config subset threaded through current ingest seams. */
export interface IngestRuntimeConfig {
  audnCandidateThreshold: number;
  auditLoggingEnabled: boolean;
  chunkedExtractionEnabled: boolean;
  chunkedExtractionFallbackEnabled: boolean;
  chunkSizeTurns: number;
  chunkOverlapTurns: number;
  compositeGroupingEnabled: boolean;
  compositeMinClusterSize: number;
  consensusExtractionEnabled: boolean;
  consensusExtractionRuns: number;
  extractionCacheEnabled: boolean;
  observationDateExtractionEnabled: boolean;
  quotedEntityExtractionEnabled: boolean;
  entityGraphEnabled: boolean;
  entropyGateAlpha: number;
  entropyGateEnabled: boolean;
  entropyGateThreshold: number;
  fastAudnDuplicateThreshold: number;
  fastAudnEnabled: boolean;
  ingestTraceEnabled: boolean;
  lessonsEnabled: boolean;
  llmModel: string;
  trustScoringEnabled: boolean;
  trustScoreMinThreshold: number;
  /**
   * Typed Belief Calculus gate (Phase 1 scaffold). When true, future TBC
   * code paths (Phase 2+) take precedence over AUDN. Default false — has
   * no runtime effect today. See services/typed-belief-calculus.ts.
   */
  tbcEnabled: boolean;
  /**
   * Hierarchical retrieval gate. When true, ingest generates session +
   * conversation summaries (session-summary-generator.ts); search adds a 5th
   * RRF arm over those summaries. Default false — no runtime effect today.
   */
  hierarchicalRetrievalEnabled: boolean;
  /**
   * Topic abstraction layer (Sprint 3 EO experiment). When true, the post-
   * write pipeline runs an extra LLM call per chunk to extract a 3-7 word
   * conceptual topic, embeds it, and tags every memory from the chunk.
   * Default false. See services/topic-abstraction.ts.
   */
  topicAbstractionEnabled: boolean;
  /**
   * Topic search arm. When true (and topic_embedding rows exist), search
   * adds a topic-similarity RRF channel. Default false.
   */
  topicSearchEnabled: boolean;
  /**
   * Recap layer (cross-session synthesis). When true, post-write
   * synthesizes Recaps from topic-abstraction clusters. Default false.
   */
  recapLayerEnabled: boolean;
  /** Min cluster size for recap building. */
  recapMinClusterSize: number;
  /** Recap cluster pivot ('topic' | 'session'). Default 'topic'. */
  recapClusterPivot: 'topic' | 'session';
  /**
   * User-profile channel (Sprint 3 v1.5 — H2). When true, post-write
   * synthesizes a per-user profile document and search prepends it to
   * the answer prompt under `## USER PROFILE`. Default false.
   */
  userProfileChannelEnabled: boolean;
  /**
   * Entity-Attribute Index (Sprint 4 — EAI). When true, post-write runs
   * an LLM pass that extracts (entity, attribute, value, value_type)
   * quadruples from the conversation and stores them in the
   * entity_attributes table for specific-fact retrieval. Default false.
   */
  entityAttributesEnabled: boolean;
  /**
   * BEAM CR fix: AUDN bilateral preservation. When true, AUDN DELETE and
   * SUPERSEDE outcomes are replaced with the bilateral path that keeps
   * both memories and records the pair in `memory_contradictions`. Both
   * memory rows get `contradiction_active=true` and bidirectional
   * `contradicts_memory_id`. Default false.
   */
  contradictionPreservationEnabled: boolean;
}
