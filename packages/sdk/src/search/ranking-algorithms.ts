/**
 * @file Ranking Algorithms
 *
 * Result ranking algorithms with tie-breaking and score normalization.
 */

import { SearchError } from '../core/error-handling/';
import type { JsonValue } from './semantic-search/types';

interface RankedResult<T> {
  item: T;
  score: number;
  rank: number;
  normalizedScore?: number;
  metadata?: Record<string, JsonValue>;
}

interface RankingOptions {
  tieBreaker?:
    | 'index'
    | 'random'
    | 'metadata'
    | ((a: unknown, b: unknown) => number);
  normalizeScores?: boolean;
  minScore?: number;
  maxResults?: number;
  scoreWeights?: Record<string, number>;
  prng?: () => number; // optional deterministic RNG for 'random' tie-breaker
}

/**
 * Ranks results by similarity score with configurable tie-breaking
 */
export function rankBySimilarity<T>(
  results: Array<{
    item: T;
    score: number;
    metadata?: Record<string, JsonValue>;
  }>,
  options: RankingOptions = {}
): RankedResult<T>[] {
  if (!Array.isArray(results)) {
    throw new SearchError('Results must be an array', 'INVALID_INPUT');
  }

  if (results.length === 0) {
    return [];
  }

  const {
    tieBreaker = 'index',
    normalizeScores = false,
    minScore = 0,
    maxResults,
    prng,
  } = options;

  // Filter by minimum score
  const filteredResults = results.filter(result => result.score >= minScore);

  if (filteredResults.length === 0) {
    return [];
  }

  // Add original indices for tie-breaking
  const indexedResults = filteredResults.map((result, index) => ({
    ...result,
    originalIndex: index,
  }));

  // Sort by score (descending) with tie-breaking
  indexedResults.sort((a, b) => {
    const scoreDiff = b.score - a.score;

    if (Math.abs(scoreDiff) < 1e-10) {
      // Handle floating point precision
      return handleTieBreaking(a, b, tieBreaker, prng);
    }

    return scoreDiff;
  });

  // Limit results if specified
  if (maxResults && maxResults > 0) {
    indexedResults.splice(maxResults);
  }

  // Normalize scores if requested
  const scores = indexedResults.map(r => r.score);
  const normalizedScores = normalizeScores
    ? normalizeScoreArray(scores)
    : scores;

  // Create ranked results
  return indexedResults.map((result, index) => ({
    item: result.item,
    score: result.score,
    rank: index + 1,
    normalizedScore: normalizeScores ? normalizedScores[index] : undefined,
    metadata: {
      ...result.metadata,
      tieBreaker: getTieBreakerValue(result, tieBreaker),
      originalIndex: result.originalIndex,
    },
  }));
}

/**
 * Ranks results using multiple scoring criteria with weights
 */
function rankByWeightedScores<T = any>(
  results: Array<{
    item: T;
    scores: Record<string, number>;
    metadata?: any;
  }>,
  weights: Record<string, number>,
  options: RankingOptions = {}
): RankedResult<T>[] {
  if (!Array.isArray(results)) {
    throw new SearchError('Results must be an array', 'INVALID_INPUT');
  }

  if (!weights || Object.keys(weights).length === 0) {
    throw new SearchError('Weights must be provided', 'INVALID_INPUT');
  }

  // Calculate weighted scores
  const weightedResults = results.map((result, index) => {
    let weightedScore = 0;
    let totalWeight = 0;

    for (const [criterion, weight] of Object.entries(weights)) {
      if (criterion in result.scores) {
        weightedScore += result.scores[criterion] * weight;
        totalWeight += weight;
      }
    }

    return {
      item: result.item,
      score: totalWeight > 0 ? weightedScore / totalWeight : 0,
      metadata: {
        ...result.metadata,
        originalScores: result.scores,
        weights: weights,
        originalIndex: index,
      },
    };
  });

  return rankBySimilarity(weightedResults, options);
}

/**
 * Handles tie-breaking between results with equal scores
 */
function handleTieBreaking(
  a: { originalIndex?: number; metadata?: Record<string, JsonValue> },
  b: { originalIndex?: number; metadata?: Record<string, JsonValue> },
  tieBreaker: RankingOptions['tieBreaker'],
  prng?: () => number
): number {
  switch (tieBreaker) {
    case 'index':
      return (a.originalIndex || 0) - (b.originalIndex || 0);

    case 'random':
      // Deterministic RNG (if provided) otherwise Math.random
      return (prng ? prng() : Math.random()) - 0.5;

    case 'metadata':
      // Use metadata timestamp or other sortable field
      const aTime =
        typeof a.metadata?.timestamp === 'number' ? a.metadata.timestamp : 0;
      const bTime =
        typeof b.metadata?.timestamp === 'number' ? b.metadata.timestamp : 0;
      return bTime - aTime; // More recent first

    default:
      if (typeof tieBreaker === 'function') {
        return tieBreaker(a, b);
      }
      return 0;
  }
}

/**
 * Gets the tie-breaker value for metadata
 */
function getTieBreakerValue(
  result: any,
  tieBreaker: RankingOptions['tieBreaker']
): any {
  switch (tieBreaker) {
    case 'index':
      return result.originalIndex;
    case 'metadata':
      return result.metadata?.timestamp;
    case 'random':
      return Math.random();
    default:
      return null;
  }
}

/**
 * Normalizes an array of scores to 0-1 range
 */
function normalizeScoreArray(scores: number[]): number[] {
  if (scores.length === 0) return [];

  const minScore = Math.min(...scores);
  const maxScore = Math.max(...scores);
  const range = maxScore - minScore;

  if (range === 0) {
    return scores.map(() => 1); // All scores are equal
  }

  return scores.map(score => (score - minScore) / range);
}
