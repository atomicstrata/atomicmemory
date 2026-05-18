/**
 * @file AtomicMemoryHandle implementation for base routes
 *
 * Wires the 9 namespaced base-route methods directly to atomicmemory-core's
 * HTTP surface:
 *   ingestFull, ingestQuick (incl. skipExtraction), search, searchFast,
 *   expand, list, get, delete.
 *
 * Category handles cover lifecycle, audit, lessons, config, and agents.
 *
 * Namespace-specific mapping: returned memories carry the full
 * `MemoryScope` discriminated union (not V3's flat `Scope`), so workspace
 * results preserve `workspaceId` / `agentId` / `agentScope`. V3's
 * existing `toMemory` / `toSearchResult` mappers are intentionally NOT
 * reused here because they flatten scope to `{ user }` and drop
 * `similarity` + `importance` into `metadata`.
 */

import type { HttpOptions } from './http';
import { fetchJson, fetchJsonOrNull, fetchVoid } from './http';

/**
 * A function that prepends the configured API-version prefix (e.g.
 * `/v1`) to a route path. Injected from AtomicMemoryProvider so the
 * handle doesn't need to know about config.
 */
type Route = (path: string) => string;
import type {
  AtomicMemoryAgents,
  AtomicMemoryAudit,
  AtomicMemoryConfig,
  AtomicMemoryHandle,
  AtomicMemoryIngestInput,
  AtomicMemoryIngestResult,
  AtomicMemoryLessons,
  AtomicMemoryLifecycle,
  AtomicMemoryListOptions,
  AtomicMemoryListResultPage,
  AtomicMemoryMemory,
  AtomicMemorySearchRequest,
  AtomicMemorySearchResult,
  AtomicMemorySearchResultPage,
  AgentConflict,
  AuditTrailEntry,
  AuditTrailResult,
  AutoResolveConflictsResult,
  CapCheckResult,
  ConfigUpdates,
  ConfigUpdateResult,
  ConflictsListResult,
  ConsolidationResult,
  DecayResult,
  GetTrustResult,
  HealthConfig,
  ResolveConflictResult,
  SetTrustResult,
  Lesson,
  LessonsListResult,
  LessonStats,
  LessonSeverity,
  MemoryScope,
  MutationRecord,
  MutationSummary,
  RecentMutationsResult,
  ReconciliationResult,
  ReconcileStatus,
  ResetSourceResult,
  StatsResult,
} from './handle';
import {
  assertScopeAllowsVisibility,
  scopeToFields,
  scopeToQueryParams,
  stripAgentScope,
  stripReadFilters,
} from './scope-mapper';

export function createAtomicMemoryHandle(
  http: HttpOptions,
  route: Route,
): AtomicMemoryHandle {
  return {
    async ingestFull(input, scope) {
      return postIngest(http, route('/memories/ingest'), input, scope);
    },
    async ingestQuick(input, scope, options) {
      const skipExtraction = options?.skipExtraction === true;
      return postIngest(
        http,
        route('/memories/ingest/quick'),
        input,
        scope,
        { skipExtraction },
      );
    },
    async search(request, scope) {
      return postSearch(http, route('/memories/search'), request, scope);
    },
    async searchFast(request, scope) {
      // Core's fast-search handler parses `as_of` but drops it
      // (memories.ts:191-206). We still send it on the wire for forward
      // compat, but consumers should not rely on temporal semantics here.
      return postSearch(http, route('/memories/search/fast'), request, scope);
    },
    async expand(refs, scope) {
      // agent_scope deliberately omitted — core's /expand drops it.
      const body = {
        ...scopeToFields(scope),
        memory_ids: refs,
      };
      const raw = await fetchJson<{ memories: unknown[] }>(
        http,
        route('/memories/expand'),
        { method: 'POST', body: JSON.stringify(body) },
      );
      // Echo back the scope WITHOUT agentScope: core didn't apply that
      // filter on expand, so returned memories must not claim otherwise.
      const echoedScope = stripReadFilters(scope);
      return raw.memories.map((m) => toAtomicMemoryMemory(m, echoedScope));
    },
    async list(scope, options) {
      // agent_scope deliberately omitted — core's /list drops it.
      // sourceSite/episodeId are user-scope only: core parses + validates
      // episode_id *before* branching (memories.ts:234), so a workspace
      // call with these options can get a spurious 400 on UUID validation
      // for an option core was going to ignore anyway. Fail closed in the
      // SDK so the mismatch surfaces at the call site.
      assertListOptionsScopeCompat(scope, options);

      const params = scopeToQueryParams(scope, { includeThread: true });
      if (options?.limit !== undefined) params.set('limit', String(options.limit));
      if (options?.offset !== undefined) params.set('offset', String(options.offset));
      if (options?.sourceSite) params.set('source_site', options.sourceSite);
      if (options?.episodeId) params.set('episode_id', options.episodeId);

      const raw = await fetchJson<{ memories: unknown[]; count: number }>(
        http,
        route(`/memories/list?${params.toString()}`),
      );

      const limit = options?.limit ?? 20;
      const offset = options?.offset ?? 0;
      const nextOffset = offset + raw.memories.length;
      const hasMore = raw.memories.length === limit;
      const echoedScope = stripAgentScope(scope);

      return {
        memories: raw.memories.map((m) => toAtomicMemoryMemory(m, echoedScope)),
        count: raw.count,
        ...(hasMore ? { cursor: String(nextOffset) } : {}),
      };
    },
    async get(id, scope) {
      // agent_scope/thread deliberately omitted — core's /:id GET is id-keyed
      // and does not apply those read filters. The returned scope reflects the
      // persisted row, not the caller's unapplied filter.
      const params = scopeToQueryParams(stripReadFilters(scope));
      const raw = await fetchJsonOrNull<unknown>(
        http,
        route(`/memories/${encodeURIComponent(id)}?${params.toString()}`),
      );
      if (!raw) return null;
      // Echoed scope drops unapplied filters — see expand() note above.
      return toAtomicMemoryMemory(raw, stripReadFilters(scope));
    },
    async delete(id, scope) {
      // agent_scope/thread deliberately omitted — core's /:id DELETE is id-keyed.
      const params = scopeToQueryParams(stripReadFilters(scope));
      try {
        await fetchVoid(
          http,
          route(`/memories/${encodeURIComponent(id)}?${params.toString()}`),
          { method: 'DELETE' },
        );
      } catch (err) {
        // 404 on delete is a no-op per V3 contract — but for workspace
        // scope, core returns 404 when the memory doesn't exist in the
        // agent's visibility, and consumers still need to see that.
        // Matches the existing AtomicMemoryProvider.doDelete behavior.
        if (err instanceof Error && err.message.includes('HTTP 404')) {
          return;
        }
        throw err;
      }
    },

    lifecycle: createLifecycleHandle(http, route),
    audit: createAuditHandle(http, route),
    lessons: createLessonsHandle(http, route),
    config: createConfigHandle(http, route),
    agents: createAgentsHandle(http, route),
  };
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

function assertListOptionsScopeCompat(
  scope: MemoryScope,
  options: AtomicMemoryListOptions | undefined,
): void {
  if (scope.kind !== 'workspace') return;
  if (options?.sourceSite !== undefined) {
    throw new Error(
      '`sourceSite` is only valid on user scope; core ignores it on '
        + 'workspace list queries (memories.ts:238). Omit the option or '
        + 'use a user-scope list.',
    );
  }
  if (options?.episodeId !== undefined) {
    throw new Error(
      '`episodeId` is only valid on user scope; core ignores it on '
        + 'workspace list queries (memories.ts:238) but still validates '
        + 'it as a UUID before branching, which can surface as a 400. '
        + 'Omit the option or use a user-scope list.',
    );
  }
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function postIngest(
  http: HttpOptions,
  path: string,
  input: AtomicMemoryIngestInput,
  scope: MemoryScope,
  options?: { skipExtraction?: boolean },
): Promise<AtomicMemoryIngestResult> {
  assertScopeAllowsVisibility(scope, input.visibility);

  const body: Record<string, unknown> = {
    ...scopeToFields(scope, { includeThread: true }),
    conversation: input.conversation,
    source_site: input.sourceSite,
    source_url: input.sourceUrl ?? '',
  };
  if (scope.kind === 'workspace' && input.visibility) {
    body.visibility = input.visibility;
  }
  if (input.configOverride !== undefined) {
    body.config_override = input.configOverride;
  }
  if (options?.skipExtraction) {
    body.skip_extraction = true;
  }

  const raw = await fetchJson<RawIngestResponse>(http, path, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return toIngestResult(raw);
}

/**
 * Raw snake_case wire shape emitted by `POST /memories/ingest` and
 * `POST /memories/ingest/quick`. Maps to `AtomicMemoryIngestResult`.
 */
interface RawIngestResponse {
  episode_id: string;
  facts_extracted: number;
  memories_stored: number;
  memories_updated: number;
  memories_deleted: number;
  memories_skipped: number;
  stored_memory_ids: string[];
  updated_memory_ids: string[];
  links_created: number;
  composites_created: number;
}

function toIngestResult(raw: RawIngestResponse): AtomicMemoryIngestResult {
  return {
    episodeId: raw.episode_id,
    factsExtracted: raw.facts_extracted,
    memoriesStored: raw.memories_stored,
    memoriesUpdated: raw.memories_updated,
    memoriesDeleted: raw.memories_deleted,
    memoriesSkipped: raw.memories_skipped,
    storedMemoryIds: raw.stored_memory_ids,
    updatedMemoryIds: raw.updated_memory_ids,
    linksCreated: raw.links_created,
    compositesCreated: raw.composites_created,
  };
}

async function postSearch(
  http: HttpOptions,
  path: string,
  request: AtomicMemorySearchRequest,
  scope: MemoryScope,
): Promise<AtomicMemorySearchResultPage> {
  // agent_scope is honored ONLY on search routes — opt in here.
  const scopeFields = scopeToFields(scope, {
    includeAgentScope: true,
    includeThread: true,
  });
  const body: Record<string, unknown> = {
    ...scopeFields,
    query: request.query,
  };
  if (request.limit !== undefined) body.limit = request.limit;
  if (request.threshold !== undefined) body.threshold = request.threshold;
  if (request.asOf) body.as_of = request.asOf.toISOString();
  if (request.retrievalMode) body.retrieval_mode = request.retrievalMode;
  if (request.tokenBudget !== undefined) body.token_budget = request.tokenBudget;
  if (request.namespaceScope) body.namespace_scope = request.namespaceScope;
  if (request.sourceSite) body.source_site = request.sourceSite;
  if (request.skipRepair) body.skip_repair = true;
  if (request.configOverride !== undefined) body.config_override = request.configOverride;

  const raw = await fetchJson<RawSearchResponse>(http, path, {
    method: 'POST',
    body: JSON.stringify(body),
  });

  return mapSearchResponse(raw, scope);
}

// ---------------------------------------------------------------------------
// Namespace-specific response shapes and mappers
// ---------------------------------------------------------------------------

interface RawMemoryResponse {
  id: string;
  content?: string;
  similarity?: number;
  semantic_similarity?: number;
  score?: number;
  ranking_score?: number;
  relevance?: number;
  importance?: number;
  source_site?: string;
  source_url?: string;
  episode_id?: string;
  visibility?: 'agent_only' | 'restricted' | 'workspace';
  created_at?: string;
  updated_at?: string;
  metadata?: Record<string, unknown>;
  session_id?: string | null;
}

interface RawSearchResponse {
  count?: number;
  retrieval_mode?: string;
  scope?: unknown;
  memories?: RawMemoryResponse[];
  injection_text?: string;
  citations?: string[];
  tier_assignments?: Array<{
    memory_id: string;
    tier: string;
    estimated_tokens: number;
  }>;
  expand_ids?: string[];
  estimated_context_tokens?: number;
  lesson_check?: {
    safe: boolean;
    warnings: unknown[];
    highest_severity: string;
    matched_count: number;
  };
  consensus?: {
    original_count: number;
    filtered_count: number;
    removed_count: number;
    removed_memory_ids: string[];
  };
  observability?: {
    retrieval?: unknown;
    packaging?: unknown;
    assembly?: unknown;
  };
}

/**
 * Map a raw core memory response into an `AtomicMemoryMemory`, preserving
 * the full `MemoryScope` of the request (so workspace queries return
 * memories that still know they came from a workspace).
 */
function toAtomicMemoryMemory(
  raw: unknown,
  scope: MemoryScope,
): AtomicMemoryMemory {
  const r = raw as RawMemoryResponse;
  const result: AtomicMemoryMemory = {
    id: r.id,
    content: r.content ?? '',
    scope: buildMemoryScope(r, scope),
    createdAt: r.created_at ? new Date(r.created_at) : new Date(),
  };
  if (r.updated_at) result.updatedAt = new Date(r.updated_at);
  if (r.importance !== undefined) result.importance = r.importance;
  if (r.source_site !== undefined) result.sourceSite = r.source_site;
  if (r.source_url !== undefined) result.sourceUrl = r.source_url;
  if (r.episode_id !== undefined) result.episodeId = r.episode_id;
  if (r.visibility !== undefined) result.visibility = r.visibility;
  if (r.metadata !== undefined) result.metadata = r.metadata;
  return result;
}

function buildMemoryScope(
  raw: RawMemoryResponse,
  requestedScope: MemoryScope,
): MemoryScope {
  if (requestedScope.thread !== undefined) {
    if (!raw.session_id) {
      throw new Error(
        'atomicmemory-provider: backend response missing required `session_id` for thread-scoped request',
      );
    }
    if (raw.session_id !== requestedScope.thread) {
      throw new Error(
        'atomicmemory-provider: backend response `session_id` did not match requested thread scope',
      );
    }
  }
  if (!raw.session_id) return requestedScope;
  return { ...requestedScope, thread: raw.session_id };
}

function toAtomicMemorySearchResult(
  raw: RawMemoryResponse,
  scope: MemoryScope,
): AtomicMemorySearchResult {
  const similarity = raw.semantic_similarity ?? raw.similarity;
  const rankingScore = raw.ranking_score ?? raw.score;
  const relevance = raw.relevance;
  const result: AtomicMemorySearchResult = {
    memory: toAtomicMemoryMemory(raw, scope),
    score: rankingScore ?? similarity ?? 0,
  };
  if (similarity !== undefined) result.similarity = similarity;
  if (rankingScore !== undefined) result.rankingScore = rankingScore;
  if (relevance !== undefined) result.relevance = relevance;
  if (raw.importance !== undefined) result.importance = raw.importance;
  return result;
}

function mapSearchResponse(
  raw: RawSearchResponse,
  scope: MemoryScope,
): AtomicMemorySearchResultPage {
  const memories = raw.memories ?? [];
  return {
    count: raw.count ?? memories.length,
    retrievalMode: raw.retrieval_mode ?? 'flat',
    scope,
    results: memories.map((m) => toAtomicMemorySearchResult(m, scope)),
    ...(raw.injection_text !== undefined ? { injectionText: raw.injection_text } : {}),
    ...(raw.citations ? { citations: raw.citations } : {}),
    ...(raw.tier_assignments
      ? {
          tierAssignments: raw.tier_assignments.map((t) => ({
            memoryId: t.memory_id,
            tier: t.tier,
            estimatedTokens: t.estimated_tokens,
          })),
        }
      : {}),
    ...(raw.expand_ids ? { expandIds: raw.expand_ids } : {}),
    ...(raw.estimated_context_tokens !== undefined
      ? { estimatedContextTokens: raw.estimated_context_tokens }
      : {}),
    ...(raw.lesson_check
      ? {
          lessonCheck: {
            safe: raw.lesson_check.safe,
            warnings: raw.lesson_check.warnings,
            highestSeverity: raw.lesson_check.highest_severity,
            matchedCount: raw.lesson_check.matched_count,
          },
        }
      : {}),
    ...(raw.consensus
      ? {
          consensus: {
            originalCount: raw.consensus.original_count,
            filteredCount: raw.consensus.filtered_count,
            removedCount: raw.consensus.removed_count,
            removedMemoryIds: raw.consensus.removed_memory_ids,
          },
        }
      : {}),
    ...(raw.observability ? { observability: raw.observability } : {}),
  };
}

// ---------------------------------------------------------------------------
// Lifecycle category
// ---------------------------------------------------------------------------

/**
 * All lifecycle routes are user-scoped per core: no workspace_id /
 * agent_id are accepted. That's the intentional contract for admin
 * operations — cross-workspace admin belongs in a different surface.
 */
function createLifecycleHandle(
  http: HttpOptions,
  route: Route,
): AtomicMemoryLifecycle {
  return {
    async consolidate(userId, execute) {
      const body: Record<string, unknown> = { user_id: userId };
      if (execute) body.execute = true;
      const raw = await fetchJson<RawConsolidationResponse>(
        http,
        route('/memories/consolidate'),
        { method: 'POST', body: JSON.stringify(body) },
      );
      return toConsolidationResult(raw);
    },

    async decay(userId, dryRun) {
      const body: Record<string, unknown> = { user_id: userId };
      // Core treats dry_run as true unless explicitly false (memories.ts:323).
      // We forward the caller's intent verbatim.
      if (dryRun === false) body.dry_run = false;
      const raw = await fetchJson<RawDecayResponse>(http, route('/memories/decay'), {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return toDecayResult(raw);
    },

    async cap(userId) {
      const params = new URLSearchParams({ user_id: userId });
      const raw = await fetchJson<RawCapResponse>(
        http,
        route(`/memories/cap?${params.toString()}`),
      );
      return toCapCheckResult(raw);
    },

    async stats(userId) {
      const params = new URLSearchParams({ user_id: userId });
      const raw = await fetchJson<RawStatsResponse>(
        http,
        route(`/memories/stats?${params.toString()}`),
      );
      return toStatsResult(raw);
    },

    async resetSource(userId, sourceSite) {
      const raw = await fetchJson<RawResetSourceResponse>(
        http,
        route('/memories/reset-source'),
        {
          method: 'POST',
          body: JSON.stringify({
            user_id: userId,
            source_site: sourceSite,
          }),
        },
      );
      return toResetSourceResult(raw);
    },

    async reconcile(userId) {
      const raw = await fetchJson<RawReconciliationResponse>(
        http,
        route('/memories/reconcile'),
        { method: 'POST', body: JSON.stringify({ user_id: userId }) },
      );
      return toReconciliationResult(raw);
    },

    async reconcileAll() {
      // Omit user_id from the body — core routes the no-user_id case to
      // reconcileDeferredAll() (memories.ts:397-400), a privileged
      // batch-job pass across every user.
      const raw = await fetchJson<RawReconciliationResponse>(
        http,
        route('/memories/reconcile'),
        { method: 'POST', body: JSON.stringify({}) },
      );
      return toReconciliationResult(raw);
    },

    async reconcileStatus(userId) {
      const params = new URLSearchParams({ user_id: userId });
      return fetchJson<ReconcileStatus>(
        http,
        route(`/memories/reconcile/status?${params.toString()}`),
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Lifecycle wire shapes + mappers
// ---------------------------------------------------------------------------

interface RawConsolidationScanResponse {
  memories_scanned: number;
  clusters_found: number;
  memories_in_clusters: number;
  clusters: unknown[];
}

interface RawConsolidationExecutionResponse {
  clusters_consolidated: number;
  memories_archived: number;
  memories_created: number;
  consolidated_memory_ids: string[];
}

type RawConsolidationResponse =
  | RawConsolidationScanResponse
  | RawConsolidationExecutionResponse;

function toConsolidationResult(raw: RawConsolidationResponse): ConsolidationResult {
  if ('consolidated_memory_ids' in raw) {
    return {
      clustersConsolidated: raw.clusters_consolidated,
      memoriesArchived: raw.memories_archived,
      memoriesCreated: raw.memories_created,
      consolidatedMemoryIds: raw.consolidated_memory_ids,
    };
  }
  return {
    memoriesScanned: raw.memories_scanned,
    clustersFound: raw.clusters_found,
    memoriesInClusters: raw.memories_in_clusters,
    clusters: raw.clusters,
  };
}

interface RawDecayCandidate {
  id: string;
  content: string;
  retention_score: number;
  importance: number;
  days_since_access: number;
  access_count: number;
}

interface RawDecayResponse {
  memories_evaluated: number;
  candidates_for_archival: RawDecayCandidate[];
  retention_threshold: number;
  avg_retention_score: number;
  archived: number;
}

function toDecayResult(raw: RawDecayResponse): DecayResult {
  return {
    memoriesEvaluated: raw.memories_evaluated,
    candidatesForArchival: raw.candidates_for_archival.map((c) => ({
      id: c.id,
      content: c.content,
      retentionScore: c.retention_score,
      importance: c.importance,
      daysSinceAccess: c.days_since_access,
      accessCount: c.access_count,
    })),
    retentionThreshold: raw.retention_threshold,
    avgRetentionScore: raw.avg_retention_score,
    archived: raw.archived,
  };
}

interface RawCapResponse {
  active_memories: number;
  max_memories: number;
  status: CapCheckResult['status'];
  usage_ratio: number;
  recommendation: CapCheckResult['recommendation'];
}

function toCapCheckResult(raw: RawCapResponse): CapCheckResult {
  return {
    activeMemories: raw.active_memories,
    maxMemories: raw.max_memories,
    status: raw.status,
    usageRatio: raw.usage_ratio,
    recommendation: raw.recommendation,
  };
}

interface RawStatsResponse {
  count: number;
  avg_importance: number;
  source_distribution: Record<string, number>;
}

function toStatsResult(raw: RawStatsResponse): StatsResult {
  return {
    count: raw.count,
    avgImportance: raw.avg_importance,
    sourceDistribution: raw.source_distribution,
  };
}

interface RawResetSourceResponse {
  success: true;
  deleted_memories: number;
  deleted_episodes: number;
}

function toResetSourceResult(raw: RawResetSourceResponse): ResetSourceResult {
  return {
    success: true,
    deletedMemories: raw.deleted_memories,
    deletedEpisodes: raw.deleted_episodes,
  };
}

interface RawReconciliationResponse {
  processed: number;
  resolved: number;
  noops: number;
  updates: number;
  supersedes: number;
  deletes: number;
  adds: number;
  errors: number;
  duration_ms: number;
}

function toReconciliationResult(raw: RawReconciliationResponse): ReconciliationResult {
  return {
    processed: raw.processed,
    resolved: raw.resolved,
    noops: raw.noops,
    updates: raw.updates,
    supersedes: raw.supersedes,
    deletes: raw.deletes,
    adds: raw.adds,
    errors: raw.errors,
    durationMs: raw.duration_ms,
  };
}

// ---------------------------------------------------------------------------
// Audit category
// ---------------------------------------------------------------------------

/**
 * Core's audit routes are user-scoped per memories.ts:481/493/506 —
 * no workspace_id / agent_id are accepted. Same fail-closed contract
 * as the lifecycle category.
 */
function createAuditHandle(http: HttpOptions, route: Route): AtomicMemoryAudit {
  return {
    async summary(userId) {
      const params = new URLSearchParams({ user_id: userId });
      const raw = await fetchJson<RawMutationSummary>(
        http,
        route(`/memories/audit/summary?${params.toString()}`),
      );
      return toMutationSummary(raw);
    },

    async recent(userId, limit) {
      const params = new URLSearchParams({ user_id: userId });
      if (limit !== undefined) params.set('limit', String(limit));
      const raw = await fetchJson<{
        mutations: RawMutationRecord[];
        count: number;
      }>(http, route(`/memories/audit/recent?${params.toString()}`));
      return {
        mutations: raw.mutations.map(toMutationRecord),
        count: raw.count,
      };
    },

    async trail(memoryId, userId) {
      const params = new URLSearchParams({ user_id: userId });
      const raw = await fetchJson<{
        memory_id: string;
        trail: RawAuditTrailEntry[];
        version_count: number;
      }>(
        http,
        route(
          `/memories/${encodeURIComponent(memoryId)}/audit?${params.toString()}`,
        ),
      );
      return {
        memoryId: raw.memory_id,
        trail: raw.trail.map(toAuditTrailEntry),
        versionCount: raw.version_count,
      };
    },
  };
}

interface RawMutationSummary {
  total_versions: number;
  active_versions: number;
  superseded_versions: number;
  total_claims: number;
  by_mutation_type: Record<string, number>;
}

function toMutationSummary(raw: RawMutationSummary): MutationSummary {
  return {
    totalVersions: raw.total_versions,
    activeVersions: raw.active_versions,
    supersededVersions: raw.superseded_versions,
    totalClaims: raw.total_claims,
    byMutationType: raw.by_mutation_type,
  };
}

/**
 * Raw `ClaimVersionRow` shape emitted by `GET /memories/audit/recent`.
 * snake_case DB field names — mapped to camelCase on the SDK boundary.
 */
interface RawMutationRecord {
  id: string;
  claim_id: string;
  user_id: string;
  memory_id: string | null;
  content: string;
  mutation_type: MutationRecord['mutationType'];
  mutation_reason: string | null;
  actor_model: string | null;
  contradiction_confidence: number | null;
  previous_version_id: string | null;
  superseded_by_version_id: string | null;
  valid_from: string;
  valid_to: string | null;
  created_at: string;
}

/**
 * Fields shared between `MutationRecord` and `AuditTrailEntry`. Both wire
 * rows carry the same claim-version payload; the SDK public types differ
 * only in their identifying header fields (id + userId + createdAt vs
 * versionId).
 */
interface RawMutationCommon {
  content: string;
  mutation_type: MutationRecord['mutationType'];
  mutation_reason: string | null;
  actor_model: string | null;
  contradiction_confidence: number | null;
  previous_version_id: string | null;
  superseded_by_version_id: string | null;
  valid_from: string;
  valid_to: string | null;
}

type MutationCommon = Pick<
  MutationRecord,
  'content' | 'mutationType' | 'mutationReason' | 'actorModel'
  | 'contradictionConfidence' | 'previousVersionId' | 'supersededByVersionId'
  | 'validFrom' | 'validTo'
>;

function toMutationCommon(raw: RawMutationCommon): MutationCommon {
  return {
    content: raw.content,
    mutationType: raw.mutation_type,
    mutationReason: raw.mutation_reason,
    actorModel: raw.actor_model,
    contradictionConfidence: raw.contradiction_confidence,
    previousVersionId: raw.previous_version_id,
    supersededByVersionId: raw.superseded_by_version_id,
    validFrom: new Date(raw.valid_from),
    validTo: raw.valid_to ? new Date(raw.valid_to) : null,
  };
}

function toMutationRecord(raw: RawMutationRecord): MutationRecord {
  return {
    id: raw.id,
    claimId: raw.claim_id,
    userId: raw.user_id,
    memoryId: raw.memory_id,
    ...toMutationCommon(raw),
    createdAt: new Date(raw.created_at),
  };
}

/**
 * Raw `AuditTrailEntry` shape emitted by `GET /memories/:id/audit`.
 * snake_case wire contract; timestamps are ISO strings.
 */
interface RawAuditTrailEntry {
  version_id: string;
  claim_id: string;
  content: string;
  mutation_type: AuditTrailEntry['mutationType'];
  mutation_reason: string | null;
  actor_model: string | null;
  contradiction_confidence: number | null;
  previous_version_id: string | null;
  superseded_by_version_id: string | null;
  valid_from: string;
  valid_to: string | null;
  memory_id: string | null;
}

function toAuditTrailEntry(raw: RawAuditTrailEntry): AuditTrailEntry {
  return {
    versionId: raw.version_id,
    claimId: raw.claim_id,
    memoryId: raw.memory_id,
    ...toMutationCommon(raw),
  };
}

// ---------------------------------------------------------------------------
// Lessons category
// ---------------------------------------------------------------------------

/**
 * Core's lesson routes are user-scoped per memories.ts:352/362/372/385
 * — no workspace_id / agent_id are accepted. Same fail-closed contract
 * as audit/lifecycle.
 *
 * Tolerates both core's 200 `{ success: true }` body and a 204 empty
 * body on DELETE, matching the pattern in `handle.delete` for base
 * memories.
 */
function createLessonsHandle(
  http: HttpOptions,
  route: Route,
): AtomicMemoryLessons {
  return {
    async list(userId) {
      const params = new URLSearchParams({ user_id: userId });
      const raw = await fetchJson<{
        lessons: RawLessonRow[];
        count: number;
      }>(http, route(`/memories/lessons?${params.toString()}`));
      return {
        lessons: raw.lessons.map(toLesson),
        count: raw.count,
      };
    },

    async stats(userId) {
      const params = new URLSearchParams({ user_id: userId });
      const raw = await fetchJson<RawLessonStats>(
        http,
        route(`/memories/lessons/stats?${params.toString()}`),
      );
      return { totalActive: raw.total_active, byType: raw.by_type };
    },

    async report(userId, pattern, sources, severity) {
      const body: Record<string, unknown> = {
        user_id: userId,
        pattern,
      };
      // Core reads `source_memory_ids` as an array; omit when empty/
      // undefined so the request body stays minimal.
      if (sources && sources.length > 0) {
        body.source_memory_ids = sources;
      }
      if (severity !== undefined) {
        body.severity = severity;
      }
      const raw = await fetchJson<{ lesson_id: string }>(
        http,
        route('/memories/lessons/report'),
        { method: 'POST', body: JSON.stringify(body) },
      );
      return { lessonId: raw.lesson_id };
    },

    async delete(lessonId, userId) {
      const params = new URLSearchParams({ user_id: userId });
      await fetchVoid(
        http,
        route(
          `/memories/lessons/${encodeURIComponent(lessonId)}?${params.toString()}`,
        ),
        { method: 'DELETE' },
      );
    },
  };
}

/**
 * Raw `LessonRow` shape emitted by `GET /memories/lessons`.
 * Snake_case DB fields, mapped to camelCase + Date on the SDK boundary.
 */
interface RawLessonRow {
  id: string;
  user_id: string;
  lesson_type: Lesson['lessonType'];
  pattern: string;
  embedding: number[];
  source_memory_ids: string[];
  source_query: string | null;
  severity: LessonSeverity;
  active: boolean;
  metadata: Record<string, unknown>;
  created_at: string;
}

interface RawLessonStats {
  total_active: number;
  by_type: Record<string, number>;
}

function toLesson(raw: RawLessonRow): Lesson {
  return {
    id: raw.id,
    userId: raw.user_id,
    lessonType: raw.lesson_type,
    pattern: raw.pattern,
    embedding: raw.embedding,
    sourceMemoryIds: raw.source_memory_ids,
    sourceQuery: raw.source_query,
    severity: raw.severity,
    active: raw.active,
    metadata: raw.metadata,
    createdAt: new Date(raw.created_at),
  };
}

// ---------------------------------------------------------------------------
// Configuration category
// ---------------------------------------------------------------------------

/**
 * Core exposes `GET /memories/health` (no auth / scope) and
 * `PUT /memories/config` (runtime mutation, gated on
 * `CORE_RUNTIME_CONFIG_MUTATION_ENABLED`). Both emit snake_case config
 * shapes; the SDK normalizes to camelCase at the boundary.
 *
 * Provider/model selection is intentionally NOT exposed here — core
 * 400s on startup-only fields (memories.ts:275-283). The
 * ConfigUpdates type only carries the 4 runtime-mutable thresholds.
 */
function createConfigHandle(
  http: HttpOptions,
  route: Route,
): AtomicMemoryConfig {
  return {
    async health() {
      const raw = await fetchJson<{
        status: 'ok';
        config: RawHealthConfig;
      }>(http, route('/memories/health'));
      return {
        status: raw.status,
        config: toHealthConfig(raw.config),
      };
    },

    async updateConfig(updates) {
      const body: Record<string, unknown> = {};
      if (updates.similarityThreshold !== undefined) {
        body.similarity_threshold = updates.similarityThreshold;
      }
      if (updates.audnCandidateThreshold !== undefined) {
        body.audn_candidate_threshold = updates.audnCandidateThreshold;
      }
      if (updates.clarificationConflictThreshold !== undefined) {
        body.clarification_conflict_threshold =
          updates.clarificationConflictThreshold;
      }
      if (updates.maxSearchResults !== undefined) {
        body.max_search_results = updates.maxSearchResults;
      }

      const raw = await fetchJson<{
        applied: string[];
        config: RawHealthConfig;
        note: string;
      }>(http, route('/memories/config'), {
        method: 'PUT',
        body: JSON.stringify(body),
      });
      return {
        applied: raw.applied.map(snakeToCamel),
        config: toHealthConfig(raw.config),
        note: raw.note,
      };
    },
  };
}

function snakeToCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * Raw `formatHealthConfig` output emitted by core
 * (memories.ts:704-720). snake_case; mapped to camelCase on the SDK
 * boundary.
 */
interface RawHealthConfig {
  retrieval_profile: string;
  embedding_provider: HealthConfig['embeddingProvider'];
  embedding_model: string;
  llm_provider: HealthConfig['llmProvider'];
  llm_model: string;
  clarification_conflict_threshold: number;
  max_search_results: number;
  hybrid_search_enabled: boolean;
  iterative_retrieval_enabled: boolean;
  entity_graph_enabled: boolean;
  cross_encoder_enabled: boolean;
  agentic_retrieval_enabled: boolean;
  repair_loop_enabled: boolean;
}

function toHealthConfig(raw: RawHealthConfig): HealthConfig {
  return {
    retrievalProfile: raw.retrieval_profile,
    embeddingProvider: raw.embedding_provider,
    embeddingModel: raw.embedding_model,
    llmProvider: raw.llm_provider,
    llmModel: raw.llm_model,
    clarificationConflictThreshold: raw.clarification_conflict_threshold,
    maxSearchResults: raw.max_search_results,
    hybridSearchEnabled: raw.hybrid_search_enabled,
    iterativeRetrievalEnabled: raw.iterative_retrieval_enabled,
    entityGraphEnabled: raw.entity_graph_enabled,
    crossEncoderEnabled: raw.cross_encoder_enabled,
    agenticRetrievalEnabled: raw.agentic_retrieval_enabled,
    repairLoopEnabled: raw.repair_loop_enabled,
  };
}

// ---------------------------------------------------------------------------
// Agents category
// ---------------------------------------------------------------------------

/**
 * Core's agent routes live under `/agents/*` (NOT `/memories/*`).
 * setTrust + getTrust + conflicts + autoResolveConflicts are all keyed
 * by userId; resolveConflict is keyed by conflictId (core resolves
 * directly by id without needing a user context — agents.ts:61-72).
 */
function createAgentsHandle(http: HttpOptions, route: Route): AtomicMemoryAgents {
  return {
    async setTrust(userId, agentId, trustLevel, displayName) {
      const body: Record<string, unknown> = {
        user_id: userId,
        agent_id: agentId,
        trust_level: trustLevel,
      };
      if (displayName !== undefined) {
        body.display_name = displayName;
      }
      const raw = await fetchJson<{ agent_id: string; trust_level: number }>(
        http,
        route('/agents/trust'),
        { method: 'PUT', body: JSON.stringify(body) },
      );
      return {
        agentId: raw.agent_id,
        trustLevel: raw.trust_level,
      };
    },

    async getTrust(userId, agentId) {
      const params = new URLSearchParams({
        user_id: userId,
        agent_id: agentId,
      });
      const raw = await fetchJson<{
        agent_id: string;
        trust_level: number;
      }>(http, route(`/agents/trust?${params.toString()}`));
      return {
        agentId: raw.agent_id,
        trustLevel: raw.trust_level,
      };
    },

    async conflicts(userId) {
      const params = new URLSearchParams({ user_id: userId });
      const raw = await fetchJson<{
        conflicts: RawMemoryConflict[];
        count: number;
      }>(http, route(`/agents/conflicts?${params.toString()}`));
      return {
        conflicts: raw.conflicts.map(toAgentConflict),
        count: raw.count,
      };
    },

    async resolveConflict(conflictId, resolution) {
      return fetchJson<ResolveConflictResult>(
        http,
        route(
          `/agents/conflicts/${encodeURIComponent(conflictId)}/resolve`,
        ),
        {
          method: 'PUT',
          body: JSON.stringify({ resolution }),
        },
      );
    },

    async autoResolveConflicts(userId) {
      return fetchJson<AutoResolveConflictsResult>(
        http,
        route('/agents/conflicts/auto-resolve'),
        {
          method: 'POST',
          body: JSON.stringify({ user_id: userId }),
        },
      );
    },
  };
}

/**
 * Raw `MemoryConflict` row emitted by `GET /agents/conflicts`.
 * snake_case DB fields; normalized to camelCase + Date at the SDK
 * boundary.
 */
interface RawMemoryConflict {
  id: string;
  user_id: string;
  new_memory_id: string | null;
  existing_memory_id: string | null;
  new_agent_id: string | null;
  existing_agent_id: string | null;
  new_trust_level: number | null;
  existing_trust_level: number | null;
  contradiction_confidence: number;
  clarification_note: string | null;
  status: AgentConflict['status'];
  resolution_policy: string | null;
  resolved_at: string | null;
  created_at: string;
  auto_resolve_after: string | null;
}

function toAgentConflict(raw: RawMemoryConflict): AgentConflict {
  return {
    id: raw.id,
    userId: raw.user_id,
    newMemoryId: raw.new_memory_id,
    existingMemoryId: raw.existing_memory_id,
    newAgentId: raw.new_agent_id,
    existingAgentId: raw.existing_agent_id,
    newTrustLevel: raw.new_trust_level,
    existingTrustLevel: raw.existing_trust_level,
    contradictionConfidence: raw.contradiction_confidence,
    clarificationNote: raw.clarification_note,
    status: raw.status,
    resolutionPolicy: raw.resolution_policy,
    resolvedAt: raw.resolved_at ? new Date(raw.resolved_at) : null,
    createdAt: new Date(raw.created_at),
    autoResolveAfter: raw.auto_resolve_after
      ? new Date(raw.auto_resolve_after)
      : null,
  };
}
