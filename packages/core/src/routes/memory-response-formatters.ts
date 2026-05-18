/**
 * Wire-format response shapers for the memory API.
 *
 * Internal service types use camelCase; HTTP wire convention is snake_case.
 * These formatters translate at the route boundary so internal types and
 * the public contract can evolve independently.
 *
 * Database rows (MemoryRow, LessonRow, ClaimVersionRow) already use
 * snake_case column names and pass through unchanged.
 */

import type { IngestResult, MemoryScope, RetrievalObservability } from '../services/memory-service-types.js';
import type {
  ConsolidationResult,
  ConsolidationExecutionResult,
  ClusterCandidate,
} from '../services/consolidation-service.js';
import type {
  DecayResult,
  DecayCandidate,
  CapCheckResult,
} from '../services/memory-lifecycle.js';
import type { ReconciliationResult } from '../services/deferred-audn.js';
import type { MutationSummary, AuditTrailEntry } from '../db/repository-types.js';
import type {
  RetrievalTraceSummary,
  PackagingTraceSummary,
  AssemblyTraceSummary,
} from '../services/retrieval-trace.js';

export function formatIngestResponse(result: IngestResult) {
  return {
    episode_id: result.episodeId,
    facts_extracted: result.factsExtracted,
    memories_stored: result.memoriesStored,
    memories_updated: result.memoriesUpdated,
    memories_deleted: result.memoriesDeleted,
    memories_skipped: result.memoriesSkipped,
    stored_memory_ids: result.storedMemoryIds,
    updated_memory_ids: result.updatedMemoryIds,
    links_created: result.linksCreated,
    composites_created: result.compositesCreated,
    ...(result.ingestTraceId ? { ingest_trace_id: result.ingestTraceId } : {}),
  };
}

export function formatScope(scope: MemoryScope) {
  if (scope.kind === 'user') {
    return { kind: 'user' as const, user_id: scope.userId };
  }
  return {
    kind: 'workspace' as const,
    user_id: scope.userId,
    workspace_id: scope.workspaceId,
    agent_id: scope.agentId,
    ...(scope.agentScope !== undefined ? { agent_scope: scope.agentScope } : {}),
  };
}

export function formatStatsResponse(stats: {
  count: number;
  avgImportance: number;
  sourceDistribution: Record<string, number>;
}) {
  return {
    count: stats.count,
    avg_importance: stats.avgImportance,
    source_distribution: stats.sourceDistribution,
  };
}

function formatClusterCandidate(cluster: ClusterCandidate) {
  return {
    member_ids: cluster.memberIds,
    member_contents: cluster.memberContents,
    avg_affinity: cluster.avgAffinity,
    member_count: cluster.memberCount,
  };
}

export function formatConsolidateResponse(result: ConsolidationResult) {
  return {
    memories_scanned: result.memoriesScanned,
    clusters_found: result.clustersFound,
    memories_in_clusters: result.memoriesInClusters,
    clusters: result.clusters.map(formatClusterCandidate),
  };
}

export function formatConsolidateExecuteResponse(result: ConsolidationExecutionResult) {
  return {
    clusters_consolidated: result.clustersConsolidated,
    memories_archived: result.memoriesArchived,
    memories_created: result.memoriesCreated,
    consolidated_memory_ids: result.consolidatedMemoryIds,
  };
}

function formatDecayCandidate(candidate: DecayCandidate) {
  return {
    id: candidate.id,
    content: candidate.content,
    retention_score: candidate.retentionScore,
    importance: candidate.importance,
    days_since_access: candidate.daysSinceAccess,
    access_count: candidate.accessCount,
  };
}

export function formatDecayResponse(result: DecayResult, archived: number) {
  return {
    memories_evaluated: result.memoriesEvaluated,
    candidates_for_archival: result.candidatesForArchival.map(formatDecayCandidate),
    retention_threshold: result.retentionThreshold,
    avg_retention_score: result.avgRetentionScore,
    archived,
  };
}

export function formatCapResponse(result: CapCheckResult) {
  return {
    active_memories: result.activeMemories,
    max_memories: result.maxMemories,
    status: result.status,
    usage_ratio: result.usageRatio,
    recommendation: result.recommendation,
  };
}

export function formatLessonStatsResponse(stats: {
  totalActive: number;
  byType: Record<string, number>;
}) {
  return {
    total_active: stats.totalActive,
    by_type: stats.byType,
  };
}

export function formatReconciliationResponse(result: ReconciliationResult) {
  return {
    processed: result.processed,
    resolved: result.resolved,
    noops: result.noops,
    updates: result.updates,
    supersedes: result.supersedes,
    deletes: result.deletes,
    adds: result.adds,
    errors: result.errors,
    duration_ms: result.durationMs,
  };
}

export function formatResetSourceResponse(result: {
  deletedMemories: number;
  deletedEpisodes: number;
  deletedDocuments: number;
}) {
  return {
    success: true,
    deleted_memories: result.deletedMemories,
    deleted_episodes: result.deletedEpisodes,
    deleted_documents: result.deletedDocuments,
  };
}

export function formatMutationSummaryResponse(summary: MutationSummary) {
  return {
    total_versions: summary.totalVersions,
    active_versions: summary.activeVersions,
    superseded_versions: summary.supersededVersions,
    total_claims: summary.totalClaims,
    by_mutation_type: summary.byMutationType,
  };
}

function formatRetrievalTrace(summary: RetrievalTraceSummary) {
  return {
    candidate_ids: summary.candidateIds,
    candidate_count: summary.candidateCount,
    query_text: summary.queryText,
    skip_repair: summary.skipRepair,
    ...(summary.relevanceThreshold !== undefined ? { relevance_threshold: summary.relevanceThreshold } : {}),
    ...(summary.relevanceFilterSource ? { relevance_filter_source: summary.relevanceFilterSource } : {}),
    ...(summary.relevanceFilterReason ? { relevance_filter_reason: summary.relevanceFilterReason } : {}),
    ...(summary.filteredCandidateIds ? { filtered_candidate_ids: summary.filteredCandidateIds } : {}),
    ...(summary.filterDecisions ? {
      filter_decisions: summary.filterDecisions.map(formatFilterDecision),
    } : {}),
    ...(summary.traceId ? { trace_id: summary.traceId } : {}),
    ...(summary.stageCount !== undefined ? { stage_count: summary.stageCount } : {}),
    ...(summary.stageNames ? { stage_names: summary.stageNames } : {}),
  };
}

function formatFilterDecision(decision: NonNullable<RetrievalTraceSummary['filterDecisions']>[number]) {
  return {
    id: decision.id,
    source_site: decision.sourceSite,
    source_kind: decision.sourceKind,
    namespace: decision.namespace,
    semantic_similarity: decision.semanticSimilarity,
    ranking_score: decision.rankingScore,
    relevance: decision.relevance,
    threshold: decision.threshold,
    decision: decision.decision,
    reason: decision.reason,
  };
}

function formatPackagingTrace(summary: PackagingTraceSummary) {
  return {
    package_type: summary.packageType,
    included_ids: summary.includedIds,
    dropped_ids: summary.droppedIds,
    // evidenceRoles keys are memory IDs (opaque); values are role enum strings.
    evidence_roles: summary.evidenceRoles,
    episode_count: summary.episodeCount,
    date_count: summary.dateCount,
    has_current_marker: summary.hasCurrentMarker,
    has_conflict_block: summary.hasConflictBlock,
    token_cost: summary.tokenCost,
  };
}

function formatAssemblyTrace(summary: AssemblyTraceSummary) {
  return {
    final_ids: summary.finalIds,
    final_token_cost: summary.finalTokenCost,
    token_budget: summary.tokenBudget,
    primary_evidence_position: summary.primaryEvidencePosition,
    blocks: summary.blocks,
  };
}

export function formatObservability(observability: RetrievalObservability) {
  return {
    ...(observability.retrieval ? { retrieval: formatRetrievalTrace(observability.retrieval) } : {}),
    ...(observability.packaging ? { packaging: formatPackagingTrace(observability.packaging) } : {}),
    ...(observability.assembly ? { assembly: formatAssemblyTrace(observability.assembly) } : {}),
  };
}

export function formatAuditTrailEntry(entry: AuditTrailEntry) {
  return {
    version_id: entry.versionId,
    claim_id: entry.claimId,
    content: entry.content,
    mutation_type: entry.mutationType,
    mutation_reason: entry.mutationReason,
    actor_model: entry.actorModel,
    contradiction_confidence: entry.contradictionConfidence,
    previous_version_id: entry.previousVersionId,
    superseded_by_version_id: entry.supersededByVersionId,
    valid_from: entry.validFrom,
    valid_to: entry.validTo,
    memory_id: entry.memoryId,
  };
}
