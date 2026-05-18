/**
 * Query-policy helpers for abstract "why/how/meaning" questions.
 *
 * These queries are often grounded in the user's memories, but they need
 * more sentence-level context than direct slot-lookup questions. The
 * `abstract-aware` retrieval mode uses this detector to preserve richer
 * context and to allow a hybrid fallback only after semantic retrieval
 * returns no candidates.
 */

import type { RetrievalMode } from './memory-service-types.js';

const ABSTRACT_PREFIXES = [
  /^\s*why\b/i,
  /^\s*how\b/i,
  /^\s*what (?:did|does)\b/i,
];

const ABSTRACT_SIGNALS = [
  'choose',
  'decide',
  'explain',
  'how does',
  'how did',
  'imply',
  'learn',
  'meaning',
  'mean',
  'motivat',
  'plan',
  'priorit',
  'realiz',
  'reason',
  'reflect',
  'signif',
  'symbol',
  'takeaway',
  'why',
];

export function isAbstractQuery(query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return false;
  if (ABSTRACT_PREFIXES.some((pattern) => pattern.test(normalized))) {
    return ABSTRACT_SIGNALS.some((signal) => normalized.includes(signal));
  }
  return ABSTRACT_SIGNALS.some((signal) => normalized.includes(signal));
}

export function prefersAbstractAwareRetrieval(
  retrievalMode: RetrievalMode | undefined,
  query: string,
): boolean {
  return retrievalMode === 'abstract-aware' && isAbstractQuery(query);
}

export function shouldUseAbstractHybridFallback(
  retrievalMode: RetrievalMode | undefined,
  query: string,
  resultCount: number,
): boolean {
  return prefersAbstractAwareRetrieval(retrievalMode, query) && resultCount === 0;
}
