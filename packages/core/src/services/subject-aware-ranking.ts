/**
 * Subject-aware reranking for person-specific questions.
 * Boosts memories that explicitly mention the requested subject and downweights
 * memories that mention a conflicting person name.
 */

import type { SearchResult } from '../db/repository-types.js';
import type { SearchStore } from '../db/stores.js';
import { buildTemporalFingerprint } from './temporal-fingerprint.js';
import { fetchAndBoostKeywordCandidates } from './keyword-expansion.js';
import { countKeywordMatches, normalizeKeywordToken } from './query-keyword-matches.js';

const MONTH_NAMES = new Set([
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]);
const NON_SUBJECT_TOKENS = new Set(['As', 'User']);
const QUERY_STOP_WORDS = new Set([
  'When', 'What', 'Where', 'Why', 'How', 'Who', 'Which',
  'Did', 'Does', 'Do', 'Has', 'Have', 'Had',
]);
const KEYWORD_STOP_WORDS = new Set([
  'when', 'what', 'where', 'why', 'how', 'who', 'which',
  'did', 'does', 'do', 'has', 'have', 'had',
  'her', 'his', 'their', 'the', 'a', 'an', 'at', 'in', 'on', 'to',
  'and', 'between', 'first', 'second', 'many', 'much', 'months', 'month',
  'weeks', 'week', 'years', 'year', 'days', 'day', 'lapsed', 'elapsed',
  'passed', 'before', 'after',
]);
const SUBJECT_MATCH_BONUS = 2;
const EXTRA_SUBJECT_MATCH_BONUS = 0.75;
const CONFLICT_SUBJECT_PENALTY = 0.25;
const KEYWORD_MATCH_BONUS = 0.4;
const SUBJECT_QUERY_LIMIT = 8;
const TEMPORAL_PLANNING_PENALTY = 2.25;
const TEMPORAL_EVENT_QUERY =
  /\b(when|how long|how many months|how many years|how many weeks|how many days|between|first|second|before|after)\b/i;
const PLANNING_MARKERS = [
  'plan to', 'planned to', 'planning to', 'going to', 'will ', 'wants to',
  'want to', 'thinking of', 'thinking about', 'considering', 'decided to make',
  'make a new appointment', 'book a new appointment',
];

export interface SubjectRankingResult {
  subjects: string[];
  keywords: string[];
  protectedFingerprints: string[];
  results: SearchResult[];
}

export function applySubjectAwareRanking(query: string, results: SearchResult[]): SubjectRankingResult {
  const subjects = extractQuerySubjects(query);
  const keywords = extractQueryKeywords(query, subjects);
  if (subjects.length === 0 && keywords.length === 0) {
    return { subjects: [], keywords: [], protectedFingerprints: [], results };
  }
  const temporalEventQuery = TEMPORAL_EVENT_QUERY.test(query.toLowerCase());

  const scoredResults = results
    .map((result) => scoreSubjectCandidate(result, subjects, keywords, temporalEventQuery))
    .sort((left, right) => right.result.score - left.result.score);

  return {
    subjects,
    keywords,
    protectedFingerprints: buildProtectedFingerprints(scoredResults),
    results: scoredResults.map((item) => item.result),
  };
}

export function extractSubjectQueryAnchors(query: string): string[] {
  const subjects = extractQuerySubjects(query);
  const keywords = extractQueryKeywords(query, subjects);
  return [...subjects, ...keywords].slice(0, SUBJECT_QUERY_LIMIT);
}

export async function expandSubjectQuery(
  repo: SearchStore,
  userId: string,
  query: string,
  queryEmbedding: number[],
  excludeIds: Set<string>,
  limit: number,
): Promise<{ memories: SearchResult[]; anchors: string[] }> {
  const anchors = extractSubjectQueryAnchors(query);
  if (anchors.length === 0) return { memories: [], anchors: [] };

  const boosted = await fetchAndBoostKeywordCandidates(
    repo, userId, anchors, queryEmbedding, excludeIds, limit, KEYWORD_MATCH_BONUS,
  );
  return { memories: boosted, anchors };
}

interface ScoredSubjectCandidate {
  result: SearchResult;
  hasRequestedSubject: boolean;
  keywordMatches: number;
}

function scoreSubjectCandidate(
  result: SearchResult,
  subjects: string[],
  keywords: string[],
  temporalEventQuery: boolean,
): ScoredSubjectCandidate {
  const mentionedSubjects = extractMentionedSubjects(result.content);
  const requestedSubjectMatches = subjects.filter((subject) => mentionedSubjects.includes(subject)).length;
  const hasRequestedSubject = requestedSubjectMatches > 0;
  const hasConflictingSubject = mentionedSubjects.some((subject) => !subjects.includes(subject));
  const keywordMatches = countKeywordMatches(result.content, keywords);
  const planningPenalty = shouldPenalizePlanning(result.content, temporalEventQuery)
    ? TEMPORAL_PLANNING_PENALTY
    : 0;
  let score = result.score;

  if (hasRequestedSubject) {
    score += SUBJECT_MATCH_BONUS + ((requestedSubjectMatches - 1) * EXTRA_SUBJECT_MATCH_BONUS);
  }
  if (hasConflictingSubject && !hasRequestedSubject) {
    score *= CONFLICT_SUBJECT_PENALTY;
  }
  if (keywordMatches > 0) {
    score += keywordMatches * KEYWORD_MATCH_BONUS;
  }
  score -= planningPenalty;

  return {
    result: score === result.score ? result : { ...result, score },
    hasRequestedSubject,
    keywordMatches,
  };
}

function extractQuerySubjects(query: string): string[] {
  return extractQueryCandidates(query)
    .filter((candidate) => isSubjectToken(candidate))
    .filter((candidate, index, all) => all.indexOf(candidate) === index);
}

function extractMentionedSubjects(content: string): string[] {
  const tokens = content.match(/\b[A-Z][a-z]+\b/g) ?? [];
  return tokens
    .filter((token) => isSubjectToken(token))
    .filter((token, index, all) => all.indexOf(token) === index);
}

function isSubjectToken(token: string): boolean {
  return !MONTH_NAMES.has(token) && !NON_SUBJECT_TOKENS.has(token) && !token.includes(' ');
}

function extractQueryKeywords(query: string, subjects: string[]): string[] {
  const subjectSet = new Set(subjects.map((subject) => subject.toLowerCase()));
  const tokens = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 2)
    .filter((token) => !KEYWORD_STOP_WORDS.has(token))
    .filter((token) => !subjectSet.has(token));
  const normalizedTokens = tokens
    .map(normalizeKeywordToken)
    .filter((token) => token.length > 2);
  return [...new Set([
    ...tokens,
    ...normalizedTokens,
    ...buildKeywordBigrams(tokens),
    ...buildKeywordBigrams(normalizedTokens),
  ])];
}

function extractQueryCandidates(query: string): string[] {
  const words = query.split(/\s+/).map((word) => word.replace(/[^A-Za-z]/g, ''));
  return words.filter((token, index) => {
    if (!token || QUERY_STOP_WORDS.has(token)) return false;
    if (!/^[A-Z][a-z]+$/.test(token)) return false;
    const previous = words[index - 1] ?? '';
    const next = words[index + 1] ?? '';
    const previousLooksNamed = /^[A-Z][a-z]+$/.test(previous) && !QUERY_STOP_WORDS.has(previous);
    const nextLooksNamed = /^[A-Z][a-z]+$/.test(next) && !QUERY_STOP_WORDS.has(next);
    const isPartOfTitleCasePhrase = previousLooksNamed || nextLooksNamed;
    return !isPartOfTitleCasePhrase;
  });
}

function buildProtectedFingerprints(scoredResults: ScoredSubjectCandidate[]): string[] {
  return scoredResults
    .filter((item) => item.hasRequestedSubject && item.keywordMatches > 0)
    .slice(0, 2)
    .map((item) => buildTemporalFingerprint(item.result.content));
}

function buildKeywordBigrams(tokens: string[]): string[] {
  const bigrams: string[] = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    if (bigrams.length >= 4) break;
    bigrams.push(`${tokens[i]} ${tokens[i + 1]}`);
  }
  return bigrams;
}

function shouldPenalizePlanning(content: string, temporalEventQuery: boolean): boolean {
  if (!temporalEventQuery) return false;
  const lower = content.toLowerCase();
  return PLANNING_MARKERS.some((marker) => lower.includes(marker));
}
