/**
 * Memory link storage and 1-hop traversal queries.
 *
 * Links are bidirectional pairs stored with source_id < target_id to avoid
 * duplicates. Generated at write time when embedding similarity exceeds the
 * configured threshold (Phase 2 roadmap, A-MEM pattern).
 */

import pg from 'pg';
import pgvector from 'pgvector/pg';
import { config } from '../config.js';
import { normalizeSearchRow, type SearchResult } from './repository-types.js';

export interface MemoryLink {
  sourceId: string;
  targetId: string;
  similarity: number;
}

export async function createLinks(
  pool: pg.Pool,
  links: MemoryLink[],
): Promise<number> {
  return createLinksWithClient(pool as any, links);
}

async function createLinksWithClient(
  client: pg.PoolClient,
  links: MemoryLink[],
): Promise<number> {
  if (links.length === 0) return 0;

  const deduped = new Map<string, { lo: string; hi: string; similarity: number }>();
  for (const link of links) {
    const [lo, hi] = canonicalPair(link.sourceId, link.targetId);
    const key = `${lo}:${hi}`;
    const existing = deduped.get(key);
    if (!existing || link.similarity > existing.similarity) {
      deduped.set(key, { lo, hi, similarity: link.similarity });
    }
  }

  const values: string[] = [];
  const params: unknown[] = [];
  for (const { lo, hi, similarity } of deduped.values()) {
    const offset = params.length;
    values.push(`($${offset + 1}, $${offset + 2}, $${offset + 3})`);
    params.push(lo, hi, similarity);
  }

  const result = await client.query(
    `INSERT INTO memory_links (source_id, target_id, similarity)
     VALUES ${values.join(', ')}
     ON CONFLICT (source_id, target_id)
     DO UPDATE SET similarity = EXCLUDED.similarity
     RETURNING source_id`,
    params,
  );
  return result.rowCount ?? 0;
}

export async function findLinkedMemoryIds(
  pool: pg.Pool,
  memoryIds: string[],
  excludeIds: Set<string>,
  limit: number,
): Promise<string[]> {
  if (memoryIds.length === 0) return [];

  const result = await pool.query(
    `SELECT DISTINCT links.linked_id, links.similarity FROM (
       SELECT target_id AS linked_id, similarity
       FROM memory_links WHERE source_id = ANY($1)
       UNION ALL
       SELECT source_id AS linked_id, similarity
       FROM memory_links WHERE target_id = ANY($1)
     ) AS links
     JOIN memories m ON m.id = links.linked_id AND m.workspace_id IS NULL
     ORDER BY links.similarity DESC
     LIMIT $2`,
    [memoryIds, limit * 2],
  );

  return result.rows
    .map((row) => row.linked_id as string)
    .filter((id) => !excludeIds.has(id))
    .slice(0, limit);
}

export async function fetchMemoriesByIds(
  pool: pg.Pool,
  userId: string,
  ids: string[],
  queryEmbedding: number[],
  referenceTime?: Date,
  includeExpired: boolean = false,
): Promise<SearchResult[]> {
  if (ids.length === 0) return [];

  const wSim = config.scoringWeightSimilarity;
  const wImp = config.scoringWeightImportance;
  const wRec = config.scoringWeightRecency;
  const refTime = (referenceTime ?? new Date()).toISOString();

  const expiredClause = includeExpired ? '' : 'AND expired_at IS NULL';
  const result = await pool.query(
    `SELECT *,
       1 - (embedding <=> $1) AS similarity,
       (
         $4 * (1 - (embedding <=> $1))
         + $5 * importance
         + $6 * EXP(-EXTRACT(EPOCH FROM ($7::timestamptz - last_accessed_at)) / 2592000.0)
       ) * COALESCE(trust_score, 1.0) AS score
     FROM memories
     WHERE id = ANY($2)
       AND user_id = $3
       AND deleted_at IS NULL
       ${expiredClause}
       AND status = 'active'
       AND workspace_id IS NULL
     ORDER BY score DESC`,
    [pgvector.toSql(queryEmbedding), ids, userId, wSim, wImp, wRec, refTime],
  );
  return result.rows.map(normalizeSearchRow);
}

export async function findLinkCandidates(
  pool: pg.Pool,
  userId: string,
  embedding: number[],
  threshold: number,
  excludeId: string,
  limit: number,
): Promise<Array<{ id: string; similarity: number }>> {
  return findLinkCandidatesWithClient(pool as any, userId, embedding, threshold, excludeId, limit);
}

export async function findLinkCandidatesWithClient(
  client: pg.PoolClient,
  userId: string,
  embedding: number[],
  threshold: number,
  excludeId: string,
  limit: number,
): Promise<Array<{ id: string; similarity: number }>> {
  const result = await client.query(
    `SELECT id, 1 - (embedding <=> $1) AS similarity
     FROM memories
     WHERE user_id = $2
       AND deleted_at IS NULL
       AND expired_at IS NULL
       AND status = 'active'
       AND id != $3
       AND 1 - (embedding <=> $1) > $4
     ORDER BY similarity DESC
     LIMIT $5`,
    [pgvector.toSql(embedding), userId, excludeId, threshold, limit],
  );
  return result.rows as Array<{ id: string; similarity: number }>;
}

export async function countLinks(pool: pg.Pool): Promise<number> {
  const result = await pool.query('SELECT COUNT(*)::int AS count FROM memory_links');
  return result.rows[0].count;
}

function canonicalPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}
