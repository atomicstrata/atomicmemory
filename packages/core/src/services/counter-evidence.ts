/**
 * Counter-evidence retrieval (Sprint 3 v1.1, V2 backlog item 1).
 *
 * After RRF + MMR selects top-K candidates, look up the belief_edges graph
 * for any COUNTER edges where the target is a top-K memory. Fetch the
 * counter-source memories (which represent the *other side* of a recorded
 * contradiction) and append them to the result set.
 *
 * Surfaces both halves of a contradiction by construction, fixing the
 * failure pattern we diagnosed on AMB BEAM-100K conv 1 question
 * "Have I integrated Flask-Login?" where retrieval surfaced only the
 * affirmative memory and the contradicting denial was scored 0.
 *
 * Feature flag: counterEvidenceEnabled (default OFF). Requires TBC to have
 * been ON at ingest so belief_edges rows exist.
 */

import pg from 'pg';
import type { SearchResult } from '../db/repository-types.js';

/** Max counter-source memories to append per result. Keeps the answer
 *  context from exploding when there are many recorded contradictions. */
const MAX_COUNTER_PER_TARGET = 2;

export interface CounterEvidenceDeps {
  pool: pg.Pool;
}

/**
 * Expand a result list with counter-evidence linked memories.
 *
 * For each candidate, find belief_edges where target_id = candidate.id AND
 * edge_type='counter'. Fetch the unique counter-source memories. Tag each
 * appended row with metadata.counter_evidence_for = [target_ids] so the
 * answer LLM can recognize them as contradicting claims.
 *
 * Returns the original candidates + the expanded set (deduped by id).
 * The expansion preserves the existing top-K order and appends new IDs
 * at the end; downstream MMR/packaging is unchanged.
 */
export async function expandWithCounterEvidence(
  deps: CounterEvidenceDeps,
  userId: string,
  candidates: SearchResult[],
): Promise<SearchResult[]> {
  if (candidates.length === 0) return candidates;
  const candidateIds = candidates.map((c) => c.id);
  const counterSources = await fetchCounterSources(deps.pool, userId, candidateIds);
  if (counterSources.size === 0) return candidates;
  const existingIds = new Set(candidateIds);
  const sourceIdsToFetch = Array.from(counterSources.keys()).filter((id) => !existingIds.has(id));
  if (sourceIdsToFetch.length === 0) return candidates;
  const fetched = await fetchMemoriesByIds(deps.pool, userId, sourceIdsToFetch);
  // Tag each fetched memory with which target(s) it counters.
  const tagged: SearchResult[] = fetched.map((m) => {
    const targets = counterSources.get(m.id) ?? [];
    const extraMeta = { counter_evidence_for: targets, counter_evidence_source: true };
    return {
      ...m,
      metadata: { ...(m.metadata ?? {}), ...extraMeta },
    } as SearchResult;
  });
  return [...candidates, ...tagged];
}

/** Returns a map source_id → list of target_ids that source counters. */
async function fetchCounterSources(
  pool: pg.Pool,
  userId: string,
  targetIds: string[],
): Promise<Map<string, string[]>> {
  if (targetIds.length === 0) return new Map();
  const result = await pool.query<{ source_id: string; target_id: string }>(
    `SELECT source_id, target_id
     FROM belief_edges
     WHERE user_id = $1
       AND target_id = ANY($2::uuid[])
       AND edge_type = 'counter'
     ORDER BY created_at DESC
     LIMIT $3`,
    [userId, targetIds, targetIds.length * MAX_COUNTER_PER_TARGET],
  );
  const out = new Map<string, string[]>();
  for (const row of result.rows) {
    const existing = out.get(row.source_id) ?? [];
    if (!existing.includes(row.target_id)) {
      existing.push(row.target_id);
    }
    out.set(row.source_id, existing);
  }
  return out;
}

async function fetchMemoriesByIds(
  pool: pg.Pool,
  userId: string,
  ids: string[],
): Promise<SearchResult[]> {
  if (ids.length === 0) return [];
  const result = await pool.query(
    `SELECT *,
            0.5 AS similarity,
            0.5 AS score,
            0.5 AS semantic_similarity,
            0.5 AS relevance,
            0.5 AS ranking_score
     FROM memories
     WHERE id = ANY($1::uuid[])
       AND user_id = $2
       AND deleted_at IS NULL
       AND expired_at IS NULL
       AND status = 'active'`,
    [ids, userId],
  );
  return result.rows as SearchResult[];
}
