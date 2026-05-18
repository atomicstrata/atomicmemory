/**
 * Child representation storage for dual-write memory cells.
 * Parent `memories` rows remain the packaging unit; atomic facts and foresight
 * rows provide retrieval-optimized child views over the same memory.
 */

import pg from 'pg';
import pgvector from 'pgvector/pg';
import { config } from '../config.js';
import {
  normalizeAtomicFactRow,
  normalizeForesightRow,
  normalizeSearchRow,
  type AtomicFactRow,
  type AtomicFactType,
  type ForesightRow,
  type ForesightType,
  type SearchResult,
} from './repository-types.js';
import { RRF_K, buildHybridSearchParams } from './query-helpers.js';

type Queryable = Pick<pg.Pool, 'query'> | pg.PoolClient;

export interface StoreAtomicFactInput {
  userId: string;
  parentMemoryId: string;
  factText: string;
  embedding: number[];
  factType: AtomicFactType;
  importance: number;
  sourceSite: string;
  sourceUrl?: string;
  episodeId?: string;
  keywords?: string;
  metadata?: Record<string, unknown>;
  /** Phase 5: workspace scope for workspace-originated facts. NULL for user-scoped. */
  workspaceId?: string;
  agentId?: string;
}

export interface StoreForesightInput {
  userId: string;
  parentMemoryId: string;
  content: string;
  embedding: number[];
  foresightType: ForesightType;
  sourceSite: string;
  sourceUrl?: string;
  episodeId?: string;
  metadata?: Record<string, unknown>;
  validFrom?: Date;
  validTo?: Date | null;
  /** Phase 5: workspace scope for workspace-originated foresight. NULL for user-scoped. */
  workspaceId?: string;
  agentId?: string;
}

export async function storeAtomicFacts(queryable: Queryable, facts: StoreAtomicFactInput[]): Promise<string[]> {
  const insertedIds: string[] = [];
  for (const fact of facts) {
    const result = await queryable.query(
      `INSERT INTO memory_atomic_facts (
         user_id, parent_memory_id, fact_text, embedding, fact_type, importance,
         source_site, source_url, episode_id, keywords, metadata,
         workspace_id, agent_id
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13)
       RETURNING id`,
      [
        fact.userId,
        fact.parentMemoryId,
        fact.factText,
        pgvector.toSql(fact.embedding),
        fact.factType,
        fact.importance,
        fact.sourceSite,
        fact.sourceUrl ?? '',
        fact.episodeId ?? null,
        fact.keywords ?? '',
        JSON.stringify(fact.metadata ?? {}),
        fact.workspaceId ?? null,
        fact.agentId ?? null,
      ],
    );
    insertedIds.push(result.rows[0].id);
  }
  return insertedIds;
}

export async function replaceAtomicFactsForMemory(
  queryable: Queryable,
  userId: string,
  parentMemoryId: string,
  facts: StoreAtomicFactInput[],
): Promise<string[]> {
  await queryable.query(
    'DELETE FROM memory_atomic_facts WHERE user_id = $1 AND parent_memory_id = $2',
    [userId, parentMemoryId],
  );
  if (facts.length === 0) return [];
  return storeAtomicFacts(queryable, facts);
}

export async function listAtomicFactsForMemory(
  queryable: Queryable,
  userId: string,
  parentMemoryId: string,
): Promise<AtomicFactRow[]> {
  const result = await queryable.query(
    `SELECT * FROM memory_atomic_facts
     WHERE user_id = $1 AND parent_memory_id = $2
     ORDER BY created_at ASC`,
    [userId, parentMemoryId],
  );
  return result.rows.map(normalizeAtomicFactRow);
}

export async function storeForesight(queryable: Queryable, foresight: StoreForesightInput[]): Promise<string[]> {
  const insertedIds: string[] = [];
  for (const entry of foresight) {
    const result = await queryable.query(
      `INSERT INTO memory_foresight (
         user_id, parent_memory_id, content, embedding, foresight_type, source_site,
         source_url, episode_id, metadata, valid_from, valid_to,
         workspace_id, agent_id
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13)
       RETURNING id`,
      [
        entry.userId,
        entry.parentMemoryId,
        entry.content,
        pgvector.toSql(entry.embedding),
        entry.foresightType,
        entry.sourceSite,
        entry.sourceUrl ?? '',
        entry.episodeId ?? null,
        JSON.stringify(entry.metadata ?? {}),
        (entry.validFrom ?? new Date()).toISOString(),
        entry.validTo?.toISOString() ?? null,
        entry.workspaceId ?? null,
        entry.agentId ?? null,
      ],
    );
    insertedIds.push(result.rows[0].id);
  }
  return insertedIds;
}

export async function replaceForesightForMemory(
  queryable: Queryable,
  userId: string,
  parentMemoryId: string,
  foresight: StoreForesightInput[],
): Promise<string[]> {
  await queryable.query(
    'DELETE FROM memory_foresight WHERE user_id = $1 AND parent_memory_id = $2',
    [userId, parentMemoryId],
  );
  if (foresight.length === 0) return [];
  return storeForesight(queryable, foresight);
}

export async function listForesightForMemory(
  queryable: Queryable,
  userId: string,
  parentMemoryId: string,
): Promise<ForesightRow[]> {
  const result = await queryable.query(
    `SELECT * FROM memory_foresight
     WHERE user_id = $1 AND parent_memory_id = $2
     ORDER BY valid_from ASC, created_at ASC`,
    [userId, parentMemoryId],
  );
  return result.rows.map(normalizeForesightRow);
}

export async function searchAtomicFactsHybrid(
  pool: pg.Pool,
  userId: string,
  queryText: string,
  queryEmbedding: number[],
  limit: number,
  sourceSite?: string,
  referenceTime?: Date,
  sessionId?: string,
): Promise<SearchResult[]> {
  const { params, siteFilter } = buildHybridSearchParams(
    queryEmbedding, userId, queryText, limit, 'af.source_site', sourceSite, referenceTime, sessionId, 'm.episode_id',
  );

  const result = await pool.query(
    `WITH vector_ranked AS (
       SELECT af.id, af.parent_memory_id, af.fact_text,
         ROW_NUMBER() OVER (ORDER BY af.embedding <=> $1) AS vrank,
         1 - (af.embedding <=> $1) AS similarity
       FROM memory_atomic_facts af
       JOIN memories m ON m.id = af.parent_memory_id
       WHERE af.user_id = $2
         AND m.deleted_at IS NULL
         AND m.expired_at IS NULL
         AND m.status = 'active'
         AND m.workspace_id IS NULL
         ${siteFilter}
       ORDER BY af.embedding <=> $1
       LIMIT $4 * 6
     ),
     fts_ranked AS (
       SELECT af.id, af.parent_memory_id, af.fact_text,
         ROW_NUMBER() OVER (ORDER BY ts_rank(af.search_vector, plainto_tsquery('english', $3)) DESC) AS ftsrank
       FROM memory_atomic_facts af
       JOIN memories m ON m.id = af.parent_memory_id
       WHERE af.user_id = $2
         AND m.deleted_at IS NULL
         AND m.expired_at IS NULL
         AND m.status = 'active'
         AND m.workspace_id IS NULL
         ${siteFilter}
         AND af.search_vector @@ plainto_tsquery('english', $3)
       ORDER BY ts_rank(af.search_vector, plainto_tsquery('english', $3)) DESC
       LIMIT $4 * 6
     ),
     fused_facts AS (
       SELECT
         COALESCE(v.id, f.id) AS fact_id,
         COALESCE(v.parent_memory_id, f.parent_memory_id) AS parent_memory_id,
         COALESCE(v.fact_text, f.fact_text) AS fact_text,
         COALESCE(v.similarity, 0) AS similarity,
         COALESCE(1.0 / (${RRF_K} + v.vrank), 0) + COALESCE(1.0 / (${RRF_K} + f.ftsrank), 0) AS rrf_score
       FROM vector_ranked v
       FULL OUTER JOIN fts_ranked f ON v.id = f.id
     ),
     parent_ranked AS (
       SELECT
         parent_memory_id,
         MAX(similarity) AS similarity,
         MAX(rrf_score) AS best_rrf_score,
         (ARRAY_AGG(fact_text ORDER BY (similarity + rrf_score) DESC))[1:3] AS matched_facts,
         (ARRAY_AGG(fact_id::text ORDER BY (similarity + rrf_score) DESC))[1:3] AS matched_fact_ids
       FROM fused_facts
       GROUP BY parent_memory_id
     )
     SELECT
       m.*,
       e.session_id,
       p.similarity,
       (
         $5 * p.similarity
         + CASE WHEN p.similarity >= $9 THEN (
           $6 * m.importance
           + $7 * EXP(-EXTRACT(EPOCH FROM ($8::timestamptz - m.last_accessed_at)) / 2592000.0)
         ) ELSE 0 END
         -- Lexical RRF stays outside the semantic boost gate because exact text match is itself a relevance signal.
         + ${config.retrievalProfileSettings.lexicalWeight} * p.best_rrf_score
       ) * COALESCE(m.trust_score, 1.0) AS score,
       p.matched_facts,
       p.matched_fact_ids,
       'atomic_fact'::text AS retrieval_layer
     FROM parent_ranked p
     JOIN memories m ON m.id = p.parent_memory_id
     LEFT JOIN episodes e
       ON e.id = m.episode_id
      AND e.user_id = m.user_id
     ORDER BY score DESC
     LIMIT $4`,
    params,
  );
  return result.rows.map(normalizeSearchRow);
}
