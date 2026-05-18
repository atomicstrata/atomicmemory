/**
 * Phase 4b — TLL retrieval signal.
 *
 * For event-ordering / temporal-reasoning / multi-session-reasoning queries,
 * expand the candidate set by traversing entity TLL chains. This is the
 * unique architectural primitive: nobody else ships per-entity event-chain
 * traversal at retrieval time.
 *
 * The mechanism:
 *   1. From the initial retrieval candidates, find which entities they link.
 *   2. For each entity, fetch its full TLL chain (event sequence).
 *   3. Merge chain memory_ids into the candidate pool.
 *   4. Boost score for memories that appear in TLL chains for the query's
 *      entities — they're explicitly part of the chronological story.
 *
 * Skipped for non-ordering queries (factual lookups don't need chains).
 */

import type pg from 'pg';
import type { TllRepository } from '../db/repository-tll.js';

/**
 * Cap on the number of top similarity-ranked candidates that seed TLL
 * entity-lookup. Bounds the per-query fan-out for the
 * `memory_entities` join — a higher value increases recall on
 * sprawling queries but inflates the worst-case row scan when an
 * entity dictionary is dense. 10 matches the production search seed
 * count in `memory-search.ts` so both call sites move together.
 */
export const TLL_ENTITY_LOOKUP_SEED_LIMIT = 10;

/**
 * Single-token ordering signals. Matched in isolation these are too
 * weak to gate TLL — "what is my FIRST name", "the model used BEFORE
 * GPT-4", "we then moved on" all contain one of these but are not
 * EO/MSR/TR queries. We require either two of them to co-occur, or
 * one of the structural sequence patterns below, before firing.
 */
const ORDERING_TERMS_RE =
  /\b(first|last|before|after|then|later|earlier|previous|next|prior)\b/gi;

/**
 * Structural sequence patterns. Each one is a phrase whose presence
 * unambiguously indicates an ordering / temporal-reasoning question.
 * Single-pattern hit is enough to gate TLL.
 *
 * Curated to keep precision high: "track my spending" and "what is my
 * first name" must not match any pattern here. Add new patterns
 * conservatively — a leak here will silently re-introduce the
 * false-positive class this fix addresses.
 */
const SEQUENCE_PATTERNS: readonly RegExp[] = [
  /\bin (what |the )?(chronological |reverse )?order\b/i,
  /\b(when|after) did\b/i,
  /\bsince when\b/i,
  /\bover time\b/i,
  /\bevolution of\b/i,
  /\b(history|timeline) of\b/i,
  /\bbrought up\b/i,
  /\b(originally|initially)\b/i,
  /\bprogression of\b/i,
  /\bhow .{1,80}(evolved?|shifted?|changed)\b/i,
  /\bwhat .{1,80}(originally|initially)\b/i,
];

/**
 * Returns true if the query has the shape of an event-ordering / temporal
 * question and should trigger TLL chain expansion. The gate is
 * intentionally conservative: TLL augmentation is augmentation, not the
 * primary retrieval path, so over-firing was producing irrelevant chain
 * memories on plain-fact queries that happened to contain "first",
 * "before", "track", etc.
 *
 * Two ordering terms co-occurring (e.g. "what did I discuss BEFORE and
 * AFTER X") is a strong-enough signal on its own; one structural
 * sequence phrase (e.g. "in what order", "evolution of", "since when")
 * is also strong enough. Single ordering term + nothing else is not.
 */
export function shouldUseTLL(query: string): boolean {
  const orderingMatches = (query.match(ORDERING_TERMS_RE) ?? []).length;
  if (orderingMatches >= 2) return true;
  return SEQUENCE_PATTERNS.some((re) => re.test(query));
}

/**
 * Get the entity_ids linked to a set of memory_ids via memory_entities.
 * Used to find which entities to chain-traverse from initial retrieval.
 * Exported for direct unit testing of SQL shape; the production caller
 * is `expandViaTLL` below.
 */
export async function entitiesForMemories(
  pool: pg.Pool,
  memoryIds: string[],
): Promise<string[]> {
  if (memoryIds.length === 0) return [];
  const result = await pool.query(
    `SELECT DISTINCT entity_id FROM memory_entities WHERE memory_id = ANY($1::uuid[])`,
    [memoryIds],
  );
  return result.rows.map((r) => r.entity_id);
}

/**
 * Expand candidate set via TLL chain traversal for the entities most
 * relevant to the query (derived from initial retrieval).
 * Returns: array of memory_ids in chronological chain order, deduplicated.
 */
export async function expandViaTLL(
  userId: string,
  initialMemoryIds: string[],
  tllRepository: TllRepository,
  pool: pg.Pool,
): Promise<string[]> {
  if (initialMemoryIds.length === 0) return [];
  const entityIds = await entitiesForMemories(
    pool,
    initialMemoryIds.slice(0, TLL_ENTITY_LOOKUP_SEED_LIMIT),
  );
  if (entityIds.length === 0) return [];
  return tllRepository.chainsFor(userId, entityIds);
}
