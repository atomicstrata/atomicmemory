/**
 * @file AtomicMemory-specific namespaced handle
 *
 * Registered as `customExtensions['atomicmemory.*']` on AtomicMemoryProvider
 * per V3 spec (docs/providers-v3.md:391-402). Typed access via
 * `sdk.atomicmemory.*` on an SDK configured with an AtomicMemoryProvider.
 *
 * The namespace is a route-shaped HTTP binding for atomicmemory-core —
 * request types are semantically aligned with core's parseIngestBody /
 * parseSearchBody (SDK idiomatic camelCase + JS-native types; wire format
 * snake_case mapping happens in the handle implementation).
 *
 * V3 `Scope` is intentionally NOT embedded in these request types — scope
 * is always a separate argument using `MemoryScope` (the AtomicMemory-
 * specific discriminated union below) so workspace semantics are honest
 * per-method.
 */

// (V3 Memory intentionally NOT imported here — the namespace defines its
//  own memory shape so workspace scope round-trips honestly through the
//  handle signatures. See `AtomicMemoryMemory` below.)

// ---------------------------------------------------------------------------
// AtomicMemory-specific scope (discriminated union; not a V3 type)
// ---------------------------------------------------------------------------

/**
 * Agent visibility scope for workspace reads.
 *
 * Matches core's `parseOptionalAgentScope`
 * (atomicmemory-core/src/routes/memories.ts:617-627):
 * - `'all'` | `'self'` | `'others'` — the three canonical modes.
 * - any other string — treated as a single `agent_id` filter.
 * - `string[]` — a specific list of agent IDs to include.
 *
 * The `(string & {})` branch preserves the three literal hints in IDE
 * autocomplete while still permitting arbitrary strings.
 */
export type AgentScope =
  | 'all'
  | 'self'
  | 'others'
  // eslint-disable-next-line @typescript-eslint/ban-types
  | (string & {})
  | string[];

/**
 * AtomicMemory's canonical read-path contract. Mirrors core's `MemoryScope`
 * at `atomicmemory-core/src/services/memory-service-types.ts:142-144`.
 */
export type MemoryScope =
  | { kind: 'user'; userId: string; thread?: string }
  | {
      kind: 'workspace';
      userId: string;
      workspaceId: string;
      agentId: string;
      thread?: string;
      agentScope?: AgentScope;
    };

// ---------------------------------------------------------------------------
// Request types — scope-free, route-shaped
// ---------------------------------------------------------------------------

export interface AtomicMemoryIngestInput {
  /** Required, flat conversation string per core's parseIngestBody:517. */
  conversation: string;
  /** Required by core's parseIngestBody:518. */
  sourceSite: string;
  sourceUrl?: string;
  /**
   * Workspace write-time visibility label. Only honored when
   * `scope.kind === 'workspace'`; runtime validation throws InputError
   * if set with user scope.
   */
  visibility?: 'agent_only' | 'restricted' | 'workspace';
  /** Per-request core runtime override for benchmark and diagnostic runs. */
  configOverride?: Record<string, unknown>;
}

export interface AtomicMemorySearchRequest {
  query: string;
  limit?: number;
  /** Normalized relevance floor forwarded to core's `threshold` request field. */
  threshold?: number;
  /** Temporal filter. Honored by `/memories/search` full path; NOT by fast. */
  asOf?: Date;
  retrievalMode?: 'flat' | 'tiered' | 'abstract-aware';
  tokenBudget?: number;
  namespaceScope?: string;
  sourceSite?: string;
  skipRepair?: boolean;
  /** Per-request core runtime override for benchmark and diagnostic runs. */
  configOverride?: Record<string, unknown>;
}

export interface AtomicMemoryListOptions {
  limit?: number;
  offset?: number;
  /** User-scope only; ignored for workspace scope. */
  sourceSite?: string;
  /** User-scope only; ignored for workspace scope. */
  episodeId?: string;
}

/**
 * AtomicMemory-specific memory shape. Distinct from V3's flat `Memory` so
 * the namespace can preserve the full `MemoryScope` discriminated union
 * (including `workspaceId` / `agentId` / `agentScope`) on returned
 * memories — V3's `Scope` type has no place for workspace fields, so a
 * V3 Memory coming back from a workspace query would silently forget it
 * was scoped to a workspace.
 */
export interface AtomicMemoryMemory {
  id: string;
  content: string;
  scope: MemoryScope;
  createdAt: Date;
  updatedAt?: Date;
  importance?: number;
  sourceSite?: string;
  sourceUrl?: string;
  episodeId?: string;
  /** Workspace write-time visibility label on the stored memory. */
  visibility?: 'agent_only' | 'restricted' | 'workspace';
  metadata?: Record<string, unknown>;
}

export interface AtomicMemorySearchResult {
  memory: AtomicMemoryMemory;
  /** Backward-compatible alias for `rankingScore` when core emits it. */
  score: number;
  /** Semantic/vector similarity when emitted by core. */
  similarity?: number;
  /** Composite ranking/debug score from core's retrieval pipeline. Not normalized. */
  rankingScore?: number;
  /** Normalized injection relevance in [0, 1]. */
  relevance?: number;
  /** AtomicMemory's 0–1 importance weighting on the source memory. */
  importance?: number;
}

/**
 * Response shape for `/memories/search` and `/memories/search/fast`.
 * Mirrors core's `formatSearchResponse` (memories.ts:721-767) but with
 * SDK-idiomatic camelCase and wrapped memories (raw core response uses
 * snake_case and inline memory fields).
 */
export interface AtomicMemorySearchResultPage {
  count: number;
  retrievalMode: string;
  scope: MemoryScope;
  results: AtomicMemorySearchResult[];
  injectionText?: string;
  citations?: string[];
  tierAssignments?: Array<{
    memoryId: string;
    tier: string;
    estimatedTokens: number;
  }>;
  expandIds?: string[];
  estimatedContextTokens?: number;
  lessonCheck?: {
    safe: boolean;
    warnings: unknown[];
    highestSeverity: string;
    matchedCount: number;
  };
  consensus?: {
    originalCount: number;
    filteredCount: number;
    removedCount: number;
    removedMemoryIds: string[];
  };
  observability?: {
    retrieval?: unknown;
    packaging?: unknown;
    assembly?: unknown;
  };
}

/**
 * Response shape for `/memories/ingest` and `/memories/ingest/quick`.
 * Mirrors core's `IngestResult` (memory-service-types.ts:91-101) with
 * SDK-idiomatic camelCase.
 *
 * IDs are split by outcome: `storedMemoryIds` for newly created memories,
 * `updatedMemoryIds` for mutated ones. Length of each array matches its
 * corresponding `memoriesStored` / `memoriesUpdated` count.
 */
export interface AtomicMemoryIngestResult {
  episodeId: string;
  factsExtracted: number;
  memoriesStored: number;
  memoriesUpdated: number;
  memoriesDeleted: number;
  memoriesSkipped: number;
  storedMemoryIds: string[];
  updatedMemoryIds: string[];
  linksCreated: number;
  compositesCreated: number;
}

/**
 * Response shape for `/memories/list`.
 * Core returns `{ memories, count }`; cursor is derived from offset+limit.
 */
export interface AtomicMemoryListResultPage {
  memories: AtomicMemoryMemory[];
  count: number;
  cursor?: string;
}

// ---------------------------------------------------------------------------
// Category interfaces — per atomicmemory-core route cluster
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Lifecycle response types
// ---------------------------------------------------------------------------

/**
 * Scan-only response from `POST /memories/consolidate` when `execute: false`
 * (the default). Mirrors core's `ConsolidationResult`
 * (consolidation-service.ts).
 */
export interface ConsolidationScanResult {
  memoriesScanned: number;
  clustersFound: number;
  memoriesInClusters: number;
  /**
   * Cluster candidates identified by the scan. The per-cluster shape is
   * internal to core's consolidation engine and is intentionally typed as
   * `unknown[]` at the SDK boundary — consumers that need to inspect
   * cluster internals should pin a core version and read the shape from
   * there.
   */
  clusters: unknown[];
}

/**
 * Execution response from `POST /memories/consolidate` when `execute: true`.
 * Mirrors core's `ConsolidationExecutionResult`.
 */
export interface ConsolidationExecutionResult {
  clustersConsolidated: number;
  memoriesArchived: number;
  memoriesCreated: number;
  consolidatedMemoryIds: string[];
}

/**
 * Union returned by `lifecycle.consolidate`. Discriminated by the presence
 * of `consolidatedMemoryIds` (execution) vs `clusters` (scan-only).
 */
export type ConsolidationResult =
  | ConsolidationScanResult
  | ConsolidationExecutionResult;

/**
 * Response from `POST /memories/decay`. Mirrors core's `DecayResult` plus
 * the `archived` field added by the route handler (memories.ts:327/330).
 */
export interface DecayResult {
  memoriesEvaluated: number;
  candidatesForArchival: Array<{
    id: string;
    retentionScore: number;
    [key: string]: unknown;
  }>;
  retentionThreshold: number;
  avgRetentionScore: number;
  /**
   * Count of memories actually archived. Non-zero only when `dryRun=false`
   * and the scan found candidates (memories.ts:325-330).
   */
  archived: number;
}

/**
 * Mirrors core's `CapStatus` at memory-lifecycle.ts:133.
 * `warn` = approaching the cap (usageRatio >= warnRatio, default 0.8).
 * `exceeded` = over the cap.
 */
export type CapStatus = 'ok' | 'warn' | 'exceeded';

export type CapRecommendation =
  | 'none'
  | 'consolidate'
  | 'decay'
  | 'consolidate-and-decay';

/**
 * Response from `GET /memories/cap`. Mirrors core's `CapCheckResult`
 * (memory-lifecycle.ts).
 */
export interface CapCheckResult {
  activeMemories: number;
  maxMemories: number;
  status: CapStatus;
  usageRatio: number;
  recommendation: CapRecommendation;
}

/**
 * Response from `GET /memories/stats`. Core delegates to
 * `MemoryStore.getMemoryStats(userId)` which is an open shape; typed as
 * an index signature at the SDK boundary.
 */
export interface StatsResult {
  [key: string]: unknown;
}

/**
 * Response from `POST /memories/reset-source`. Route handler wraps
 * `resetBySource` with `{ success: true, ... }` (memories.ts:424).
 */
export interface ResetSourceResult {
  success: true;
  deletedMemories: number;
  deletedEpisodes: number;
}

/**
 * Response from `POST /memories/reconcile`. Mirrors core's
 * `ReconciliationResult` (deferred-audn.ts).
 */
export interface ReconciliationResult {
  processed: number;
  resolved: number;
  noops: number;
  updates: number;
  supersedes: number;
  deletes: number;
  adds: number;
  errors: number;
  durationMs: number;
}

/**
 * Response from `GET /memories/reconcile/status`. Core returns an open
 * shape from `getReconciliationStatus`; typed as index signature here.
 */
export interface ReconcileStatus {
  [key: string]: unknown;
}

/**
 * Admin lifecycle operations. Workspace scope is not accepted by any of
 * these routes — core parses `user_id` only (memories.ts:304, :322,
 * :340, :251, :421, :409).
 *
 * Exception: core's `POST /memories/reconcile` also accepts an all-users
 * batch-job mode (no `user_id` in the body; see memories.ts:397-400).
 * The SDK splits that into an explicit `reconcileAll()` method so the
 * all-users admin operation can't happen by accident from a missing
 * argument.
 */
export interface AtomicMemoryLifecycle {
  consolidate(userId: string, execute?: boolean): Promise<ConsolidationResult>;
  decay(userId: string, dryRun?: boolean): Promise<DecayResult>;
  cap(userId: string): Promise<CapCheckResult>;
  stats(userId: string): Promise<StatsResult>;
  resetSource(userId: string, sourceSite: string): Promise<ResetSourceResult>;
  /** Run deferred-AUDN reconciliation for a single user. */
  reconcile(userId: string): Promise<ReconciliationResult>;
  /**
   * Run deferred-AUDN reconciliation across all users (batch-job mode).
   * Maps to `POST /memories/reconcile` with no `user_id` in the body,
   * which core routes to `reconcileDeferredAll()`
   * (memories.ts:397-400). Intentionally exposed as a separate method
   * so callers can't trigger the all-users pass by forgetting a
   * `userId` argument.
   */
  reconcileAll(): Promise<ReconciliationResult>;
  reconcileStatus(userId: string): Promise<ReconcileStatus>;
}

// ---------------------------------------------------------------------------
// Audit response types
// ---------------------------------------------------------------------------

/**
 * Mirrors core's `MutationType` at
 * atomicmemory-core/src/db/repository-types.ts.
 */
export type MutationType = 'add' | 'update' | 'supersede' | 'delete' | 'clarify';

/**
 * Aggregate mutation statistics. Mirrors core's `MutationSummary`
 * (db/repository-types.ts). Emitted verbatim by GET /memories/audit/summary.
 */
export interface MutationSummary {
  totalVersions: number;
  activeVersions: number;
  supersededVersions: number;
  totalClaims: number;
  byMutationType: Record<string, number>;
}

/**
 * A single mutation record from `GET /memories/audit/recent`.
 *
 * The core route returns raw `ClaimVersionRow[]` (snake_case DB rows);
 * the SDK normalizes to camelCase so consumers aren't straddling two
 * conventions. `createdAt`, `validFrom`, and `validTo` are `Date`
 * values (deserialized from the wire ISO strings).
 */
export interface MutationRecord {
  id: string;
  claimId: string;
  userId: string;
  memoryId: string | null;
  content: string;
  mutationType: MutationType | null;
  mutationReason: string | null;
  actorModel: string | null;
  contradictionConfidence: number | null;
  previousVersionId: string | null;
  supersededByVersionId: string | null;
  validFrom: Date;
  validTo: Date | null;
  createdAt: Date;
}

/** Response shape for `GET /memories/audit/recent`. */
export interface RecentMutationsResult {
  mutations: MutationRecord[];
  count: number;
}

/**
 * Single-memory audit trail entry. Mirrors core's `AuditTrailEntry`
 * (db/repository-types.ts) verbatim — the service already emits
 * camelCase for this one (memory-crud.ts getAuditTrail).
 */
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

/** Response shape for `GET /memories/:id/audit`. */
export interface AuditTrailResult {
  memoryId: string;
  trail: AuditTrailEntry[];
  versionCount: number;
}

export interface AtomicMemoryAudit {
  /** `GET /memories/audit/summary` — aggregate mutation statistics for a user. */
  summary(userId: string): Promise<MutationSummary>;
  /** `GET /memories/audit/recent` — newest-first mutation records for a user. */
  recent(userId: string, limit?: number): Promise<RecentMutationsResult>;
  /** `GET /memories/:id/audit` — full version trail for a single memory. */
  trail(memoryId: string, userId: string): Promise<AuditTrailResult>;
}

// ---------------------------------------------------------------------------
// Lessons response types
// ---------------------------------------------------------------------------

/**
 * Mirrors core's `LessonType` at
 * atomicmemory-core/src/db/repository-lessons.ts:16-22.
 */
export type LessonType =
  | 'injection_blocked'
  | 'false_memory'
  | 'contradiction_pattern'
  | 'user_reported'
  | 'consensus_violation'
  | 'trust_violation';

/**
 * Mirrors core's `LessonSeverity` at
 * atomicmemory-core/src/db/repository-lessons.ts:24.
 */
export type LessonSeverity = 'low' | 'medium' | 'high' | 'critical';

/**
 * A single lesson. Mirrors core's `LessonRow`
 * (db/repository-lessons.ts:26-38), normalized to camelCase + Date on
 * the SDK boundary.
 */
export interface Lesson {
  id: string;
  userId: string;
  lessonType: LessonType;
  pattern: string;
  embedding: number[];
  sourceMemoryIds: string[];
  sourceQuery: string | null;
  severity: LessonSeverity;
  active: boolean;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

/** Response shape for `GET /memories/lessons`. */
export interface LessonsListResult {
  lessons: Lesson[];
  count: number;
}

/**
 * Aggregate lesson statistics from `GET /memories/lessons/stats`.
 * Mirrors core's `getLessonStats` return shape (lesson-service.ts).
 */
export interface LessonStats {
  totalActive: number;
  byType: Record<string, number>;
}

export interface AtomicMemoryLessons {
  /** `GET /memories/lessons` — list all active lessons for a user. */
  list(userId: string): Promise<LessonsListResult>;
  /** `GET /memories/lessons/stats` — aggregate counts by lesson type. */
  stats(userId: string): Promise<LessonStats>;
  /**
   * `POST /memories/lessons/report` — record a user-reported lesson
   * (explicit feedback path).
   */
  report(
    userId: string,
    pattern: string,
    sources?: string[],
    severity?: LessonSeverity,
  ): Promise<{ lessonId: string }>;
  /** `DELETE /memories/lessons/:id` — deactivate a lesson. */
  delete(lessonId: string, userId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Configuration response + request types
// ---------------------------------------------------------------------------

/**
 * Embedding provider names core ships. Mirrors
 * `EmbeddingProviderName` at atomicmemory-core/src/config.ts:14.
 */
export type EmbeddingProviderName =
  | 'openai'
  | 'ollama'
  | 'openai-compatible'
  | 'transformers';

/**
 * LLM provider names core ships. Mirrors `LLMProviderName` at
 * atomicmemory-core/src/config.ts:15.
 */
export type LLMProviderName =
  | EmbeddingProviderName
  | 'groq'
  | 'anthropic'
  | 'google-genai';

/**
 * Runtime configuration snapshot exposed by `/memories/health`'s `config`
 * field and `/memories/config`'s `config` response field. Mirrors core's
 * `formatHealthConfig` (memories.ts) with SDK-idiomatic camelCase.
 */
export interface HealthConfig {
  retrievalProfile: string;
  embeddingProvider: EmbeddingProviderName;
  embeddingModel: string;
  llmProvider: LLMProviderName;
  llmModel: string;
  clarificationConflictThreshold: number;
  maxSearchResults: number;
  hybridSearchEnabled: boolean;
  iterativeRetrievalEnabled: boolean;
  entityGraphEnabled: boolean;
  crossEncoderEnabled: boolean;
  agenticRetrievalEnabled: boolean;
  repairLoopEnabled: boolean;
}

/**
 * Response shape for `GET /memories/health`. Distinct from V3's
 * `HealthStatus` (types.ts) — V3 health is `{ok, latencyMs?, version?}`
 * (capability probe); core's route emits `{status, config}` (runtime
 * snapshot). Renamed to avoid the collision at SDK export time.
 */
export interface AtomicMemoryHealthStatus {
  status: 'ok';
  config: HealthConfig;
}

/**
 * Runtime-mutable threshold fields accepted by `PUT /memories/config`.
 * Mirrors the four fields core extracts from the body at memories.ts:
 * 284-289.
 *
 * Every field is optional; omitted fields are left untouched.
 * Provider/model selection is intentionally NOT exposed here — core
 * 400s startup-only fields (memories.ts:275-283). Callers should
 * restart the process with the relevant env vars to change those.
 */
export interface ConfigUpdates {
  similarityThreshold?: number;
  audnCandidateThreshold?: number;
  clarificationConflictThreshold?: number;
  maxSearchResults?: number;
}

/**
 * Success response from `PUT /memories/config`. Mirrors core's
 * success-path body at memories.ts:290-294.
 *
 * Note: core can return 410 (mutation disabled) or 400 (startup-only
 * field present) as HTTP errors; those are wrapped into the SDK's
 * MemoryProviderError by the shared fetch layer and should be caught
 * with try/catch, not inspected on this type.
 */
export interface ConfigUpdateResult {
  /** Field names that were actually applied (subset of ConfigUpdates keys). */
  applied: string[];
  /** Full updated runtime config snapshot. */
  config: HealthConfig;
  /** Human-readable note reminding that provider/model changes require restart. */
  note: string;
}

export interface AtomicMemoryConfig {
  /** `GET /memories/health` — current runtime config snapshot. */
  health(): Promise<AtomicMemoryHealthStatus>;
  /**
   * `PUT /memories/config` — apply runtime-mutable threshold updates.
   *
   * Requires the server to have been started with
   * `CORE_RUNTIME_CONFIG_MUTATION_ENABLED=true`; otherwise core returns
   * HTTP 410, which propagates as a thrown MemoryProviderError.
   */
  updateConfig(updates: ConfigUpdates): Promise<ConfigUpdateResult>;
}

// ---------------------------------------------------------------------------
// Agents response types
// ---------------------------------------------------------------------------

/**
 * Conflict resolution choices accepted by
 * `PUT /agents/conflicts/:id/resolve`. Mirrors core's VALID_RESOLUTIONS
 * set at atomicmemory-core/src/routes/agents.ts:102.
 */
export type ConflictResolution =
  | 'resolved_new'
  | 'resolved_existing'
  | 'resolved_both';

/**
 * Conflict status values core writes into the `memory_conflicts.status`
 * column. `open` is the initial state; the three resolution variants
 * come from manual resolution; `auto_resolved` comes from
 * `autoResolveExpiredConflicts`. Typed as a string union but kept open
 * via `string` to tolerate future status values without breaking the
 * SDK.
 */
export type ConflictStatus =
  | 'open'
  | 'resolved_new'
  | 'resolved_existing'
  | 'resolved_both'
  | 'auto_resolved';

/** Response shape for `PUT /agents/trust`. */
export interface SetTrustResult {
  agentId: string;
  trustLevel: number;
}

/**
 * Response shape for `GET /agents/trust`.
 *
 * `trustLevel` is always a number. When no trust record exists for
 * the (userId, agentId) pair, core returns `DEFAULT_TRUST_LEVEL` (0.5
 * as of today — see `atomicmemory-core/src/db/agent-trust-repository.ts:46,56`)
 * rather than `null`. Callers who need to distinguish "unset" from
 * "explicitly 0.5" must track the provenance themselves; the wire
 * contract does not expose the distinction.
 */
export interface GetTrustResult {
  agentId: string;
  trustLevel: number;
}

/**
 * A single agent conflict row. Mirrors core's `MemoryConflict`
 * (agent-trust-repository.ts), normalized to camelCase + Date at the
 * SDK boundary.
 */
export interface AgentConflict {
  id: string;
  userId: string;
  newMemoryId: string | null;
  existingMemoryId: string | null;
  newAgentId: string | null;
  existingAgentId: string | null;
  newTrustLevel: number | null;
  existingTrustLevel: number | null;
  contradictionConfidence: number;
  clarificationNote: string | null;
  status: ConflictStatus;
  resolutionPolicy: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
  autoResolveAfter: Date | null;
}

/** Response shape for `GET /agents/conflicts`. */
export interface ConflictsListResult {
  conflicts: AgentConflict[];
  count: number;
}

/**
 * Response shape for `PUT /agents/conflicts/:id/resolve`.
 * `status` echoes the resolution you passed in.
 */
export interface ResolveConflictResult {
  id: string;
  status: ConflictResolution;
}

/** Response shape for `POST /agents/conflicts/auto-resolve`. */
export interface AutoResolveConflictsResult {
  /** Count of conflicts transitioned to `auto_resolved` state. */
  resolved: number;
}

export interface AtomicMemoryAgents {
  /**
   * `PUT /agents/trust` — set or update a (userId, agentId) trust
   * record. `trustLevel` must be between 0.0 and 1.0 (core validates).
   * Optional `displayName` is a human-readable label.
   */
  setTrust(
    userId: string,
    agentId: string,
    trustLevel: number,
    displayName?: string,
  ): Promise<SetTrustResult>;

  /**
   * `GET /agents/trust` — look up a single (userId, agentId) trust
   * record. When no record exists, core returns a default trust level
   * (currently 0.5) rather than 404. See `GetTrustResult` for the
   * unset-vs-0.5 caveat.
   */
  getTrust(userId: string, agentId: string): Promise<GetTrustResult>;

  /** `GET /agents/conflicts` — list open conflicts for a user. */
  conflicts(userId: string): Promise<ConflictsListResult>;

  /**
   * `PUT /agents/conflicts/:id/resolve` — manually resolve one
   * conflict. NB: this route takes `conflictId` (not `userId`) because
   * core resolves by conflict id directly (agents.ts:61-72).
   */
  resolveConflict(
    conflictId: string,
    resolution: ConflictResolution,
  ): Promise<ResolveConflictResult>;

  /**
   * `POST /agents/conflicts/auto-resolve` — trigger the batch
   * auto-resolution pass for a user. Transitions any `open` conflicts
   * whose `auto_resolve_after` deadline has elapsed into
   * `auto_resolved` state. Returns the count transitioned.
   */
  autoResolveConflicts(userId: string): Promise<AutoResolveConflictsResult>;
}

// ---------------------------------------------------------------------------
// Root handle — aggregates base routes + category sub-accessors
// ---------------------------------------------------------------------------

/**
 * AtomicMemory-specific SDK handle. Access via `sdk.atomicmemory` when an
 * AtomicMemoryProvider is registered. `sdk.atomicmemory` is `undefined`
 * for SDK configurations that do not include AtomicMemoryProvider.
 */
export interface AtomicMemoryHandle {
  // Base routes
  ingestFull(
    input: AtomicMemoryIngestInput,
    scope: MemoryScope,
  ): Promise<AtomicMemoryIngestResult>;
  ingestQuick(
    input: AtomicMemoryIngestInput,
    scope: MemoryScope,
    options?: { skipExtraction?: boolean },
  ): Promise<AtomicMemoryIngestResult>;
  search(
    request: AtomicMemorySearchRequest,
    scope: MemoryScope,
  ): Promise<AtomicMemorySearchResultPage>;
  /**
   * Fast search path. Does NOT honor `request.asOf` — core's handler at
   * `atomicmemory-core/src/routes/memories.ts:191-206` parses `as_of`
   * but drops it. Use `search()` for temporal queries.
   */
  searchFast(
    request: AtomicMemorySearchRequest,
    scope: MemoryScope,
  ): Promise<AtomicMemorySearchResultPage>;
  expand(refs: string[], scope: MemoryScope): Promise<AtomicMemoryMemory[]>;
  list(
    scope: MemoryScope,
    options?: AtomicMemoryListOptions,
  ): Promise<AtomicMemoryListResultPage>;
  get(id: string, scope: MemoryScope): Promise<AtomicMemoryMemory | null>;
  delete(id: string, scope: MemoryScope): Promise<void>;

  // Category sub-accessors
  lifecycle: AtomicMemoryLifecycle;
  audit: AtomicMemoryAudit;
  lessons: AtomicMemoryLessons;
  config: AtomicMemoryConfig;
  agents: AtomicMemoryAgents;
}

// ---------------------------------------------------------------------------
// Custom-extension names (V3 registry keys)
// ---------------------------------------------------------------------------

export const ATOMICMEMORY_EXTENSION_NAMES = [
  'atomicmemory.base',
  'atomicmemory.lifecycle',
  'atomicmemory.audit',
  'atomicmemory.lessons',
  'atomicmemory.config',
  'atomicmemory.agents',
] as const;

export type AtomicMemoryExtensionName =
  (typeof ATOMICMEMORY_EXTENSION_NAMES)[number];
