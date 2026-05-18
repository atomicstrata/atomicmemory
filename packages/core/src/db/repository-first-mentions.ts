/**
 * Repository for first-mention events — per-user chronological list of
 * "the first time topic X was introduced in conversation."
 *
 * Distinct from atomic facts (claims) and memories (chunks). The grain
 * matches BEAM event-ordering rubrics: which aspects did the user bring
 * up, and in what order.
 *
 * Entries are produced post-ingest by FirstMentionService via a single
 * LLM scan of the full conversation. Storage is idempotent on
 * (user_id, memory_id) so re-running the extractor does not duplicate.
 */

import pg from 'pg';

export interface FirstMentionEvent {
  topic: string;
  turnId: number;
  memoryId: string;
  anchorDate: Date | null;
  positionInConversation: number;
}

export class FirstMentionRepository {
  constructor(private pool: pg.Pool) {}

  /**
   * Idempotent batch INSERT. Conflicts on (user_id, memory_id) are
   * silently dropped, so re-running the extractor for the same
   * conversation does not produce duplicate rows.
   */
  async store(
    userId: string,
    sourceSite: string,
    events: FirstMentionEvent[],
  ): Promise<void> {
    if (events.length === 0) return;

    const values: string[] = [];
    const params: unknown[] = [];
    let p = 1;
    for (const ev of events) {
      values.push(
        `($${p}, $${p + 1}, $${p + 2}, $${p + 3}, $${p + 4}, $${p + 5}, $${p + 6})`,
      );
      params.push(
        userId,
        ev.topic,
        ev.turnId,
        ev.memoryId,
        ev.anchorDate,
        ev.positionInConversation,
        sourceSite,
      );
      p += 7;
    }

    await this.pool.query(
      `INSERT INTO first_mention_events
        (user_id, topic, turn_id, memory_id, anchor_date,
         position_in_conversation, source_site)
        VALUES ${values.join(', ')}
        ON CONFLICT (user_id, memory_id) DO NOTHING`,
      params,
    );
  }

  /**
   * Look up a single first-mention event by memory_id.
   * Returns null if no event is associated with the memory.
   */
  async getByMemoryId(
    userId: string,
    memoryId: string,
  ): Promise<FirstMentionEvent | null> {
    const result = await this.pool.query(
      `SELECT topic, turn_id, memory_id, anchor_date, position_in_conversation
       FROM first_mention_events
       WHERE user_id = $1 AND memory_id = $2
       LIMIT 1`,
      [userId, memoryId],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return {
      topic: row.topic,
      turnId: row.turn_id,
      memoryId: row.memory_id,
      anchorDate: row.anchor_date,
      positionInConversation: row.position_in_conversation,
    };
  }

  /**
   * List all first-mention events for a user, ordered by
   * position_in_conversation ASC. Used by EO/MSR retrieval to surface
   * the chronological topic-introduction list to the answer generator.
   */
  async list(
    userId: string,
    limit: number = 100,
  ): Promise<FirstMentionEvent[]> {
    const result = await this.pool.query(
      `SELECT topic, turn_id, memory_id, anchor_date, position_in_conversation
       FROM first_mention_events
       WHERE user_id = $1
       ORDER BY position_in_conversation ASC
       LIMIT $2`,
      [userId, limit],
    );
    return result.rows.map((row) => ({
      topic: row.topic,
      turnId: row.turn_id,
      memoryId: row.memory_id,
      anchorDate: row.anchor_date,
      positionInConversation: row.position_in_conversation,
    }));
  }
}
