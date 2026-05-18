/**
 * Present-state reranking for queries asking what is true now.
 *
 * Detects implicit current-state queries ("What database does the project use?")
 * and applies recency-based boosting so newer facts outrank older superseded ones.
 *
 * Key signals:
 *   - Recency rank: newer results get higher boost
 *   - Transition detection: facts describing state changes ("migrated to X",
 *     "switched to Y") get a bonus — they establish current state
 *   - Historical-only penalty: facts about old state without transition markers
 *     ("uses Angular 15") get no boost
 */

import type { SearchResult } from '../db/memory-repository.js';

const CURRENT_QUERY_MARKERS = [' now', ' current ', ' currently', ' right now', ' at the moment', ' latest '];
const HISTORICAL_QUERY_MARKERS = ['used to', 'previously', 'former', 'old ', 'history', 'timeline', 'before switching', 'before migrating', 'before moving', 'earlier '];
const CURRENT_QUERY_STARTERS = [' what ', ' where ', ' who '];
const CURRENT_DOMAIN_MARKERS = [
  ' use', ' using', ' backend', ' system', ' engine', ' framework',
  ' database', ' employer', ' work', ' live', ' salary', ' library',
  ' orm', ' stack', ' tool',
];

/**
 * Quantity/frequency/duration starters that implicitly ask about the latest value.
 * "How many X do I have?" → current count. "How often do I X?" → current frequency.
 * These bypass the domain-marker requirement because the question structure
 * itself implies current-state intent.
 */
const QUANTITY_STARTERS = ['how many ', 'how often ', 'how long ', 'how much '];
const TEMPORAL_COMPARISON_MARKERS = [
  ' between ', ' first ', ' second ', ' before ', ' after ',
  ' elapsed ', ' lapsed ', ' passed ',
];

/**
 * Markers in result content indicating the fact describes current state.
 * "uses X" or "is using X" → this is what's true now.
 */
const CURRENT_RESULT_MARKERS = [
  'current ', 'currently ', ' now ', 'uses ', 'is using ',
  'started at', 'started working', 'new package', 'new company',
  'just moved', 'moved to', 'renting',
];

/**
 * Transition markers — facts that describe a change FROM old state TO new state.
 * These establish current state and should be boosted, not penalized.
 * Pattern: "migrated from X to Y", "switched to Y", "completed migration"
 */
const TRANSITION_MARKERS = [
  'switched to', 'migrated to', 'migration to', 'completed migration',
  'completed the migration', 'moved from', 'changed to', 'upgraded to',
  'transitioned to', 'replaced with', 'rewritten', 'left ',
  'all data has been migrated', 'migration is complete',
  'have been rewritten', 'instead of',
  'correction:', 'correction ',
];

/**
 * Markers indicating purely historical content without transition context.
 * Only applied when the fact does NOT also contain a transition marker.
 */
const HISTORICAL_ONLY_MARKERS = [
  'previously ', 'used to ', 'former ', 'at that time',
  'earlier ', 'was an earlier', 'an earlier ',
];

const RECENCY_BONUS = 2.5;
const CURRENT_TEXT_BONUS = 0.45;
const TRANSITION_BONUS = 1.5;
const HISTORICAL_ONLY_PENALTY = 0.6;

export interface CurrentStateRankingResult {
  triggered: boolean;
  results: SearchResult[];
}

export function applyCurrentStateRanking(query: string, results: SearchResult[]): CurrentStateRankingResult {
  if (results.length === 0) return { triggered: false, results };

  if (isHistoricalQuery(query)) {
    return applyHistoricalRanking(results);
  }

  if (!isCurrentStateQuery(query)) {
    return { triggered: false, results };
  }

  const rankMap = buildRecencyRankMap(results);
  const rescored = results
    .map((result) => ({ ...result, score: result.score + computeBoost(result, rankMap, results.length) }))
    .sort((left, right) => right.score - left.score);

  return { triggered: true, results: rescored };
}

const HISTORICAL_OLDNESS_BONUS = 1.5;
const HISTORICAL_TRANSITION_PENALTY = 1.2;

/**
 * Historical query ranking — inverse of current-state ranking.
 * Boosts older results and penalizes transition/current-state content.
 */
function applyHistoricalRanking(results: SearchResult[]): CurrentStateRankingResult {
  const rankMap = buildRecencyRankMap(results);
  const total = results.length;

  const rescored = results
    .map((result) => {
      const recencyRank = rankMap.get(result.id) ?? total - 1;
      const oldnessBoost = HISTORICAL_OLDNESS_BONUS * (recencyRank / total);
      const transitionPenalty = hasTransitionMarker(result.content) ? HISTORICAL_TRANSITION_PENALTY : 0;
      const currentPenalty = hasCurrentMarker(result.content) ? CURRENT_TEXT_BONUS : 0;
      const historicalBoost = hasHistoricalOnlyMarker(result.content) ? HISTORICAL_ONLY_PENALTY : 0;
      return { ...result, score: result.score + oldnessBoost + historicalBoost - transitionPenalty - currentPenalty };
    })
    .sort((left, right) => right.score - left.score);

  return { triggered: true, results: rescored };
}

export function isHistoricalQuery(query: string): boolean {
  const padded = ` ${query.toLowerCase()} `;
  return HISTORICAL_QUERY_MARKERS.some((marker) => padded.includes(marker));
}

export function isCurrentStateQuery(query: string): boolean {
  const padded = ` ${query.toLowerCase()} `;
  if (HISTORICAL_QUERY_MARKERS.some((marker) => padded.includes(marker))) return false;
  if (CURRENT_QUERY_MARKERS.some((marker) => padded.includes(marker))) return true;
  if (QUANTITY_STARTERS.some((starter) => padded.trimStart().startsWith(starter))) {
    const isTemporalComparison = TEMPORAL_COMPARISON_MARKERS.some((marker) => padded.includes(marker));
    return !isTemporalComparison;
  }
  const startsWithQuestionWord = CURRENT_QUERY_STARTERS.some((starter) => padded.startsWith(starter));
  return startsWithQuestionWord && CURRENT_DOMAIN_MARKERS.some((marker) => padded.includes(marker));
}

/** Build a map from memory id to its recency rank (0 = most recent). */
function buildRecencyRankMap(results: SearchResult[]): Map<string, number> {
  const recencyOrder = [...results]
    .map((result) => result.id)
    .sort((left, right) => compareRecency(results, left, right));
  return new Map(recencyOrder.map((id, index) => [id, index]));
}

function compareRecency(results: SearchResult[], leftId: string, rightId: string): number {
  const left = results.find((result) => result.id === leftId)!;
  const right = results.find((result) => result.id === rightId)!;
  return right.created_at.getTime() - left.created_at.getTime();
}

function computeBoost(result: SearchResult, rankMap: Map<string, number>, total: number): number {
  const recencyRank = rankMap.get(result.id) ?? total - 1;
  const recencyBoost = RECENCY_BONUS * ((total - recencyRank) / total);

  const isTransition = hasTransitionMarker(result.content);
  const transitionBoost = isTransition ? TRANSITION_BONUS : 0;
  const textBoost = hasCurrentMarker(result.content) ? CURRENT_TEXT_BONUS : 0;
  const historicalPenalty = !isTransition && hasHistoricalOnlyMarker(result.content) ? HISTORICAL_ONLY_PENALTY : 0;

  return recencyBoost + transitionBoost + textBoost - historicalPenalty;
}

function hasCurrentMarker(text: string): boolean {
  const lower = text.toLowerCase();
  return CURRENT_RESULT_MARKERS.some((marker) => lower.includes(marker));
}

function hasTransitionMarker(text: string): boolean {
  const lower = text.toLowerCase();
  return TRANSITION_MARKERS.some((marker) => lower.includes(marker));
}

function hasHistoricalOnlyMarker(text: string): boolean {
  const lower = text.toLowerCase();
  return HISTORICAL_ONLY_MARKERS.some((marker) => lower.includes(marker));
}
