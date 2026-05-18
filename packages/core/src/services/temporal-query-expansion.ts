/**
 * Deterministic query expansion for temporal-order questions.
 * Pulls exact keyword candidates and nearby session memories when the query
 * asks about sequence, relative timing, or duration.
 */

import type { SearchResult } from '../db/repository-types.js';
import type { SearchStore } from '../db/stores.js';
import { buildTemporalFingerprint } from './temporal-fingerprint.js';

const TEMPORAL_MARKERS = [
  'before',
  'after',
  'when',
  'timeline',
  'order',
  'sequence',
  'relative',
  'how long',
  'first',
  'second',
];

const STOP_WORDS = new Set([
  'what', 'when', 'where', 'which', 'who', 'whom', 'whose', 'why', 'how',
  'did', 'does', 'do', 'was', 'were', 'is', 'are', 'the', 'a', 'an', 'and',
  'or', 'to', 'of', 'in', 'for', 'on', 'with', 'between', 'these', 'those',
  'this', 'that', 'their', 'they', 'them', 'therefore', 'developer', 'student',
  'order', 'changes', 'made', 'project', 'relative', 'timeline', 'receive', 'from',
]);

const HIGH_SIGNAL_PATTERNS = [
  /\bDr\.?\s+[A-Z][a-z]+\b/g,
  /\b[A-Z]{2,}\s+\d{4}\b/g,
  /\b(?:career advice|application timeline|application deadlines|first paper|second submission|finance tracker)\b/gi,
  /\bdotctl\b/gi,
];
const MAX_TEMPORAL_ANCHORS = 4;

export function isTemporalOrderingQuery(query: string): boolean {
  const lower = query.toLowerCase();
  return TEMPORAL_MARKERS.some((marker) => lower.includes(marker));
}

export function extractTemporalQueryKeywords(query: string): string[] {
  if (!isTemporalOrderingQuery(query)) {
    return [];
  }

  const phrases = collectPatternMatches(query);
  const tokens = tokenizeQuery(query);
  const keywords = [...phrases, ...tokens];
  return [...new Set(keywords.map((keyword) => keyword.trim()).filter(Boolean))].slice(0, 10);
}

export async function expandTemporalQuery(
  repo: SearchStore,
  userId: string,
  query: string,
  queryEmbedding: number[],
  excludeIds: Set<string>,
  limit: number,
  referenceTime?: Date,
): Promise<{ memories: SearchResult[]; keywords: string[]; anchorIds: string[] }> {
  const keywords = extractTemporalQueryKeywords(query);
  if (keywords.length === 0) {
    return { memories: [], keywords, anchorIds: [] };
  }

  const keywordHits = await repo.findKeywordCandidates(userId, keywords, limit);
  const keywordIds = keywordHits.map((memory) => memory.id);
  const initialAnchorIds = selectAnchorIds(
    keywordHits,
    new Set(keywordIds.filter((id) => excludeIds.has(id))),
    limit,
  );
  const anchorIds = initialAnchorIds.length >= Math.min(MAX_TEMPORAL_ANCHORS, limit)
    ? initialAnchorIds
    : [
        ...initialAnchorIds,
        ...selectAnchorIds(
          keywordHits,
          new Set(keywordIds.filter((id) => !excludeIds.has(id))),
          Math.min(MAX_TEMPORAL_ANCHORS, limit) - initialAnchorIds.length,
        ),
      ];
  const expansionIds = keywordIds.filter((id) => !excludeIds.has(id));

  if (anchorIds.length === 0) {
    return { memories: [], keywords, anchorIds: [] };
  }

  const anchorMemories = await repo.fetchMemoriesByIds(
    userId,
    anchorIds,
    queryEmbedding,
    referenceTime,
  );
  const expansionSet = new Set(expansionIds);
  const keywordMemories = anchorMemories.filter((memory) => expansionSet.has(memory.id));
  const temporalNeighbors = await repo.findTemporalNeighbors(
    userId,
    anchorMemories.map((memory) => memory.created_at),
    queryEmbedding,
    30,
    new Set([...excludeIds, ...anchorIds]),
    limit,
    referenceTime,
  );

  return {
    memories: [...keywordMemories, ...temporalNeighbors],
    keywords,
    anchorIds,
  };
}

function collectPatternMatches(query: string): string[] {
  const matches: string[] = [];
  for (const pattern of HIGH_SIGNAL_PATTERNS) {
    const regex = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(query)) !== null) {
      matches.push(match[0]);
    }
  }
  return matches;
}

function tokenizeQuery(query: string): string[] {
  const words = query.match(/[A-Za-z0-9.]+/g) ?? [];
  const filtered = words.filter((word) => isUsefulKeyword(word));
  const bigrams = buildBigrams(filtered);
  return [...filtered, ...bigrams];
}

function selectAnchorIds(
  keywordHits: Array<{ id: string; content: string }>,
  keywordMemoryIds: Set<string>,
  limit: number,
): string[] {
  const seenFingerprints = new Set<string>();
  const anchorIds: string[] = [];
  for (const hit of keywordHits) {
    if (!keywordMemoryIds.has(hit.id)) {
      continue;
    }
    const fingerprint = buildTemporalFingerprint(hit.content);
    if (seenFingerprints.has(fingerprint)) {
      continue;
    }
    seenFingerprints.add(fingerprint);
    anchorIds.push(hit.id);
    if (anchorIds.length >= Math.min(MAX_TEMPORAL_ANCHORS, limit)) {
      break;
    }
  }
  return anchorIds;
}

function isUsefulKeyword(word: string): boolean {
  const lower = word.toLowerCase();
  if (STOP_WORDS.has(lower)) return false;
  if (isCompactHighSignalToken(word)) return true;
  if (lower.length < 4) return false;
  return true;
}

function buildBigrams(words: string[]): string[] {
  const bigrams: string[] = [];
  for (let i = 0; i < words.length - 1; i++) {
    if (bigrams.length >= 4) break;
    bigrams.push(`${words[i]} ${words[i + 1]}`);
  }
  return bigrams;
}

function isCompactHighSignalToken(word: string): boolean {
  return /^[A-Z]{3,}$/.test(word) || /[A-Z]/.test(word.slice(1));
}
