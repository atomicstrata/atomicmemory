/**
 * Swappable vector search backends for the prototype repository.
 */

import pg from 'pg';
import pgvector from 'pgvector/pg';
import { config } from '../config.js';
import {
  normalizeMemoryRow,
  normalizeSearchRow,
  type AgentScope,
  type MemoryRow,
  type SearchResult,
  type WorkspaceContext,
} from './repository-types.js';
import { RRF_K, buildHybridSearchParams, buildVectorSearchParams, clampUnit } from './query-helpers.js';
import { cosineSimilarity } from '../vector-math.js';

export interface CandidateRow {
  id: string;
  content: string;
  importance: number;
  similarity: number;
}

export async function searchVectors(
  pool: pg.Pool,
  userId: string,
  queryEmbedding: number[],
  limit: number,
  sourceSite?: string,
  referenceTime?: Date,
  sessionId?: string,
): Promise<SearchResult[]> {
  if (config.vectorBackend === 'pgvector') {
    return searchVectorsPg(pool, userId, queryEmbedding, limit, sourceSite, referenceTime, sessionId);
  }
  if (config.vectorBackend === 'ruvector-mock') {
    return searchVectorsRuvectorMock(pool, userId, queryEmbedding, limit, sourceSite, referenceTime, sessionId);
  }
  return searchVectorsZvecMock(pool, userId, queryEmbedding, limit, sourceSite, referenceTime, sessionId);
}

/**
 * Hybrid search using Reciprocal Rank Fusion (RRF) to combine vector similarity
 * with PostgreSQL full-text search. Improves retrieval for keyword-heavy queries
 * (names, dates, project names) where semantic similarity alone fails.
 *
 * Source: 2026-03-07 RAG deep dive (SeekDB link 6, GraphRAG guide link 1).
 */
export async function searchHybrid(
  pool: pg.Pool,
  userId: string,
  queryText: string,
  queryEmbedding: number[],
  limit: number,
  sourceSite?: string,
  referenceTime?: Date,
  sessionId?: string,
): Promise<SearchResult[]> {
  if (config.vectorBackend !== 'pgvector') {
    return searchVectors(pool, userId, queryEmbedding, limit, sourceSite, referenceTime, sessionId);
  }
  return searchHybridPg(pool, userId, queryText, queryEmbedding, limit, sourceSite, referenceTime, sessionId);
}

export async function searchKeyword(
  pool: pg.Pool,
  userId: string,
  queryText: string,
  limit: number,
  sourceSite?: string,
  sessionId?: string,
): Promise<SearchResult[]> {
  if (config.vectorBackend !== 'pgvector') {
    return [];
  }
  return searchKeywordPg(pool, userId, queryText, limit, sourceSite, sessionId);
}

export async function findDuplicateVectors(
  pool: pg.Pool,
  userId: string,
  embedding: number[],
  threshold: number,
  limit: number,
): Promise<CandidateRow[]> {
  if (config.vectorBackend === 'pgvector') {
    return findDuplicateVectorsPg(pool, userId, embedding, threshold, limit);
  }
  if (config.vectorBackend === 'ruvector-mock') {
    return findDuplicateVectorsRuvectorMock(pool, userId, embedding, threshold, limit);
  }
  return findDuplicateVectorsZvecMock(pool, userId, embedding, threshold, limit);
}

/**
 * Workspace-scoped vector search. Filters by workspace_id and optionally
 * by agent_id based on AgentScope. Enforces visibility rules when a
 * callerAgentId is provided.
 */
export async function searchVectorsInWorkspace(
  pool: pg.Pool,
  workspaceId: string,
  queryEmbedding: number[],
  limit: number,
  agentScope: AgentScope = 'all',
  callerAgentId?: string,
  referenceTime?: Date,
  sessionId?: string,
): Promise<SearchResult[]> {
  const wSim = config.scoringWeightSimilarity;
  const wImp = config.scoringWeightImportance;
  const wRec = config.scoringWeightRecency;
  const rankingMinSimilarity = clampUnit(config.retrievalProfileSettings.rankingMinSimilarity);
  const refTime = (referenceTime ?? new Date()).toISOString();

  const params: unknown[] = [
    pgvector.toSql(queryEmbedding), workspaceId, normalizeLimit(limit),
    wSim, wImp, wRec, refTime, rankingMinSimilarity,
  ];
  let nextParam = 9;

  const agentClause = buildAgentScopeClause(agentScope, callerAgentId, params, nextParam);
  nextParam += agentClause.paramsAdded;

  const visibilityClause = buildVisibilityClauseForSearch(callerAgentId, params, nextParam);
  let sessionClause = '';
  if (sessionId) {
    params.push(sessionId);
    sessionClause = `AND episodes.session_id = $${params.length}`;
  }

  const result = await pool.query(
    `SELECT memories.*, episodes.session_id,
       1 - (memories.embedding <=> $1) AS similarity,
       1 - (memories.embedding <=> $1) AS semantic_similarity,
       GREATEST(0, LEAST(1, 1 - (memories.embedding <=> $1))) AS relevance,
       (
         $4 * (1 - (memories.embedding <=> $1))
         + $5 * memories.importance
         + $6 * EXP(-EXTRACT(EPOCH FROM ($7::timestamptz - memories.last_accessed_at)) / 2592000.0)
       ) * COALESCE(memories.trust_score, 1.0) AS score,
       (
         $4 * (1 - (memories.embedding <=> $1))
         + CASE WHEN (1 - (memories.embedding <=> $1)) >= $8 THEN (
           $5 * memories.importance
           + $6 * EXP(-EXTRACT(EPOCH FROM ($7::timestamptz - memories.last_accessed_at)) / 2592000.0)
         ) ELSE 0 END
       ) * COALESCE(memories.trust_score, 1.0) AS ranking_score
     FROM memories
     LEFT JOIN episodes
       ON episodes.id = memories.episode_id
      AND episodes.user_id = memories.user_id
     WHERE memories.workspace_id = $2
       AND memories.deleted_at IS NULL
       AND memories.expired_at IS NULL
       AND memories.status = 'active'
       ${agentClause.sql}
       ${visibilityClause.sql}
       ${sessionClause}
     ORDER BY ranking_score DESC
     LIMIT $3`,
    params,
  );
  return result.rows.map(normalizeSearchRow);
}

/**
 * Find near-duplicate memories within a workspace scope.
 * Used during workspace-scoped ingest for AUDN conflict detection.
 */
export async function findDuplicateVectorsInWorkspace(
  pool: pg.Pool,
  workspaceId: string,
  embedding: number[],
  threshold: number,
  limit: number,
  agentScope: AgentScope = 'all',
  callerAgentId?: string,
): Promise<CandidateRow[]> {
  const params: unknown[] = [pgvector.toSql(embedding), workspaceId, threshold, limit];
  let nextParam = 5;

  const agentClause = buildAgentScopeClause(agentScope, callerAgentId, params, nextParam);

  const result = await pool.query(
    `SELECT id, content, importance, agent_id,
            1 - (embedding <=> $1) AS similarity
     FROM memories
     WHERE workspace_id = $2
       AND deleted_at IS NULL
       AND expired_at IS NULL
       AND status = 'active'
       AND 1 - (embedding <=> $1) > $3
       ${agentClause.sql}
     ORDER BY similarity DESC
     LIMIT $4`,
    params,
  );
  return result.rows as CandidateRow[];
}

/**
 * Resolve an AgentScope into a SQL WHERE clause fragment.
 * Returns the SQL string and the count of parameters added.
 */
function buildAgentScopeClause(
  scope: AgentScope,
  callerAgentId: string | undefined,
  params: unknown[],
  nextParam: number,
): { sql: string; paramsAdded: number } {
  if (scope === 'all') return { sql: '', paramsAdded: 0 };

  if (scope === 'others') {
    if (!callerAgentId) return { sql: '', paramsAdded: 0 };
    params.push(callerAgentId);
    return { sql: `AND (memories.agent_id IS NULL OR memories.agent_id != $${nextParam})`, paramsAdded: 1 };
  }

  if (Array.isArray(scope) && scope.length > 0) {
    params.push(scope);
    return { sql: `AND memories.agent_id = ANY($${nextParam}::uuid[])`, paramsAdded: 1 };
  }

  const targetId = scope === 'self' ? callerAgentId : scope;
  if (!targetId) return { sql: '', paramsAdded: 0 };
  params.push(targetId);
  return { sql: `AND memories.agent_id = $${nextParam}`, paramsAdded: 1 };
}

/**
 * Build visibility enforcement clause for workspace search.
 * Ensures agents can only see memories they have access to.
 */
function buildVisibilityClauseForSearch(
  callerAgentId: string | undefined,
  params: unknown[],
  nextParam: number,
): { sql: string; paramsAdded: number } {
  if (!callerAgentId) return { sql: '', paramsAdded: 0 };
  params.push(callerAgentId);
  return {
    sql: `AND (
      memories.visibility = 'workspace'
      OR memories.visibility IS NULL
      OR (memories.visibility = 'agent_only' AND memories.agent_id = $${nextParam})
      OR (memories.visibility = 'restricted' AND (
        memories.agent_id = $${nextParam}
        OR EXISTS (
          SELECT 1 FROM memory_visibility_grants g
          WHERE g.memory_id = memories.id AND g.grantee_agent_id = $${nextParam}
        )
      ))
    )`,
    paramsAdded: 1,
  };
}

async function searchVectorsPg(
  pool: pg.Pool,
  userId: string,
  queryEmbedding: number[],
  limit: number,
  sourceSite?: string,
  referenceTime?: Date,
  sessionId?: string,
): Promise<SearchResult[]> {
  const { params, siteClause } = buildVectorSearchParams(queryEmbedding, userId, limit, sourceSite, referenceTime, sessionId);

  const result = await pool.query(
    `SELECT memories.*, episodes.session_id,
       1 - (memories.embedding <=> $1) AS similarity,
       1 - (memories.embedding <=> $1) AS semantic_similarity,
       GREATEST(0, LEAST(1, 1 - (memories.embedding <=> $1))) AS relevance,
       (
         $4 * (1 - (memories.embedding <=> $1))
         + $5 * memories.importance
         + $6 * EXP(-EXTRACT(EPOCH FROM ($7::timestamptz - memories.last_accessed_at)) / 2592000.0)
       ) * COALESCE(memories.trust_score, 1.0) AS score,
       (
         $4 * (1 - (memories.embedding <=> $1))
         + CASE WHEN (1 - (memories.embedding <=> $1)) >= $8 THEN (
           $5 * memories.importance
           + $6 * EXP(-EXTRACT(EPOCH FROM ($7::timestamptz - memories.last_accessed_at)) / 2592000.0)
         ) ELSE 0 END
       ) * COALESCE(memories.trust_score, 1.0) AS ranking_score
     FROM memories
     LEFT JOIN episodes
       ON episodes.id = memories.episode_id
      AND episodes.user_id = memories.user_id
     WHERE memories.user_id = $2
       AND memories.deleted_at IS NULL
       AND memories.expired_at IS NULL
       AND memories.status = 'active'
       AND memories.workspace_id IS NULL
       ${siteClause}
     ORDER BY ranking_score DESC
     LIMIT $3`,
    params,
  );
  return result.rows.map(normalizeSearchRow);
}

async function findDuplicateVectorsPg(
  pool: pg.Pool,
  userId: string,
  embedding: number[],
  threshold: number,
  limit: number,
): Promise<CandidateRow[]> {
  const result = await pool.query(
    `SELECT id, content, importance, 1 - (embedding <=> $1) AS similarity
     FROM memories
     WHERE user_id = $2
       AND deleted_at IS NULL
       AND expired_at IS NULL
       AND status = 'active'
       AND workspace_id IS NULL
       AND 1 - (embedding <=> $1) > $3
     ORDER BY similarity DESC
     LIMIT $4`,
    [pgvector.toSql(embedding), userId, threshold, limit],
  );
  return result.rows as CandidateRow[];
}

async function searchKeywordPg(
  pool: pg.Pool,
  userId: string,
  queryText: string,
  limit: number,
  sourceSite?: string,
  sessionId?: string,
): Promise<SearchResult[]> {
  const params: unknown[] = [userId, queryText, normalizeLimit(limit)];
  const filters: string[] = [];
  if (sourceSite) params.push(sourceSite);
  if (sourceSite) filters.push(`AND memories.source_site = $${params.length}`);
  if (sessionId) {
    params.push(sessionId);
    filters.push(`AND EXISTS (
      SELECT 1 FROM episodes e
      WHERE e.id = memories.episode_id
        AND e.user_id = memories.user_id
        AND e.session_id = $${params.length}
    )`);
  }
  const siteFilter = filters.join('\n       ');

  const result = await pool.query(
    `SELECT memories.*, episodes.session_id,
       LEAST(ts_rank(memories.search_vector, plainto_tsquery('english', $2)), 1.0) AS similarity,
       LEAST(ts_rank(memories.search_vector, plainto_tsquery('english', $2)), 1.0) AS semantic_similarity,
       LEAST(ts_rank(memories.search_vector, plainto_tsquery('english', $2)), 1.0) AS relevance,
       ts_rank(memories.search_vector, plainto_tsquery('english', $2)) AS score,
       ts_rank(memories.search_vector, plainto_tsquery('english', $2)) AS ranking_score
     FROM memories
     LEFT JOIN episodes
       ON episodes.id = memories.episode_id
      AND episodes.user_id = memories.user_id
     WHERE memories.user_id = $1
       AND memories.deleted_at IS NULL
       AND memories.expired_at IS NULL
       AND memories.status = 'active'
       AND memories.workspace_id IS NULL
       ${siteFilter}
       AND memories.search_vector @@ plainto_tsquery('english', $2)
     ORDER BY ts_rank(memories.search_vector, plainto_tsquery('english', $2)) DESC, memories.importance DESC
     LIMIT $3`,
    params,
  );
  return result.rows.map(normalizeSearchRow);
}

async function searchHybridPg(
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
    queryEmbedding, userId, queryText, limit, 'memories.source_site', sourceSite, referenceTime, sessionId, 'memories.episode_id',
  );

  const result = await pool.query(
    `WITH vector_ranked AS (
       SELECT id, ROW_NUMBER() OVER (ORDER BY embedding <=> $1) AS vrank
       FROM memories
       WHERE user_id = $2 AND deleted_at IS NULL AND expired_at IS NULL AND status = 'active' AND workspace_id IS NULL ${siteFilter}
       ORDER BY embedding <=> $1
       LIMIT $4 * 4
     ),
     fts_ranked AS (
       SELECT id, ROW_NUMBER() OVER (ORDER BY ts_rank(search_vector, plainto_tsquery('english', $3)) DESC) AS ftsrank
       FROM memories
       WHERE user_id = $2 AND deleted_at IS NULL AND expired_at IS NULL AND status = 'active' AND workspace_id IS NULL ${siteFilter}
         AND search_vector @@ plainto_tsquery('english', $3)
       ORDER BY ts_rank(search_vector, plainto_tsquery('english', $3)) DESC
       LIMIT $4 * 4
     ),
     fused AS (
       SELECT COALESCE(v.id, f.id) AS id,
         COALESCE(1.0 / (${RRF_K} + v.vrank), 0) + COALESCE(1.0 / (${RRF_K} + f.ftsrank), 0) AS rrf_score
       FROM vector_ranked v
       FULL OUTER JOIN fts_ranked f ON v.id = f.id
     )
     SELECT m.*, episodes.session_id,
       1 - (m.embedding <=> $1) AS similarity,
       1 - (m.embedding <=> $1) AS semantic_similarity,
       GREATEST(0, LEAST(1, 1 - (m.embedding <=> $1))) AS relevance,
       (
         $5 * (1 - (m.embedding <=> $1))
         + $6 * m.importance
         + $7 * EXP(-EXTRACT(EPOCH FROM ($8::timestamptz - m.last_accessed_at)) / 2592000.0)
         + ${config.retrievalProfileSettings.lexicalWeight} * f.rrf_score
       ) * COALESCE(m.trust_score, 1.0) AS score,
       (
         $5 * (1 - (m.embedding <=> $1))
         + CASE WHEN (1 - (m.embedding <=> $1)) >= $9 THEN (
           $6 * m.importance
           + $7 * EXP(-EXTRACT(EPOCH FROM ($8::timestamptz - m.last_accessed_at)) / 2592000.0)
         ) ELSE 0 END
         -- Lexical RRF stays outside the semantic boost gate because exact text match is itself a relevance signal.
         + ${config.retrievalProfileSettings.lexicalWeight} * f.rrf_score
       ) * COALESCE(m.trust_score, 1.0) AS ranking_score
     FROM fused f
     JOIN memories m ON m.id = f.id
     LEFT JOIN episodes
       ON episodes.id = m.episode_id
      AND episodes.user_id = m.user_id
     ORDER BY ranking_score DESC
     LIMIT $4`,
    params,
  );
  return result.rows.map(normalizeSearchRow);
}

async function searchVectorsRuvectorMock(
  pool: pg.Pool, userId: string, queryEmbedding: number[], limit: number,
  sourceSite?: string, referenceTime?: Date, sessionId?: string,
): Promise<SearchResult[]> {
  const memories = await loadActiveMemories(pool, userId, sourceSite, sessionId);
  return rankAndSortMemories(memories, queryEmbedding, limit, referenceTime);
}

async function findDuplicateVectorsRuvectorMock(
  pool: pg.Pool, userId: string, embedding: number[], threshold: number, limit: number,
): Promise<CandidateRow[]> {
  const memories = await loadActiveMemories(pool, userId);
  return findDuplicatesInMemoryList(memories, embedding, threshold, limit);
}

async function searchVectorsZvecMock(
  pool: pg.Pool, userId: string, queryEmbedding: number[], limit: number,
  sourceSite?: string, referenceTime?: Date, sessionId?: string,
): Promise<SearchResult[]> {
  const memories = await loadActiveMemories(pool, userId, sourceSite, sessionId);
  const shortlist = buildApproximateShortlist(memories, queryEmbedding, limit);
  return rankAndSortMemories(shortlist, queryEmbedding, limit, referenceTime);
}

async function findDuplicateVectorsZvecMock(
  pool: pg.Pool, userId: string, embedding: number[], threshold: number, limit: number,
): Promise<CandidateRow[]> {
  const memories = await loadActiveMemories(pool, userId);
  const shortlist = buildApproximateShortlist(memories, embedding, limit * 8);
  return findDuplicatesInMemoryList(shortlist, embedding, threshold, limit);
}

/** Shared in-memory duplicate detection for mock backends. */
function findDuplicatesInMemoryList(
  memories: MemoryRow[], embedding: number[], threshold: number, limit: number,
): CandidateRow[] {
  return memories
    .map((memory) => buildCandidate(memory, embedding))
    .filter((candidate) => candidate.similarity > threshold)
    .sort((left, right) => right.similarity - left.similarity)
    .slice(0, normalizeLimit(limit));
}

/** Shared rank-and-sort for mock vector search backends. */
function rankAndSortMemories(
  memories: MemoryRow[], queryEmbedding: number[], limit: number, referenceTime?: Date,
): SearchResult[] {
  return memories
    .map((memory) => rankMemory(memory, queryEmbedding, referenceTime))
    .sort((left, right) => (right.ranking_score ?? right.score) - (left.ranking_score ?? left.score))
    .slice(0, normalizeLimit(limit));
}

async function loadActiveMemories(pool: pg.Pool, userId: string, sourceSite?: string, sessionId?: string): Promise<MemoryRow[]> {
  const params: unknown[] = [userId];
  const filters: string[] = [];
  if (sourceSite) {
    params.push(sourceSite);
    filters.push(`AND memories.source_site = $${params.length}`);
  }
  if (sessionId) {
    params.push(sessionId);
    filters.push(`AND EXISTS (
      SELECT 1 FROM episodes e
      WHERE e.id = memories.episode_id
        AND e.user_id = memories.user_id
        AND e.session_id = $${params.length}
    )`);
  }
  const result = await pool.query(
    `SELECT memories.*, episodes.session_id
     FROM memories
     LEFT JOIN episodes
       ON episodes.id = memories.episode_id
      AND episodes.user_id = memories.user_id
     WHERE memories.user_id = $1
       AND memories.deleted_at IS NULL
       AND memories.expired_at IS NULL
       AND memories.status = 'active'
       AND memories.workspace_id IS NULL
       ${filters.join('\n       ')}`,
    params,
  );
  return result.rows.map(normalizeMemoryRow);
}

function rankMemory(memory: MemoryRow, queryEmbedding: number[], referenceTime?: Date): SearchResult {
  const similarity = cosineSimilarity(queryEmbedding, memory.embedding);
  const rawScore = computeScore(similarity, memory.importance, memory.last_accessed_at, referenceTime, false);
  const score = rawScore * (memory.trust_score ?? 1.0);
  const rawRankingScore = computeScore(similarity, memory.importance, memory.last_accessed_at, referenceTime, true);
  const rankingScore = rawRankingScore * (memory.trust_score ?? 1.0);
  return {
    ...memory,
    similarity,
    score,
    semantic_similarity: similarity,
    ranking_score: rankingScore,
    relevance: clampUnit(similarity),
  };
}

function buildCandidate(memory: MemoryRow, queryEmbedding: number[]): CandidateRow {
  return {
    id: memory.id,
    content: memory.content,
    importance: memory.importance,
    similarity: cosineSimilarity(queryEmbedding, memory.embedding),
  };
}

function buildApproximateShortlist(memories: MemoryRow[], queryEmbedding: number[], limit: number): MemoryRow[] {
  const candidatePool = Math.max(normalizeLimit(limit) * 6, 24);
  return memories
    .map((memory) => ({
      memory,
      similarity: approximateCosineSimilarity(queryEmbedding, memory.embedding),
    }))
    .sort((left, right) => right.similarity - left.similarity)
    .slice(0, candidatePool)
    .map((entry) => entry.memory);
}

function computeScore(
  similarity: number,
  importance: number,
  lastAccessedAt: Date,
  referenceTime: Date | undefined,
  applyRankingFloor: boolean,
): number {
  const refMs = referenceTime ? referenceTime.getTime() : Date.now();
  const secondsSinceAccess = (refMs - lastAccessedAt.getTime()) / 1000;
  const recency = Math.exp(-secondsSinceAccess / 2592000.0);
  const canUseNonSemanticScore = !applyRankingFloor
    || similarity >= clampUnit(config.retrievalProfileSettings.rankingMinSimilarity);
  const nonSemanticScore = canUseNonSemanticScore
    ? (config.scoringWeightImportance * importance) + (config.scoringWeightRecency * recency)
    : 0;
  return (config.scoringWeightSimilarity * similarity) + nonSemanticScore;
}

function approximateCosineSimilarity(left: number[], right: number[]): number {
  return cosineSimilarity(projectEmbedding(left), projectEmbedding(right));
}

function projectEmbedding(values: number[]): number[] {
  const projected: number[] = [];
  for (let index = 0; index < values.length; index += 6) {
    projected.push(values[index]);
  }
  return projected;
}

function normalizeLimit(limit: number): number {
  return Math.max(1, Math.min(100, limit));
}
