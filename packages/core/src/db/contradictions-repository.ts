/**
 * ContradictionsRepository — bilateral preservation of contradictory memories.
 *
 * Phase: BEAM CR fix (2026-05-12). Instead of AUDN's DELETE/SUPERSEDE path
 * discarding the older side of a contradiction, the bilateral path keeps
 * both rows in `memories` and records the conflict here for analytics +
 * retrieval-side enrichment.
 *
 * Pure SQL via pg.Pool. Mutations fail closed — errors propagate to the caller.
 */
import type pg from 'pg';

export interface ContradictionRow {
  id: string;
  userId: string;
  conversationId: string | null;
  leftMemoryId: string;
  rightMemoryId: string;
  leftSummary: string;
  rightSummary: string;
  resolved: boolean;
  resolutionNote: string | null;
  detectedAt: Date;
}

interface RecordContradictionInput {
  userId: string;
  conversationId?: string | null;
  leftMemoryId: string;
  rightMemoryId: string;
  leftSummary: string;
  rightSummary: string;
}

export class ContradictionsRepository {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Insert a new contradiction row. Returns the generated row id so callers
   * (memory-audn bilateral path) can attach the id to both memory rows in
   * the same transaction-style flow.
   */
  async record(input: RecordContradictionInput): Promise<string> {
    const { rows } = await this.pool.query(
      `INSERT INTO memory_contradictions
         (user_id, conversation_id, left_memory_id, right_memory_id,
          left_summary, right_summary)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        input.userId,
        input.conversationId ?? null,
        input.leftMemoryId,
        input.rightMemoryId,
        input.leftSummary,
        input.rightSummary,
      ],
    );
    if (rows.length === 0) {
      throw new Error('ContradictionsRepository.record: insert returned no rows');
    }
    return rows[0].id as string;
  }

  /**
   * Find active (unresolved) contradiction rows for the given user whose
   * left OR right memory id is in the provided list. Used by retrieval
   * enrichment to fetch contradiction pairs when a `contradiction_active`
   * memory appears in top-K.
   */
  async findActiveByUserAndMemoryIds(
    userId: string,
    memoryIds: readonly string[],
  ): Promise<ContradictionRow[]> {
    if (memoryIds.length === 0) return [];
    const { rows } = await this.pool.query(
      `SELECT id, user_id, conversation_id, left_memory_id, right_memory_id,
              left_summary, right_summary, resolved, resolution_note, detected_at
       FROM memory_contradictions
       WHERE user_id = $1
         AND resolved = false
         AND (left_memory_id = ANY($2::uuid[]) OR right_memory_id = ANY($2::uuid[]))`,
      [userId, memoryIds as string[]],
    );
    return rows.map(mapRow);
  }

  /**
   * Apply the bilateral contradiction flags to BOTH memory rows: each row's
   * `contradicts_memory_id` is set to its counterpart and
   * `contradiction_active=true`. Fails closed: errors propagate so the
   * caller never silently falls back to ADD when the bilateral write fails.
   */
  async markContradictionFlagsBilateral(
    userId: string,
    memoryIdA: string,
    memoryIdB: string,
  ): Promise<void> {
    const existing = await this.pool.query(
      `SELECT COUNT(*)::int AS count
       FROM memories
       WHERE user_id = $1 AND id IN ($2::uuid, $3::uuid)`,
      [userId, memoryIdA, memoryIdB],
    );
    const existingCount = Number(existing.rows[0]?.count ?? 0);
    if (existingCount !== 2) {
      throw new Error(
        `markContradictionFlagsBilateral: expected to update 2 rows, ` +
          `updated ${existingCount} (userId=${userId}, ids=${memoryIdA},${memoryIdB})`,
      );
    }

    const result = await this.pool.query(
      `UPDATE memories
       SET contradicts_memory_id = CASE
             WHEN id = $2 THEN $3::uuid
             WHEN id = $3 THEN $2::uuid
             ELSE contradicts_memory_id
           END,
           contradiction_active = true
       WHERE user_id = $1 AND id IN ($2::uuid, $3::uuid)`,
      [userId, memoryIdA, memoryIdB],
    );
    if (result.rowCount !== 2) {
      throw new Error(
        `markContradictionFlagsBilateral: expected to update 2 rows, ` +
          `updated ${result.rowCount ?? 0} (userId=${userId}, ids=${memoryIdA},${memoryIdB})`,
      );
    }
  }
}

function mapRow(r: pg.QueryResultRow): ContradictionRow {
  return {
    id: r.id,
    userId: r.user_id,
    conversationId: r.conversation_id,
    leftMemoryId: r.left_memory_id,
    rightMemoryId: r.right_memory_id,
    leftSummary: r.left_summary,
    rightSummary: r.right_summary,
    resolved: r.resolved,
    resolutionNote: r.resolution_note,
    detectedAt: r.detected_at,
  };
}
