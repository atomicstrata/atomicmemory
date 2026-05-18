/**
 * Query-time temporal constraint ranking for explicit month/date questions.
 *
 * This is intentionally narrow: it only reacts when the user states a month
 * constraint in the query, then boosts/protects candidates whose content or
 * observation timestamp matches that month. It complements temporal ordering
 * expansion, which handles "before/after/when" phrasing.
 */

import type { SearchResult } from '../db/repository-types.js';
import { buildTemporalFingerprint } from './temporal-fingerprint.js';
import { countKeywordMatches } from './query-keyword-matches.js';

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
] as const;

const QUERY_STOP_WORDS = new Set([
  'what', 'when', 'where', 'which', 'who', 'whom', 'whose', 'why', 'how',
  'did', 'does', 'do', 'was', 'were', 'is', 'are', 'the', 'a', 'an', 'and',
  'or', 'to', 'of', 'in', 'for', 'on', 'with', 'about', 'user', 'their',
  'they', 'them', 'there', 'happen', 'happened', 'event', 'events',
]);

const MAX_PROTECTED_TEMPORAL_CONSTRAINTS = 3;

export interface TemporalConstraintRankingResult {
  constraints: string[];
  protectedFingerprints: string[];
  protectedIds: string[];
  results: SearchResult[];
}

interface TemporalQueryConstraint {
  monthIndex: number;
  monthName: string;
  year?: number;
}

interface ScoredTemporalCandidate {
  result: SearchResult;
  matched: boolean;
}

export function applyTemporalQueryConstraints(
  query: string,
  results: SearchResult[],
  boost: number,
): TemporalConstraintRankingResult {
  const constraints = extractTemporalConstraints(query);
  if (constraints.length === 0 || boost <= 0) {
    return emptyResult(results);
  }

  const keywords = extractQueryKeywords(query);
  const scored = results
    .map((result) => scoreTemporalCandidate(result, constraints, keywords, boost))
    .sort((left, right) => right.result.score - left.result.score);
  const protectedCandidates = scored.filter((item) => item.matched).slice(0, MAX_PROTECTED_TEMPORAL_CONSTRAINTS);

  return {
    constraints: constraints.map(formatConstraint),
    protectedFingerprints: protectedCandidates.map((item) => buildTemporalFingerprint(item.result.content)),
    protectedIds: protectedCandidates.map((item) => item.result.id),
    results: scored.map((item) => item.result),
  };
}

function extractTemporalConstraints(query: string): TemporalQueryConstraint[] {
  const lower = query.toLowerCase();
  const constraints: TemporalQueryConstraint[] = [];
  for (let index = 0; index < MONTHS.length; index++) {
    const monthName = MONTHS[index];
    const pattern = new RegExp(`\\b${monthName}\\b(?:\\s+(\\d{4}))?`, 'i');
    const match = lower.match(pattern);
    if (!match) continue;
    const year = match[1] ? parseInt(match[1], 10) : undefined;
    constraints.push({ monthIndex: index, monthName, year });
  }
  return constraints;
}

function scoreTemporalCandidate(
  result: SearchResult,
  constraints: TemporalQueryConstraint[],
  keywords: string[],
  boost: number,
): ScoredTemporalCandidate {
  if (!matchesAnyConstraint(result, constraints) || !hasKeywordSupport(result.content, keywords)) {
    return { result, matched: false };
  }

  const keywordBoost = countKeywordMatches(result.content, keywords) * 0.1;
  return {
    result: { ...result, score: result.score + boost + keywordBoost },
    matched: true,
  };
}

function matchesAnyConstraint(result: SearchResult, constraints: TemporalQueryConstraint[]): boolean {
  return constraints.some((constraint) => (
    contentMatchesConstraint(result.content, constraint)
    || dateMatchesConstraint(result.created_at, constraint)
    || dateMatchesConstraint(result.observed_at, constraint)
  ));
}

function contentMatchesConstraint(content: string, constraint: TemporalQueryConstraint): boolean {
  const lower = content.toLowerCase();
  if (!lower.includes(constraint.monthName)) return false;
  if (constraint.year === undefined) return true;
  return lower.includes(String(constraint.year));
}

function dateMatchesConstraint(date: Date, constraint: TemporalQueryConstraint): boolean {
  if (date.getUTCMonth() !== constraint.monthIndex) return false;
  if (constraint.year === undefined) return true;
  return date.getUTCFullYear() === constraint.year;
}

function hasKeywordSupport(content: string, keywords: string[]): boolean {
  if (keywords.length === 0) return true;
  const requiredMatches = Math.min(2, keywords.length);
  return countKeywordMatches(content, keywords) >= requiredMatches;
}

function extractQueryKeywords(query: string): string[] {
  const words = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2)
    .filter((word) => !QUERY_STOP_WORDS.has(word))
    .filter((word) => !MONTHS.includes(word as typeof MONTHS[number]))
    .filter((word) => !/^\d{4}$/.test(word));
  return [...new Set(words)];
}

function formatConstraint(constraint: TemporalQueryConstraint): string {
  return constraint.year === undefined
    ? constraint.monthName
    : `${constraint.monthName} ${constraint.year}`;
}

function emptyResult(results: SearchResult[]): TemporalConstraintRankingResult {
  return { constraints: [], protectedFingerprints: [], protectedIds: [], results };
}
