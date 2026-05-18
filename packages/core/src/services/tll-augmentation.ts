/**
 * TLL chain-membership augmentation for `performSearch`.
 *
 * Extracted from `memory-search.ts` to keep that orchestrator focused on
 * pipeline coordination and to bring the file back under the 400 LOC
 * project cap. The augmentation runs AFTER `applySearchRelevanceFilter`
 * (see `appendTllAugmentation`); chain membership is a different
 * retrieval signal than semantic similarity, so the augmented rows
 * don't pass through the similarity gate.
 */

import { type SearchResult } from '../db/memory-repository.js';
import { normalizeMemoryRow } from '../db/repository-types.js';
import { shouldUseTLL, expandViaTLL, TLL_ENTITY_LOOKUP_SEED_LIMIT } from './tll-retrieval.js';
import type { TraceCollector } from './retrieval-trace.js';
import type { MemoryServiceDeps } from './memory-service-types.js';
import type { PostProcessedSearch } from './memory-search-types.js';

/**
 * Outcome of a TLL expansion attempt. `failed` flips to true only when
 * an error is caught — empty `memories` with `failed: false` means the
 * gate ran cleanly but produced no augmentation (no entities, all chain
 * memories already in the candidate set, etc).
 *
 * Threaded back through `appendTllAugmentation` so the retrieval trace
 * can record `tll_expansion_failed` instead of silently swallowing the
 * exception.
 */
interface TllExpansionResult {
  memories: SearchResult[];
  failed: boolean;
  errorMessage?: string;
}

/**
 * Append TLL chain-membership augmentations after the relevance gate.
 * The augmented rows ride around the similarity threshold because chain
 * membership is a structurally different signal — they have no
 * meaningful similarity score against the query.
 */
export async function appendTllAugmentation(
  deps: MemoryServiceDeps,
  userId: string,
  query: string,
  postProcessed: PostProcessedSearch,
  effectiveLimit: number,
  activeTrace: TraceCollector,
): Promise<PostProcessedSearch> {
  const result = await maybeExpandViaTLL(
    deps,
    userId,
    query,
    postProcessed.memories,
    effectiveLimit,
  );
  // Surface the fail-open path on the retrieval trace as a distinct
  // event so the failure is observable in trace artifacts even when no
  // augmentation rows are produced. Pairs with the structured
  // `[tll-expansion-failed]` log line emitted by `maybeExpandViaTLL`.
  if (result.failed) {
    activeTrace.event('tll_expansion_failed', { errorMessage: result.errorMessage });
  }
  if (result.memories.length === 0) return postProcessed;
  activeTrace.stage('tll-augmentation', [...postProcessed.memories, ...result.memories], {
    addedCount: result.memories.length,
    addedIds: result.memories.map((m) => m.id),
  });
  return {
    ...postProcessed,
    memories: [...postProcessed.memories, ...result.memories],
  };
}

/**
 * TLL retrieval signal. For ordering/temporal/multi-session queries, expand
 * the candidate set by traversing entity event chains. Returns hydrated
 * SearchResult rows tagged with `retrieval_signal: 'tll-chain'` so the
 * relevance gate can recognize them as non-similarity-scored augmentations.
 *
 * Fail-open by design: chain expansion errors never block primary
 * retrieval. The deliberate fallback is to log the error with a
 * structured `[tll-expansion-failed]` prefix and surface a
 * `tll_expansion_failed` event on the retrieval trace so the failure is
 * observable rather than lost.
 */
async function maybeExpandViaTLL(
  deps: MemoryServiceDeps,
  userId: string,
  query: string,
  memories: SearchResult[],
  effectiveLimit: number,
): Promise<TllExpansionResult> {
  if (!deps.tllRepository || memories.length === 0 || !shouldUseTLL(query)) {
    return { memories: [], failed: false };
  }
  try {
    const initialIds = memories.slice(0, TLL_ENTITY_LOOKUP_SEED_LIMIT).map((m) => m.id);
    const chainIds = await expandViaTLL(userId, initialIds, deps.tllRepository, deps.stores.pool);
    const knownIds = new Set(memories.map((m) => m.id));
    const newIds = chainIds.filter((id) => !knownIds.has(id)).slice(0, effectiveLimit);
    if (newIds.length === 0) return { memories: [], failed: false };
    const hydrated = await hydrateChainMemories(deps, userId, newIds);
    console.log(`[tll-retrieval] expanded ${newIds.length} chain memories for ordering query`);
    return { memories: hydrated, failed: false };
  } catch (err) {
    // Fail-open: TLL is augmentation, never block primary retrieval.
    // Structured prefix `[tll-expansion-failed]` lets log scrapers
    // pick this up as a distinct failure class. The retrieval-trace
    // event is added by the caller (see `appendTllAugmentation`).
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error('[tll-expansion-failed]', errorMessage);
    return { memories: [], failed: true, errorMessage };
  }
}

/**
 * Direct SQL hydration into SearchResult shape — bypasses the store
 * abstraction since this is a deterministic chain-traversal augmentation,
 * not a similarity search. Selects the full memories row and runs it
 * through `normalizeMemoryRow` so every required `MemoryRow` field is
 * present (response formatters call `.toFixed()` on `score`/`similarity`
 * and read `source_site`/`summary` directly — partial rows crash there).
 *
 * Three non-obvious requirements addressed by the SQL + projection shape:
 *
 *   1. Order preservation. `expandViaTLL` returns memory IDs in
 *      chronological observation_date order; a plain `WHERE id = ANY(...)`
 *      does not preserve input order. Joining against
 *      `unnest($2::uuid[]) WITH ORDINALITY` and `ORDER BY req.ord`
 *      keeps the chronology intact through hydration.
 *
 *   2. Workspace isolation. `performSearch` is the global retrieval
 *      path — `postProcessResults` already drops workspace-scoped rows
 *      before TLL augmentation, but the augmented rows hydrate from a
 *      separate query and must apply the same filter, otherwise a
 *      workspace memory chained from a global memory's entity would
 *      leak into a global response.
 *
 *   3. Defensive `relevance: 1.0`. The augmented rows are appended after
 *      `applySearchRelevanceFilter`, so they don't pass through the
 *      similarity gate today. But chain-membership rows have no
 *      meaningful similarity score against the query — `similarity: 0`
 *      and `score: 0` make them load-bearing on the relevance value if
 *      any future filter past this point checks `memory.relevance >=
 *      threshold`. Setting `relevance: 1.0` (the max) locks in the
 *      bypass invariant against drift; the `retrieval_signal: 'tll-chain'`
 *      tag remains the canonical way to detect a chain-augmented row.
 */
async function hydrateChainMemories(
  deps: MemoryServiceDeps,
  userId: string,
  newIds: string[],
): Promise<SearchResult[]> {
  const hydratedRes = await deps.stores.pool.query<Record<string, unknown>>(
    `SELECT m.*
     FROM unnest($2::uuid[]) WITH ORDINALITY AS req(id, ord)
     JOIN memories m ON m.id = req.id
     WHERE m.user_id = $1
       AND m.deleted_at IS NULL
       AND m.status = 'active'
       AND m.workspace_id IS NULL
     ORDER BY req.ord`,
    [userId, newIds],
  );
  return hydratedRes.rows.map((row): SearchResult => ({
    ...normalizeMemoryRow(row),
    similarity: 0,
    score: 0,
    relevance: 1.0,
    retrieval_signal: 'tll-chain',
  }));
}
