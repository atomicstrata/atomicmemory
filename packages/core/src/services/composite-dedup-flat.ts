/**
 * Flat-mode composite/member packaging policy. The default retrieval path
 * runs in flat mode, where composites and atomics can both appear — this
 * module decides which composites to suppress based on:
 *
 *   - Soft coverage threshold: drop a composite when selected atomics
 *     already cover ≥ N% of its members.
 *   - Query intent: for current-state and short factual questions, drop
 *     any composite that overlaps with a retrieved atomic (atomics are the
 *     precision layer for those queries).
 *   - Trace recording: emit a packaging-dedup stage when the result set
 *     changes so retrieval traces show the actual packaging decision.
 *
 * The tiered-mode hard-dedup path lives in `./composite-dedup.ts`. Keeping
 * the two policies in separate files keeps each one small and confines
 * production churn to the policy actually being changed.
 *
 * See: design/composite-vs-atomic-retrieval-contract-2026-03-27.md §Dedup rule
 */

import type { SearchResult } from '../db/repository-types.js';
import { isCurrentStateQuery } from './current-state-ranking.js';
import type { RetrievalMode } from './memory-service-types.js';
import type { TraceCollector } from './retrieval-trace.js';

const DEFAULT_COVERAGE_THRESHOLD = 0.6;
const BROAD_QUERY_MARKERS = [
  'summarize',
  'summary',
  'overview',
  'what should the assistant know',
  'tell me about',
  'recap',
  'background',
  'context',
];
const DIRECT_QUERY_STARTERS = ['who ', 'what ', 'which ', 'where '];
const MAX_DIRECT_QUERY_WORDS = 10;

/**
 * Soft dedup for flat/default mode: suppress composites when selected atomics
 * already cover a high fraction of the composite's members.
 *
 * Logic:
 *   coverage = |composite.memberIds ∩ selectedAtomicIds| / |composite.memberIds|
 *   if coverage ≥ threshold → suppress the composite (atomics are enough)
 *   if coverage < threshold → keep the composite (it adds uncovered content)
 *
 * Atomics are never suppressed — they are the precision layer.
 */
export function deduplicateCompositeMembersSoft(
  memories: SearchResult[],
  coverageThreshold = DEFAULT_COVERAGE_THRESHOLD,
): SearchResult[] {
  const composites = memories.filter((m) => m.memory_type === 'composite');
  if (composites.length === 0) return memories;

  const atomicIds = new Set(
    memories
      .filter((m) => m.memory_type !== 'composite')
      .map((m) => m.id),
  );

  if (atomicIds.size === 0) return memories;

  const suppressedCompositeIds = new Set<string>();
  for (const composite of composites) {
    const memberIds = composite.metadata?.memberMemoryIds;
    if (!Array.isArray(memberIds) || memberIds.length === 0) continue;

    const validMemberIds = memberIds.filter((id): id is string => typeof id === 'string');
    if (validMemberIds.length === 0) continue;

    const coveredCount = validMemberIds.filter((id) => atomicIds.has(id)).length;
    const coverageRatio = coveredCount / validMemberIds.length;

    if (coverageRatio >= coverageThreshold) {
      suppressedCompositeIds.add(composite.id);
    }
  }

  if (suppressedCompositeIds.size === 0) return memories;
  return memories.filter((m) => !suppressedCompositeIds.has(m.id));
}

/**
 * Flat-mode packaging policy for precision queries. If the query asks for a
 * specific current or direct factual answer, any composite that overlaps with
 * already-retrieved atomics is treated as redundant and removed.
 *
 * Broad queries still use the softer coverage-ratio threshold because
 * compression is usually beneficial there.
 */
export function deduplicateCompositeMembersForFlatQuery(
  memories: SearchResult[],
  query: string,
  coverageThreshold = DEFAULT_COVERAGE_THRESHOLD,
): SearchResult[] {
  if (!prefersAtomicFlatPackaging(query)) {
    return deduplicateCompositeMembersSoft(memories, coverageThreshold);
  }
  return suppressOverlappingComposites(memories);
}

export function prefersAtomicFlatPackaging(query: string): boolean {
  const normalized = normalizeQuery(query);
  if (BROAD_QUERY_MARKERS.some((marker) => normalized.includes(marker))) return false;
  if (isCurrentStateQuery(query)) return true;
  return DIRECT_QUERY_STARTERS.some((starter) => normalized.startsWith(starter))
    && normalized.split(/\s+/).length <= MAX_DIRECT_QUERY_WORDS;
}

function suppressOverlappingComposites(memories: SearchResult[]): SearchResult[] {
  const atomicIds = new Set(
    memories
      .filter((memory) => memory.memory_type !== 'composite')
      .map((memory) => memory.id),
  );
  if (atomicIds.size === 0) return memories;

  const overlappingCompositeIds = new Set(
    memories
      .filter((memory) => memory.memory_type === 'composite')
      .filter((memory) => parseMemberIds(memory).some((id) => atomicIds.has(id)))
      .map((memory) => memory.id),
  );
  if (overlappingCompositeIds.size === 0) return memories;
  return memories.filter((memory) => !overlappingCompositeIds.has(memory.id));
}

function normalizeQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, ' ');
}

function parseMemberIds(memory: SearchResult): string[] {
  const candidate = memory.metadata?.memberMemoryIds;
  if (!Array.isArray(candidate)) return [];
  return candidate.filter((id): id is string => typeof id === 'string');
}

/**
 * Apply flat-mode composite dedup and record the dedup as a trace stage
 * if the result set changed. No-op for non-flat modes or empty sets.
 */
export function applyFlatPackagingPolicy(
  memories: SearchResult[],
  query: string,
  mode: RetrievalMode,
  trace: TraceCollector,
): SearchResult[] {
  if (mode !== 'flat' || memories.length === 0) return memories;
  const packaged = deduplicateCompositeMembersForFlatQuery(memories, query);
  if (packaged.length === memories.length && packaged[0]?.id === memories[0]?.id) {
    return memories;
  }
  trace.stage('flat-packaging-dedup', packaged, {
    removedIds: memories
      .map((memory) => memory.id)
      .filter((id) => !packaged.some((memory) => memory.id === id)),
  });
  return packaged;
}
