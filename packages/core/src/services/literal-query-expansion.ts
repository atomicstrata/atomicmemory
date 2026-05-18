/**
 * Deterministic retrieval helpers for literal autobiographical lookups.
 *
 * These queries ask for exact titles, quotes, object details, pets, photos,
 * posters, store details, or other concrete memory fragments. Pure semantic
 * retrieval often under-ranks those rows because the query phrasing is broad
 * while the target memory contains a short literal detail.
 *
 * This module extracts high-signal lexical anchors from the query, finds exact
 * keyword candidates, and boosts them enough to survive later reranking.
 */

import type { SearchResult } from '../db/repository-types.js';
import type { SearchStore } from '../db/stores.js';
import { fetchAndBoostKeywordCandidates } from './keyword-expansion.js';

const DIRECT_LOOKUP_PREFIX = /^\s*(?:what|which|who|where|when)\b/i;
const ABSTRACT_BLOCKERS = [
  'attitude',
  'important',
  'inspired',
  'meaning',
  'motivated',
  'reaction',
  'realize',
  'reason',
  'represent',
  'symbol',
  'take away',
  'why',
];
const LITERAL_SIGNALS = [
  'book',
  'books',
  'bowl',
  'cat',
  'cats',
  'clothing store',
  'concert',
  'decor',
  'dog',
  'dogs',
  'drawing',
  'fan',
  'festival',
  'flooring',
  'furniture',
  'grand canyon',
  'guinea pig',
  'library',
  'meteor shower',
  'music',
  'musician',
  'musicians',
  'painting',
  'paintings',
  'pet',
  'pets',
  'photo',
  'photos',
  'poetry reading',
  'poster',
  'posters',
  'pottery',
  'road trip',
  'shoe',
  'shoes',
  'sidewalk',
  'sign',
  'slipper',
  'song',
  'songs',
  'store',
  'title',
  'workshop',
];
const SIGNAL_WINDOW_RADIUS = 2;
const MAX_KEYWORDS = 8;
const LITERAL_SCORE_BOOST = 0.75;
const WORD_BOUNDARY = /\b[\w'’.-]+\b/g;
const QUOTED_LITERAL = /["“”']([^"“”']{2,80})["“”']/g;
const YEAR_PATTERN = /\b(?:19|20)\d{2}\b/g;
const DATE_PATTERN = /\b\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\b/gi;
const MULTI_WORD_PROPER_NOUN = /\b[A-Z][A-Za-z'’.-]+(?:\s+[A-Z][A-Za-z'’.-]+)+\b/g;
const STOP_WORDS = new Set([
  'a', 'an', 'at', 'did', 'do', 'does', 'for', 'from', 'her', 'his', 'in',
  'is', 'kind', 'of', 'on', 'say', 'the', 'their', 'type', 'was', 'were',
  'what', 'when', 'where', 'which', 'who',
]);

export interface LiteralQueryExpansionResult {
  memories: SearchResult[];
  keywords: string[];
}

export function isLiteralDetailQuery(query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized || !DIRECT_LOOKUP_PREFIX.test(normalized)) return false;
  if (ABSTRACT_BLOCKERS.some((signal) => normalized.includes(signal))) return false;
  return extractLiteralQueryKeywords(query).length > 0;
}

export function extractLiteralQueryKeywords(query: string): string[] {
  const candidates = new Set<string>();
  const normalized = query.trim();
  if (!normalized) return [];

  addMatches(candidates, extractQuotedLiterals(normalized));
  addMatches(candidates, extractNamedLiteralCandidates(normalized));
  addMatches(candidates, extractTemporalAnchors(normalized));
  addMatches(candidates, extractSignalWindows(normalized));

  return [...candidates]
    .map(cleanKeyword)
    .filter((keyword) => keyword.length >= 2)
    .slice(0, MAX_KEYWORDS);
}

export async function expandLiteralQuery(
  repo: SearchStore,
  userId: string,
  query: string,
  queryEmbedding: number[],
  excludeIds: Set<string>,
  limit: number,
): Promise<LiteralQueryExpansionResult> {
  const keywords = extractLiteralQueryKeywords(query);
  if (keywords.length === 0) return { memories: [], keywords: [] };

  const boosted = await fetchAndBoostKeywordCandidates(
    repo, userId, keywords, queryEmbedding, excludeIds, limit, LITERAL_SCORE_BOOST,
  );
  return { memories: boosted, keywords };
}

function extractQuotedLiterals(query: string): string[] {
  const matches: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = QUOTED_LITERAL.exec(query)) !== null) {
    matches.push(match[1]);
  }
  return matches;
}

function extractNamedLiteralCandidates(query: string): string[] {
  const candidates = new Set<string>();
  const multiWord = query.match(MULTI_WORD_PROPER_NOUN) ?? [];
  for (const phrase of multiWord) {
    candidates.add(phrase.trim());
  }

  const words = query.match(WORD_BOUNDARY) ?? [];
  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    if (/^[A-Z][A-Za-z'’.-]+$/.test(word) && !STOP_WORDS.has(word.toLowerCase())) {
      candidates.add(word);
    }
  }

  return [...candidates];
}

function extractTemporalAnchors(query: string): string[] {
  return [
    ...(query.match(DATE_PATTERN) ?? []),
    ...(query.match(YEAR_PATTERN) ?? []),
  ];
}

function extractSignalWindows(query: string): string[] {
  const lowerWords = (query.toLowerCase().match(WORD_BOUNDARY) ?? []);
  const originalWords = (query.match(WORD_BOUNDARY) ?? []);
  const windows = new Set<string>();

  for (let i = 0; i < lowerWords.length; i++) {
    const signalLength = matchedSignalLength(lowerWords, i);
    if (signalLength === 0) continue;
    const start = Math.max(0, i - SIGNAL_WINDOW_RADIUS);
    const end = Math.min(originalWords.length, i + signalLength + SIGNAL_WINDOW_RADIUS);
    const window = originalWords.slice(start, end).join(' ');
    windows.add(window);
    windows.add(originalWords.slice(i, i + signalLength).join(' '));
  }

  return [...windows];
}

function matchedSignalLength(words: string[], start: number): number {
  for (const signal of LITERAL_SIGNALS) {
    const signalWords = signal.split(' ');
    const candidate = words.slice(start, start + signalWords.length);
    if (candidate.join(' ') === signal) {
      return signalWords.length;
    }
  }
  return 0;
}

function addMatches(target: Set<string>, values: string[]): void {
  for (const value of values) target.add(value);
}

function cleanKeyword(keyword: string): string {
  return keyword
    .trim()
    .replace(/^[^\w"“”']+|[^\w"“”']+$/g, '')
    .split(/\s+/)
    .filter((word) => !STOP_WORDS.has(word.toLowerCase()))
    .join(' ');
}
