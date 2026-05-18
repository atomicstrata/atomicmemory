/**
 * Packaging and assembly observability helpers.
 *
 * Builds explicit summaries for the packaged context emitted by search()
 * without changing candidate membership, ranking, or canonical storage.
 */

import type { SearchResult } from '../db/memory-repository.js';
import type { RetrievalMode } from './memory-service-types.js';
import type {
  AssemblyTraceSummary,
  PackagingEvidenceRole,
  PackagingTraceSummary,
  PackagingType,
} from './retrieval-trace.js';
import type { TraceCollector } from './retrieval-trace.js';
import type { TierAssignment } from './tiered-loading.js';
import { isAnswerBearing, sortBySessionPriority } from './session-packaging.js';
import { estimateTokens } from './tiered-loading.js';
import { buildTimelinePack, spansMultipleDates } from './timeline-pack.js';
import { deduplicateCompositeMembersHard } from './composite-dedup.js';

interface NamespaceGroup {
  namespace: string;
  memories: SearchResult[];
}

function buildPackagingTraceSummary(
  candidateMemories: SearchResult[],
  includedMemories: SearchResult[],
  mode: RetrievalMode,
  injectionText: string,
  estimatedTokenCost?: number,
): PackagingTraceSummary {
  const groups = groupByNamespace(includedMemories);
  const packageType = resolvePackageType(groups, mode);
  const ordered = orderIncludedMemories(groups, mode);
  const includedIds = ordered.map((memory) => memory.id);
  const includedSet = new Set(includedIds);

  return {
    packageType,
    includedIds,
    droppedIds: candidateMemories.map((memory) => memory.id).filter((id) => !includedSet.has(id)),
    evidenceRoles: buildEvidenceRoles(groups, ordered, mode),
    episodeCount: countDistinctEpisodes(includedMemories),
    dateCount: countDistinctDates(includedMemories),
    hasCurrentMarker: packageType === 'timeline-pack',
    hasConflictBlock: false,
    tokenCost: estimatedTokenCost ?? estimateTokens(injectionText),
  };
}

function buildAssemblyTraceSummary(
  packaging: PackagingTraceSummary,
  tokenBudget?: number,
): AssemblyTraceSummary {
  return {
    finalIds: packaging.includedIds,
    finalTokenCost: packaging.tokenCost,
    tokenBudget: tokenBudget ?? null,
    primaryEvidencePosition: resolvePrimaryEvidencePosition(packaging),
    blocks: resolveAssemblyBlocks(packaging.packageType),
  };
}

function groupByNamespace(memories: SearchResult[]): NamespaceGroup[] {
  const groups = new Map<string, SearchResult[]>();
  for (const memory of memories) {
    const namespace = memory.namespace || 'general';
    const existing = groups.get(namespace);
    if (existing) {
      existing.push(memory);
      continue;
    }
    groups.set(namespace, [memory]);
  }
  return [...groups.entries()].map(([namespace, grouped]) => ({ namespace, memories: grouped }));
}

function resolvePackageType(groups: NamespaceGroup[], mode: RetrievalMode): PackagingType {
  if (mode !== 'flat') return 'tiered';
  return groups.some((group) => spansMultipleDates(group.memories)) ? 'timeline-pack' : 'subject-pack';
}

function orderIncludedMemories(groups: NamespaceGroup[], mode: RetrievalMode): SearchResult[] {
  if (mode !== 'flat') {
    return [...groups.flatMap((group) => group.memories)]
      .sort((left, right) => left.created_at.getTime() - right.created_at.getTime());
  }
  return groups.flatMap((group) => orderGroup(group));
}

function orderGroup(group: NamespaceGroup): SearchResult[] {
  if (spansMultipleDates(group.memories)) {
    return buildTimelinePack(group.namespace, group.memories)
      .entries
      .map((entry) => group.memories.find((memory) => memory.id === entry.memoryId))
      .filter((memory): memory is SearchResult => memory !== undefined);
  }
  return sortBySessionPriority(group.memories);
}

function buildEvidenceRoles(
  groups: NamespaceGroup[],
  ordered: SearchResult[],
  mode: RetrievalMode,
): Record<string, PackagingEvidenceRole> {
  const timelineNamespaces = new Set(getTimelineNamespaces(groups, mode));
  const timelineLatestIds = new Set(getTimelineLatestIds(groups, mode));
  return Object.fromEntries(ordered.map((memory) => [
    memory.id,
    resolveEvidenceRole(memory, mode, timelineNamespaces, timelineLatestIds),
  ]));
}

function getTimelineNamespaces(groups: NamespaceGroup[], mode: RetrievalMode): string[] {
  if (mode !== 'flat') return [];
  return groups.filter((group) => spansMultipleDates(group.memories)).map((group) => group.namespace);
}

function getTimelineLatestIds(groups: NamespaceGroup[], mode: RetrievalMode): string[] {
  if (mode !== 'flat') return [];
  return groups
    .filter((group) => spansMultipleDates(group.memories))
    .map((group) => buildTimelinePack(group.namespace, group.memories).latestEntryId);
}

function resolveEvidenceRole(
  memory: SearchResult,
  mode: RetrievalMode,
  timelineNamespaces: Set<string>,
  timelineLatestIds: Set<string>,
): PackagingEvidenceRole {
  if (timelineLatestIds.has(memory.id)) return 'primary';
  if (mode !== 'flat') return isAnswerBearing(memory.content) ? 'primary' : 'contextual';
  const isTimelineMemory = timelineNamespaces.has(memory.namespace || 'general');
  if (isAnswerBearing(memory.content)) return isTimelineMemory ? 'historical' : 'primary';
  if (isTimelineMemory) return 'contextual';
  return 'supporting';
}

function countDistinctEpisodes(memories: SearchResult[]): number {
  return new Set(memories.map((memory) => memory.episode_id).filter(Boolean)).size;
}

function countDistinctDates(memories: SearchResult[]): number {
  return new Set(memories.map((memory) => memory.created_at.toISOString().slice(0, 10))).size;
}

function resolvePrimaryEvidencePosition(packaging: PackagingTraceSummary): number | null {
  const position = packaging.includedIds.findIndex((id) => packaging.evidenceRoles[id] === 'primary');
  return position === -1 ? null : position + 1;
}

function resolveAssemblyBlocks(packageType: PackagingType): string[] {
  if (packageType === 'tiered') return ['tiered'];
  if (packageType === 'timeline-pack') return ['timeline'];
  return ['subject'];
}

export interface FinalizePackagingInput {
  outputMemories: SearchResult[];
  mode: RetrievalMode;
  injectionText: string;
  estimatedContextTokens?: number;
  tierAssignments?: TierAssignment[];
  tokenBudget?: number;
}

/**
 * Build packaging + assembly summaries, emit the tiered-packaging trace
 * event when in tiered mode, and attach both summaries to the active
 * trace. Returns the summaries so the caller can include them in the
 * retrieval result. Does NOT finalize the trace — caller owns that.
 */
export function finalizePackagingTrace(
  activeTrace: TraceCollector,
  input: FinalizePackagingInput,
): { packagingSummary: PackagingTraceSummary; assemblySummary: AssemblyTraceSummary } {
  const packagedForSummary = input.mode === 'flat'
    ? input.outputMemories
    : deduplicateCompositeMembersHard(input.outputMemories);
  const packagingSummary = buildPackagingTraceSummary(
    input.outputMemories, packagedForSummary, input.mode, input.injectionText, input.estimatedContextTokens,
  );
  const assemblySummary = buildAssemblyTraceSummary(
    packagingSummary, input.mode === 'flat' ? undefined : input.tokenBudget,
  );

  if (input.mode === 'tiered') {
    activeTrace.event('tiered-packaging', {
      budget: input.tokenBudget ?? null,
      estimatedTokens: input.estimatedContextTokens,
      tierDistribution: input.tierAssignments?.reduce<Record<string, number>>((acc, a) => {
        acc[a.tier] = (acc[a.tier] || 0) + 1;
        return acc;
      }, {}),
    });
  }

  activeTrace.setPackagingSummary(packagingSummary);
  activeTrace.setAssemblySummary(assemblySummary);
  return { packagingSummary, assemblySummary };
}
