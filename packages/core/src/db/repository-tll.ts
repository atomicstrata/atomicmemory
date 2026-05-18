/**
 * Repository for the Temporal Linkage List (TLL) — per-entity sparse graph
 * of event nodes connected by predecessor/successor edges.
 *
 * Purpose: maintain "what happened in what order, per entity" without
 * paying the full graph-DB cost. Each new memory referencing an entity
 * appends an event node; the predecessor pointer lets us traverse the
 * chain backward at query time for EO/MSR/TR questions.
 */

import pg from 'pg';

export interface TLLEvent {
  memoryId: string;
  predecessorMemoryId: string | null;
  observationDate: Date;
  positionInChain: number;
}

// Stable namespace for pg_advisory_xact_lock keying. Keeps TLL appends from
// colliding with unrelated advisory-lock callers in the same process.
const TLL_ADVISORY_LOCK_NAMESPACE = 0x544c4c00; // "TLL\0"

export class TllRepository {
  constructor(private pool: pg.Pool) {}

  /**
   * Append an event node to each entity's chain. Idempotent on
   * (user_id, entity_id, memory_id). Predecessor is the most-recent
   * existing event for the entity; position is len(chain).
   *
   * Race-safety: each (user_id, entity_id) append runs inside a transaction
   * guarded by `pg_advisory_xact_lock`. Concurrent appends targeting the
   * same chain serialize on the lock, then compute the next position from
   * committed rows via INSERT...SELECT. The
   * `(user_id, entity_id, position_in_chain)` unique index is the
   * defense-in-depth backstop that fails loudly if any caller bypasses the
   * lock path.
   */
  async append(
    userId: string,
    memoryId: string,
    entityIds: string[],
    observationDate: Date,
  ): Promise<void> {
    if (entityIds.length === 0) return;
    const uniqueEntities = [...new Set(entityIds)];

    // Per-entity transactions keep the advisory-lock scope narrow and let
    // independent chains proceed in parallel.
    for (const entityId of uniqueEntities) {
      await this.appendOne(userId, memoryId, entityId, observationDate);
    }
  }

  /**
   * Append one (entity, memory) row under an advisory lock keyed on the
   * chain. The INSERT...SELECT computes predecessor + position inline from
   * the latest committed row, so the read-then-write window the previous
   * implementation exposed cannot reorder concurrent appends.
   */
  private async appendOne(
    userId: string,
    memoryId: string,
    entityId: string,
    observationDate: Date,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [
        TLL_ADVISORY_LOCK_NAMESPACE,
        `${userId}:${entityId}`,
      ]);
      await client.query(
        `INSERT INTO temporal_linkage_list
           (user_id, entity_id, memory_id, predecessor_memory_id,
            observation_date, position_in_chain)
         SELECT
           $1, $2, $3,
           (SELECT memory_id FROM temporal_linkage_list
              WHERE user_id = $1 AND entity_id = $2
              ORDER BY position_in_chain DESC LIMIT 1),
           $4,
           COALESCE(
             (SELECT MAX(position_in_chain) FROM temporal_linkage_list
                WHERE user_id = $1 AND entity_id = $2),
             -1
           ) + 1
         ON CONFLICT (user_id, entity_id, memory_id) DO NOTHING`,
        [userId, entityId, memoryId, observationDate],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch((rollbackErr) =>
        console.error('[tll] rollback failed:', rollbackErr instanceof Error ? rollbackErr.message : rollbackErr),
      );
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Get the full event chain for an entity, ordered by observation_date
   * (the conversation timestamp). Used for EO/TR/MSR queries that need
   * chronological order — a backfilled event with an earlier
   * observation_date surfaces in its true chronological position even
   * though it was inserted last.
   *
   * `positionInChain` returned here is the 0-based chronological rank,
   * derived via `ROW_NUMBER()` over the chronological order. The stored
   * `position_in_chain` column is insertion-order audit metadata and is
   * not exposed by this API. `predecessorMemoryId` is the immediate
   * chronologically-prior memory (via `LAG()`) — also chronological,
   * not the position-tip predecessor recorded at insert time.
   *
   * Tiebreaker for events sharing an `observation_date` (e.g. the same
   * conversation timestamp) is the stored `position_in_chain` (insertion
   * order), keeping the result deterministic.
   */
  async chain(userId: string, entityId: string): Promise<TLLEvent[]> {
    const result = await this.pool.query(
      `SELECT memory_id,
              observation_date,
              LAG(memory_id) OVER w AS chronological_predecessor,
              ROW_NUMBER() OVER w - 1 AS chronological_position
       FROM temporal_linkage_list
       WHERE user_id = $1 AND entity_id = $2
       WINDOW w AS (ORDER BY observation_date ASC, position_in_chain ASC)
       ORDER BY observation_date ASC, position_in_chain ASC`,
      [userId, entityId],
    );
    return result.rows.map((row) => ({
      memoryId: row.memory_id,
      predecessorMemoryId: row.chronological_predecessor ?? null,
      observationDate: row.observation_date,
      positionInChain: Number(row.chronological_position),
    }));
  }

  /**
   * Bulk: get chains for multiple entities. Returns memory_ids in order
   * across all entity chains, deduplicated. Used as a retrieval signal
   * for queries that span multiple entities (MSR).
   */
  async chainsFor(userId: string, entityIds: string[]): Promise<string[]> {
    if (entityIds.length === 0) return [];
    const result = await this.pool.query(
      `SELECT DISTINCT memory_id, observation_date
       FROM temporal_linkage_list
       WHERE user_id = $1 AND entity_id = ANY($2::uuid[])
       ORDER BY observation_date ASC`,
      [userId, [...new Set(entityIds)]],
    );
    return result.rows.map((row) => row.memory_id);
  }

  /**
   * Bulk-retrieve enriched event chains: per-entity ordered list of events
   * joined with memory content. Used by the event-chains HTTP endpoint and
   * by EO-shaped read paths that need content alongside chain position.
   *
   * Returns one entry per entity; entities with no events are dropped.
   * Within an entity, events are ordered by `observation_date` (the
   * conversation timestamp), not insertion order — see `chain()` for
   * the rationale and the `LAG`/`ROW_NUMBER` derivation of
   * `predecessorMemoryId` and `positionInChain`. Tiebreaker for events
   * sharing an observation_date is the stored insertion `position_in_chain`.
   */
  async chainEventsForEntities(
    userId: string,
    entityIds: string[],
  ): Promise<Array<{
    entityId: string;
    events: Array<{
      memoryId: string;
      content: string;
      observationDate: Date;
      positionInChain: number;
      predecessorMemoryId: string | null;
    }>;
  }>> {
    if (entityIds.length === 0) return [];
    const unique = [...new Set(entityIds)];
    // `m.workspace_id IS NULL` — this is the global event-chain endpoint;
    // workspace-scoped memories must not surface here even if they share
    // an entity with a global memory.
    const result = await this.pool.query(
      `SELECT t.entity_id,
              t.memory_id,
              t.observation_date,
              LAG(t.memory_id) OVER w AS chronological_predecessor,
              ROW_NUMBER() OVER w - 1 AS chronological_position,
              m.content
       FROM temporal_linkage_list t
       JOIN memories m ON m.id = t.memory_id
       WHERE t.user_id = $1
         AND t.entity_id = ANY($2::uuid[])
         AND m.deleted_at IS NULL
         AND m.status = 'active'
         AND m.workspace_id IS NULL
       WINDOW w AS (
         PARTITION BY t.entity_id
         ORDER BY t.observation_date ASC, t.position_in_chain ASC
       )
       ORDER BY t.entity_id, t.observation_date ASC, t.position_in_chain ASC`,
      [userId, unique],
    );
    const grouped = new Map<string, Array<{
      memoryId: string;
      content: string;
      observationDate: Date;
      positionInChain: number;
      predecessorMemoryId: string | null;
    }>>();
    for (const row of result.rows) {
      const list = grouped.get(row.entity_id) ?? [];
      list.push({
        memoryId: row.memory_id,
        content: row.content,
        observationDate: row.observation_date,
        positionInChain: Number(row.chronological_position),
        predecessorMemoryId: row.chronological_predecessor ?? null,
      });
      grouped.set(row.entity_id, list);
    }
    return [...grouped.entries()].map(([entityId, events]) => ({ entityId, events }));
  }
}
