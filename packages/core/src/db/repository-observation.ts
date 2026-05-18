/**
 * Repository for observation network dirty-marking and regeneration queries.
 * Observations are synthesized entity profiles — regenerated asynchronously
 * when new facts about an entity are ingested.
 */

import pg from 'pg';

export class ObservationRepository {
  constructor(private pool: pg.Pool) {}

  /** Mark entity subjects as needing observation regeneration. Idempotent. */
  async markDirty(userId: string, subjects: string[]): Promise<void> {
    if (subjects.length === 0) return;
    const values = subjects.map((_, i) => `($1, $${i + 2}, NOW())`).join(', ');
    await this.pool.query(
      `INSERT INTO observation_dirty (user_id, subject, marked_at) VALUES ${values}
       ON CONFLICT (user_id, subject) DO UPDATE SET marked_at = NOW()`,
      [userId, ...subjects],
    );
  }

  /** Get all pending observation regeneration tasks. */
  async getPending(limit: number = 50): Promise<Array<{ userId: string; subject: string }>> {
    const result = await this.pool.query(
      `SELECT user_id, subject FROM observation_dirty ORDER BY marked_at ASC LIMIT $1`,
      [limit],
    );
    return result.rows.map((r) => ({ userId: r.user_id, subject: r.subject }));
  }

  /** Clear a dirty mark after successful regeneration. */
  async clearDirty(userId: string, subject: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM observation_dirty WHERE user_id = $1 AND subject = $2`,
      [userId, subject],
    );
  }

  /** Find all memory content linked to a subject entity for synthesis. */
  async findMemoriesForSubject(userId: string, subject: string): Promise<Array<{ id: string; content: string }>> {
    const result = await this.pool.query(
      `SELECT DISTINCT m.id, m.content, m.created_at
       FROM memories m
       JOIN memory_entities me ON me.memory_id = m.id
       JOIN entities e ON e.id = me.entity_id
       WHERE m.user_id = $1
         AND (e.name ILIKE $2 OR $2 = ANY(e.alias_names))
         AND m.deleted_at IS NULL AND m.expired_at IS NULL
         AND m.network != 'observation'
       ORDER BY m.created_at DESC
       LIMIT 50`,
      [userId, subject],
    );
    return result.rows;
  }

  /** Find the existing observation for a subject (to expire it on regeneration). */
  async findExistingObservation(userId: string, subject: string): Promise<string | null> {
    const result = await this.pool.query(
      `SELECT id FROM memories
       WHERE user_id = $1 AND network = 'observation'
         AND observation_subject = $2
         AND deleted_at IS NULL AND expired_at IS NULL
       LIMIT 1`,
      [userId, subject],
    );
    return result.rows[0]?.id ?? null;
  }
}
