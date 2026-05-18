/**
 * Composite/member deduplication for injection packaging.
 *
 * Two policies in two files:
 *
 *   - Tiered (hard) — this file. If a composite and its member atomics both
 *     appear, keep the composite and drop covered atomics.
 *   - Flat (soft + intent-aware) — `./composite-dedup-flat.ts`. Coverage
 *     threshold suppresses composites when atomics already cover most members;
 *     short factual / current-state queries drop any overlapping composite
 *     entirely. That module also owns `applyFlatPackagingPolicy`, the
 *     trace-emitting wrapper used by the retrieval pipeline.
 *
 * The flat-mode exports are re-exported here so existing imports of
 * `./composite-dedup.js` keep working without touching call sites.
 *
 * See: design/composite-vs-atomic-retrieval-contract-2026-03-27.md §Dedup rule
 */

import type { SearchResult } from '../db/repository-types.js';

export {
  applyFlatPackagingPolicy,
  deduplicateCompositeMembersForFlatQuery,
  deduplicateCompositeMembersSoft,
  prefersAtomicFlatPackaging,
} from './composite-dedup-flat.js';

/**
 * Hard dedup for tiered mode: composites win, covered atomics are dropped.
 * Used by `packaging-observability.ts` and `retrieval-format.ts`.
 */
export function deduplicateCompositeMembersHard(memories: SearchResult[]): SearchResult[] {
  const composites = memories.filter((m) => m.memory_type === 'composite');
  if (composites.length === 0) return memories;

  const coveredIds = new Set<string>();
  for (const composite of composites) {
    const memberIds = composite.metadata?.memberMemoryIds;
    if (Array.isArray(memberIds)) {
      for (const id of memberIds) {
        if (typeof id === 'string') coveredIds.add(id);
      }
    }
  }

  if (coveredIds.size === 0) return memories;
  return memories.filter((m) => m.memory_type === 'composite' || !coveredIds.has(m.id));
}
