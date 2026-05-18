/**
 * BEAM v38: temporal-state repository helpers.
 *
 * Two operations are exposed:
 *   - `supersedePriorStateMemories` — UPDATE prior memories with the same
 *     (user_id, state_key) so they close their event_end window when a
 *     new memory takes over that key. Fails closed; the caller MUST
 *     propagate the error and abort the ingest if this throws.
 *   - `findActiveStateMemoryIds` — diagnostic / test helper returning the
 *     IDs of memories that are currently active (event_end IS NULL) for
 *     a (user_id, state_key) pair.
 */

import type pg from 'pg';

/**
 * Set `event_end = $eventEnd` on every prior, non-deleted memory whose
 * (user_id, state_key) matches, EXCEPT the new memory itself. Returns
 * the number of rows updated.
 *
 * Why fail closed: the supersede signal is the entire point of the
 * temporal layer. Silently dropping it would leave both rows active
 * and break the read-time rerank invariant.
 */
export async function supersedePriorStateMemories(
  pool: pg.Pool,
  args: {
    userId: string;
    stateKey: string;
    newMemoryId: string;
    eventEnd: Date;
  },
): Promise<number> {
  const result = await pool.query(
    `UPDATE memories
        SET event_end = $4
      WHERE user_id = $1
        AND state_key = $2
        AND id <> $3::uuid
        AND event_end IS NULL
        AND deleted_at IS NULL`,
    [args.userId, args.stateKey, args.newMemoryId, args.eventEnd.toISOString()],
  );
  return result.rowCount ?? 0;
}

/**
 * Return the IDs of the active memories for a (user_id, state_key) pair.
 * Used in tests and as a diagnostic seam — production retrieval does NOT
 * call this; it reranks the candidates already in hand by their
 * `event_end` field.
 */
export async function findActiveStateMemoryIds(
  pool: pg.Pool,
  userId: string,
  stateKey: string,
): Promise<string[]> {
  const result = await pool.query(
    `SELECT id FROM memories
      WHERE user_id = $1
        AND state_key = $2
        AND event_end IS NULL
        AND deleted_at IS NULL
      ORDER BY event_start DESC NULLS LAST`,
    [userId, stateKey],
  );
  return result.rows.map((row: { id: string }) => row.id);
}
