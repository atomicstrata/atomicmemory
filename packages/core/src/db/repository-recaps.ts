/**
 * Repository for the Recap layer (Sprint 3 v1).
 *
 * Handles read + write for the `episodes` table and the cross-table
 * "find unconsolidated clusters" query that drives the Recap builder's
 * background pass.
 */

import pg from 'pg';

/** Parse pgvector's text representation `[1.2, 3.4, ...]` into number[]. */
function parsePgVector(s: string): number[] {
  if (!s) return [];
  const trimmed = s.trim().replace(/^\[|\]$/g, '');
  if (!trimmed) return [];
  return trimmed.split(',').map((x) => Number(x.trim()));
}

export interface RecapRow {
  id: string;
  user_id: string;
  recap_text: string;
  /** Pre-computed recap embedding — surfaced so downstream MMR can compute cosine similarity without re-embedding. */
  recap_embedding: number[];
  topic: string;
  member_count: number;
  similarity: number;
}

export interface UnconsolidatedCluster {
  topic: string;
  member_ids: string[];
  member_contents: string[];
  time_range_start: Date | null;
  time_range_end: Date | null;
}

/**
 * Map a raw cluster row (topic + member arrays + time range columns) into
 * an `UnconsolidatedCluster`. The two cluster queries above (topic-pivot
 * and session-pivot) project the same columns, so the row-mapping shape
 * is identical; this helper keeps the SQL inline in each variant and only
 * lifts the post-query mapping that was actually duplicated.
 */
function mapUnconsolidatedClusterRow(row: {
  topic: unknown;
  member_ids: unknown;
  member_contents: unknown;
  time_start: unknown;
  time_end: unknown;
}): UnconsolidatedCluster {
  return {
    topic: row.topic as string,
    member_ids: row.member_ids as string[],
    member_contents: row.member_contents as string[],
    time_range_start: row.time_start as Date | null,
    time_range_end: row.time_end as Date | null,
  };
}

export interface StoreRecapInput {
  userId: string;
  recapText: string;
  recapEmbedding: number[];
  topic: string;
  memberMemoryIds: string[];
  timeRangeStart: Date | null;
  timeRangeEnd: Date | null;
}

export type RecapClusterPivot = 'topic' | 'session';

/**
 * Find clusters of un-consolidated memories for a given user.
 *
 * Two pivots supported:
 *   'topic'   — cluster by topic_abstraction (requires topic-abstraction
 *               layer ON at ingest). Original Sprint 3 v1 design.
 *               Empirically regressed fact-anchored abilities; v2 backlog #2
 *               re-pivots to 'session'.
 *   'session' — cluster by user_id + observed_at hour bucket. Captures
 *               cross-turn aggregation within a conversation/session window
 *               without depending on the broken topic-abstraction layer.
 */
export async function findUnconsolidatedClusters(
  pool: pg.Pool,
  userId: string,
  minSize: number,
  pivot: RecapClusterPivot = 'topic',
): Promise<UnconsolidatedCluster[]> {
  return pivot === 'session'
    ? findUnconsolidatedSessionClusters(pool, userId, minSize)
    : findUnconsolidatedTopicClusters(pool, userId, minSize);
}

async function findUnconsolidatedTopicClusters(
  pool: pg.Pool,
  userId: string,
  minSize: number,
): Promise<UnconsolidatedCluster[]> {
  const result = await pool.query(
    `SELECT topic_abstraction AS topic,
            array_agg(id ORDER BY observed_at) AS member_ids,
            array_agg(content ORDER BY observed_at) AS member_contents,
            MIN(observed_at) AS time_start,
            MAX(observed_at) AS time_end,
            COUNT(*) AS n
     FROM memories
     WHERE user_id = $1
       AND deleted_at IS NULL
       AND expired_at IS NULL
       AND status = 'active'
       AND workspace_id IS NULL
       AND topic_abstraction IS NOT NULL
       AND topic_abstraction <> ''
       AND recap_id IS NULL
     GROUP BY topic_abstraction
     HAVING COUNT(*) >= $2
     ORDER BY COUNT(*) DESC
     LIMIT 32`,
    [userId, minSize],
  );
  return result.rows.map(mapUnconsolidatedClusterRow);
}

/**
 * Session-clustered variant: groups un-consolidated memories within a
 * sliding 6-hour observed_at window for the same user. The "topic" field
 * returned is a synthetic label `session-<bucket-iso>` so downstream
 * storage layout is unchanged. Doesn't depend on topic_abstraction —
 * works on raw observed_at, available since AM ingest start.
 */
async function findUnconsolidatedSessionClusters(
  pool: pg.Pool,
  userId: string,
  minSize: number,
): Promise<UnconsolidatedCluster[]> {
  const result = await pool.query(
    `SELECT 'session-' || to_char(date_trunc('hour', observed_at - INTERVAL '0 hours'), 'YYYY-MM-DD"T"HH24') AS topic,
            array_agg(id ORDER BY observed_at) AS member_ids,
            array_agg(content ORDER BY observed_at) AS member_contents,
            MIN(observed_at) AS time_start,
            MAX(observed_at) AS time_end,
            COUNT(*) AS n
     FROM memories
     WHERE user_id = $1
       AND deleted_at IS NULL
       AND expired_at IS NULL
       AND status = 'active'
       AND workspace_id IS NULL
       AND recap_id IS NULL
     GROUP BY date_trunc('hour', observed_at)
     HAVING COUNT(*) >= $2
     ORDER BY MAX(observed_at) DESC
     LIMIT 32`,
    [userId, minSize],
  );
  return result.rows.map(mapUnconsolidatedClusterRow);
}

/**
 * Insert a new episode and mark its member memories as consolidated.
 * Wrapped in a transaction so member-flag updates can't drift from the
 * episode insert.
 */
export async function storeRecap(
  pool: pg.Pool,
  input: StoreRecapInput,
): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const insertResult = await client.query(
      `INSERT INTO recaps
        (user_id, recap_text, recap_embedding, topic,
         member_memory_ids, member_count,
         time_range_start, time_range_end)
       VALUES ($1, $2, $3::vector, $4, $5::uuid[], $6, $7, $8)
       RETURNING id`,
      [
        input.userId,
        input.recapText,
        JSON.stringify(input.recapEmbedding),
        input.topic,
        input.memberMemoryIds,
        input.memberMemoryIds.length,
        input.timeRangeStart,
        input.timeRangeEnd,
      ],
    );
    const episodeId = insertResult.rows[0].id as string;
    if (input.memberMemoryIds.length > 0) {
      await client.query(
        `UPDATE memories
         SET recap_id = $1
         WHERE id = ANY($2::uuid[]) AND user_id = $3`,
        [episodeId, input.memberMemoryIds, input.userId],
      );
    }
    await client.query('COMMIT');
    return episodeId;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Find episode candidates by embedding similarity. Used as a dedicated
 * RRF channel at retrieval.
 */
export async function findRecapCandidates(
  pool: pg.Pool,
  userId: string,
  queryEmbedding: number[],
  limit: number,
): Promise<RecapRow[]> {
  const result = await pool.query(
    `SELECT id, user_id, recap_text, recap_embedding::text AS recap_embedding,
            topic, member_count,
            1 - (recap_embedding <=> $2::vector) AS similarity
     FROM recaps
     WHERE user_id = $1
       AND workspace_id IS NULL
     ORDER BY recap_embedding <=> $2::vector
     LIMIT $3`,
    [userId, JSON.stringify(queryEmbedding), limit],
  );
  return result.rows.map((row) => ({
    id: row.id as string,
    user_id: row.user_id as string,
    recap_text: row.recap_text as string,
    recap_embedding: parsePgVector(row.recap_embedding as string),
    topic: row.topic as string,
    member_count: Number(row.member_count),
    similarity: Number(row.similarity),
  }));
}
