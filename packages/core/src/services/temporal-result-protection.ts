/**
 * Protect exact temporal keyword hits from being dropped by late-stage
 * reranking or MMR. Temporal comparison questions often need one or two
 * specific event memories to survive alongside broader context.
 */

import type { SearchResult } from '../db/memory-repository.js';
import { buildTemporalFingerprint } from './temporal-fingerprint.js';

export function preserveProtectedResults(
  selected: SearchResult[],
  candidates: SearchResult[],
  protectedFingerprints: string[],
  limit: number,
): SearchResult[] {
  if (protectedFingerprints.length === 0 || selected.length === 0) {
    return selected.slice(0, limit);
  }

  const selectedFingerprints = new Set(selected.map((result) => buildTemporalFingerprint(result.content)));
  const protectedSet = new Set(protectedFingerprints);
  const protectedResults = candidates.filter((result) => protectedSet.has(buildTemporalFingerprint(result.content)));

  if (protectedResults.length === 0) {
    return selected.slice(0, limit);
  }

  const dedupedProtectedResults = dedupeByFingerprint(protectedResults);
  const finalResults = [...selected];
  for (const protectedResult of dedupedProtectedResults) {
    const fingerprint = buildTemporalFingerprint(protectedResult.content);
    if (selectedFingerprints.has(fingerprint)) {
      continue;
    }

    const replacementIndex = findReplacementIndex(finalResults, protectedSet);
    if (replacementIndex === -1) {
      break;
    }

    finalResults[replacementIndex] = protectedResult;
    selectedFingerprints.add(fingerprint);
  }

  return finalResults
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}

function dedupeByFingerprint(results: SearchResult[]): SearchResult[] {
  const byFingerprint = new Map<string, SearchResult>();
  for (const result of results) {
    const fingerprint = buildTemporalFingerprint(result.content);
    const existing = byFingerprint.get(fingerprint);
    if (!existing || result.score > existing.score) {
      byFingerprint.set(fingerprint, result);
    }
  }
  return [...byFingerprint.values()];
}

function findReplacementIndex(
  results: SearchResult[],
  protectedFingerprints: Set<string>,
): number {
  let replacementIndex = -1;
  let lowestScore = Infinity;
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (protectedFingerprints.has(buildTemporalFingerprint(result.content))) {
      continue;
    }
    if (result.score < lowestScore) {
      lowestScore = result.score;
      replacementIndex = i;
    }
  }
  return replacementIndex;
}
