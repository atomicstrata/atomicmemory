/**
 * Shared query-building helpers for vector search and hybrid search backends.
 *
 * Centralizes scoring weight preparation, parameter setup, and site filtering
 * to eliminate duplication between repository-vector-search.ts and
 * repository-representations.ts.
 */

import pgvector from 'pgvector/pg';
import { config } from '../config.js';

export const RRF_K = 60;

export interface HybridQueryParams {
  /** Positional params array for pg.query. */
  params: unknown[];
  /** SQL clause fragment for optional source_site filter. Uses the alias prefix if provided. */
  siteFilter: string;
  /** ISO string for the reference timestamp. */
  refTime: string;
  /** Scoring weights from config. */
  wSim: number;
  wImp: number;
  wRec: number;
  rankingMinSimilarity: number;
}

/**
 * Build shared query parameters for a hybrid (vector + FTS) search.
 *
 * Returns an array of positional params, the site filter clause, and
 * scoring weights. The caller must set the first params in a known order:
 *   $1=embedding, $2=userId, $3=queryText, $4=limit, $5=wSim, $6=wImp, $7=wRec, $8=refTime, $9=rankingMinSimilarity, [$10=sourceSite]
 */
export function buildHybridSearchParams(
  queryEmbedding: number[],
  userId: string,
  queryText: string,
  limit: number,
  siteFilterColumn: string,
  sourceSite?: string,
  referenceTime?: Date,
  sessionId?: string,
  episodeIdColumn: string = 'episode_id',
): HybridQueryParams {
  const wSim = config.scoringWeightSimilarity;
  const wImp = config.scoringWeightImportance;
  const wRec = config.scoringWeightRecency;
  const rankingMinSimilarity = clampUnit(config.retrievalProfileSettings.rankingMinSimilarity);
  const refTime = (referenceTime ?? new Date()).toISOString();
  const params: unknown[] = [
    pgvector.toSql(queryEmbedding),
    userId,
    queryText,
    Math.max(1, limit),
    wSim, wImp, wRec, refTime, rankingMinSimilarity,
  ];
  const filters: string[] = [];
  if (sourceSite) {
    params.push(sourceSite);
    filters.push(`AND ${siteFilterColumn} = $${params.length}`);
  }
  if (sessionId) {
    params.push(sessionId);
    filters.push(`AND EXISTS (
      SELECT 1 FROM episodes e
      WHERE e.id = ${episodeIdColumn}
        AND e.user_id = $2
        AND e.session_id = $${params.length}
    )`);
  }
  const siteFilter = filters.join('\n       ');
  return { params, siteFilter, refTime, wSim, wImp, wRec, rankingMinSimilarity };
}

/**
 * Build shared query parameters for a vector-only scored search.
 *
 * Returns params in order: $1=embedding, $2=userId, $3=limit, $4=wSim, $5=wImp, $6=wRec, $7=refTime, $8=rankingMinSimilarity, [$9=sourceSite]
 */
export function buildVectorSearchParams(
  queryEmbedding: number[],
  userId: string,
  limit: number,
  sourceSite?: string,
  referenceTime?: Date,
  sessionId?: string,
): { params: unknown[]; siteClause: string; wSim: number; wImp: number; wRec: number; rankingMinSimilarity: number; refTime: string } {
  const wSim = config.scoringWeightSimilarity;
  const wImp = config.scoringWeightImportance;
  const wRec = config.scoringWeightRecency;
  const rankingMinSimilarity = clampUnit(config.retrievalProfileSettings.rankingMinSimilarity);
  const refTime = (referenceTime ?? new Date()).toISOString();
  const params: unknown[] = [
    pgvector.toSql(queryEmbedding), userId, Math.max(1, Math.min(100, limit)),
    wSim, wImp, wRec, refTime, rankingMinSimilarity,
  ];
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
        AND e.user_id = $2
        AND e.session_id = $${params.length}
    )`);
  }
  const siteClause = filters.join('\n       ');
  return { params, siteClause, wSim, wImp, wRec, rankingMinSimilarity, refTime };
}

export function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
