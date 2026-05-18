/**
 * Protect literal list-answer candidates from late-stage diversity selection.
 *
 * LoCoMo-style questions such as "What are Melanie's pets' names?" and
 * "What musical artists has Melanie seen?" often need short memories that
 * contain the exact named answer. These memories can be less semantically broad
 * than neighboring context, so MMR may drop them unless we mark high-signal
 * candidates as protected before final selection.
 */

import type { SearchResult } from '../db/repository-types.js';
import { buildTemporalFingerprint } from './temporal-fingerprint.js';
import { isLiteralDetailQuery } from './literal-query-expansion.js';

const MIN_SIGNAL_SCORE = 3;
const PROTECTED_SCORE_BONUS = 4;

const PET_TERMS = ['pet', 'pets', 'cat', 'cats', 'dog', 'dogs'];
const MUSIC_TERMS = ['artist', 'artists', 'band', 'bands', 'music', 'musical', 'concert', 'song', 'songs'];
const BOOK_TERMS = ['book', 'books', 'title', 'read', 'reading'];
const NAME_TERMS = ['name', 'names', 'called', 'named'];
const SEEN_EVENT_TERMS = ['seen', 'saw', 'attended', 'concert', 'show'];
const PERFORMANCE_TERMS = ['played', 'playing', 'dancing', 'singing', 'live', 'stage', 'show', 'concert'];
const ATTENDANCE_TERMS = ['attended', 'saw', 'seen', 'concert', 'show'];

export interface LiteralListProtectionResult {
  protectedFingerprints: string[];
  protectedIds: string[];
  reasons: string[];
  results: SearchResult[];
}

interface CandidateSignal {
  result: SearchResult;
  score: number;
  reasons: string[];
}

export function protectLiteralListAnswerCandidates(
  query: string,
  candidates: SearchResult[],
  maxProtected: number,
): LiteralListProtectionResult {
  if (maxProtected <= 0 || !isLiteralDetailQuery(query)) {
    return emptyProtection(candidates);
  }

  const intent = classifyListIntent(query);
  if (!intent.hasListIntent) {
    return emptyProtection(candidates);
  }

  const protectedCandidates = candidates
    .map((candidate) => scoreCandidate(candidate, intent))
    .filter((candidate) => candidate.score >= MIN_SIGNAL_SCORE)
    .sort((left, right) => right.score - left.score)
    .slice(0, maxProtected);

  return {
    protectedFingerprints: protectedCandidates.map((item) => buildTemporalFingerprint(item.result.content)),
    protectedIds: protectedCandidates.map((item) => item.result.id),
    reasons: [...new Set(protectedCandidates.flatMap((item) => item.reasons))],
    results: boostProtectedCandidates(candidates, protectedCandidates),
  };
}

interface ListIntent {
  hasListIntent: boolean;
  wantsNames: boolean;
  wantsPets: boolean;
  wantsMusic: boolean;
  wantsBooks: boolean;
  wantsSeenEvent: boolean;
}

function classifyListIntent(query: string): ListIntent {
  const lower = query.toLowerCase();
  return {
    hasListIntent: containsAny(lower, NAME_TERMS) || containsAny(lower, PET_TERMS)
      || containsAny(lower, MUSIC_TERMS) || containsAny(lower, BOOK_TERMS),
    wantsNames: containsAny(lower, NAME_TERMS),
    wantsPets: containsAny(lower, PET_TERMS),
    wantsMusic: containsAny(lower, MUSIC_TERMS),
    wantsBooks: containsAny(lower, BOOK_TERMS),
    wantsSeenEvent: containsAny(lower, SEEN_EVENT_TERMS),
  };
}

function scoreCandidate(result: SearchResult, intent: ListIntent): CandidateSignal {
  const content = result.content;
  const lower = content.toLowerCase();
  const hasQuoted = hasQuotedTitle(content);
  const hasLeadingQuote = hasLeadingQuotedTitle(content);
  const hasAttendance = containsAny(lower, ATTENDANCE_TERMS);
  const reasons: string[] = [];

  const score = scoreNamedEntity(content, intent, reasons)
    + scoreQuotedOrAttendance(intent, hasQuoted, hasLeadingQuote, hasAttendance, reasons)
    + scoreDomainTerms(lower, intent, reasons)
    + scorePerformanceEvent(lower, intent, hasLeadingQuote, reasons);

  return { result, score, reasons };
}

function scoreNamedEntity(content: string, intent: ListIntent, reasons: string[]): number {
  if (!(intent.wantsPets || intent.wantsNames)) return 0;
  if (!/\bnamed\s+[A-Z][A-Za-z'-]+/.test(content)) return 0;
  reasons.push('named-entity');
  return 3;
}

function scoreQuotedOrAttendance(
  intent: ListIntent,
  hasQuoted: boolean,
  hasLeadingQuote: boolean,
  hasAttendance: boolean,
  reasons: string[],
): number {
  const seenEventScore = scoreSeenMusicEvent(intent, hasLeadingQuote, hasAttendance, reasons);
  if (seenEventScore > 0) return seenEventScore;
  if ((intent.wantsMusic || intent.wantsBooks) && hasQuoted) {
    reasons.push('quoted-title');
    return 3;
  }
  return 0;
}

function scoreSeenMusicEvent(
  intent: ListIntent,
  hasLeadingQuote: boolean,
  hasAttendance: boolean,
  reasons: string[],
): number {
  if (!intent.wantsMusic || !intent.wantsSeenEvent) return 0;
  if (hasLeadingQuote) {
    reasons.push('quoted-title');
    return 4;
  }
  if (!hasAttendance) return 0;
  reasons.push('attendance-event');
  return 3;
}

function scoreDomainTerms(lower: string, intent: ListIntent, reasons: string[]): number {
  let score = 0;
  score += addSignal(intent.wantsPets && containsAny(lower, PET_TERMS), reasons, 'pet-domain', 1.5);
  score += addSignal(intent.wantsMusic && containsAny(lower, MUSIC_TERMS), reasons, 'music-domain', 1.5);
  score += addSignal(intent.wantsBooks && containsAny(lower, BOOK_TERMS), reasons, 'book-domain', 1.5);
  return score;
}

function scorePerformanceEvent(lower: string, intent: ListIntent, hasLeadingQuote: boolean, reasons: string[]): number {
  const hasPerformanceSignal = intent.wantsMusic && intent.wantsSeenEvent
    && hasLeadingQuote && containsAny(lower, PERFORMANCE_TERMS);
  return addSignal(hasPerformanceSignal, reasons, 'performance-event', 2.5);
}

function addSignal(enabled: boolean, reasons: string[], reason: string, score: number): number {
  if (!enabled) return 0;
  reasons.push(reason);
  return score;
}

function hasQuotedTitle(content: string): boolean {
  return /["'“‘][A-Z][^"'”’]{2,}["'”’]/.test(content);
}

function hasLeadingQuotedTitle(content: string): boolean {
  return /^\s*["'“‘][A-Z][^"'”’]{2,}["'”’]/.test(content);
}

function containsAny(content: string, terms: string[]): boolean {
  return terms.some((term) => new RegExp(`\\b${term}\\b`).test(content));
}

function boostProtectedCandidates(
  candidates: SearchResult[],
  protectedCandidates: CandidateSignal[],
): SearchResult[] {
  const protectedIds = new Set(protectedCandidates.map((item) => item.result.id));
  return candidates.map((candidate) => {
    if (!protectedIds.has(candidate.id)) {
      return candidate;
    }
    return { ...candidate, score: candidate.score + PROTECTED_SCORE_BONUS };
  });
}

function emptyProtection(results: SearchResult[]): LiteralListProtectionResult {
  return { protectedFingerprints: [], protectedIds: [], reasons: [], results };
}
