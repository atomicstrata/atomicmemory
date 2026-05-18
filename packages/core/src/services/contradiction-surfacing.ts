/**
 * BEAM CR fix — retrieval-side enrichment for AUDN bilateral preservation.
 *
 * Two responsibilities, both flag-gated by `contradictionSurfacingEnabled`:
 *
 *   1. enrichTopKWithContradictions: scan top-K SearchResults for
 *      `contradiction_active=true`. For each such hit, look up its
 *      active contradiction row and inject the counterpart memory into
 *      the final set (deduplicated). Returns the augmented memory list
 *      plus the resolved contradiction pairs so the prompt can quote both
 *      sides verbatim.
 *
 *   2. buildContradictionsBlock: render the resolved pairs as a
 *      `## CONTRADICTIONS_DETECTED` markdown section. Returns undefined
 *      when there are no contradictions to surface, so callers can
 *      conditionally prepend the block to the injection text.
 *
 * Pure functions plus one DB read via ContradictionsRepository.
 * No fallback behavior — when the surfacing flag is off OR the store is
 * missing, callers see `{ memories, pairs: [] }`.
 */

import type { ContradictionRow, ContradictionsRepository } from '../db/contradictions-repository.js';
import type { SearchResult } from '../db/repository-types.js';
import { QuestionType } from './answer-format.js';

interface ContradictionPair {
  contradictionId: string;
  leftMemoryId: string;
  rightMemoryId: string;
  leftSummary: string;
  rightSummary: string;
}

interface EnrichmentInput {
  userId: string;
  memories: SearchResult[];
  contradictions: ContradictionsRepository | null;
  enabled: boolean;
  /**
   * Fetcher for the counterpart memory row when a contradiction pair has
   * only ONE side in the top-K. Returns null if the row is missing
   * (e.g., hard-deleted). Kept as an injected dep so memory-search can
   * pass the existing `fetchMemoriesByIds` seam without a circular import.
   */
  fetchCounterpart: (memoryId: string) => Promise<SearchResult | null>;
}

interface EnrichmentResult {
  memories: SearchResult[];
  pairs: ContradictionPair[];
}

/**
 * Inspect top-K results for `contradiction_active=true` hits, fetch their
 * counterparts, and produce an augmented memory list + the resolved pairs.
 * Pure additive: never drops memories from the input list.
 */
export async function enrichTopKWithContradictions(
  input: EnrichmentInput,
): Promise<EnrichmentResult> {
  if (!input.enabled || !input.contradictions) {
    return { memories: input.memories, pairs: [] };
  }
  const activeHitIds = input.memories
    .filter((m) => isContradictionActive(m))
    .map((m) => m.id);
  if (activeHitIds.length === 0) {
    return { memories: input.memories, pairs: [] };
  }
  const rows = await input.contradictions.findActiveByUserAndMemoryIds(
    input.userId,
    activeHitIds,
  );
  if (rows.length === 0) {
    return { memories: input.memories, pairs: [] };
  }
  const memoryById = new Map(input.memories.map((m) => [m.id, m]));
  const augmented = [...input.memories];
  const pairs: ContradictionPair[] = [];
  for (const row of rows) {
    const counterpartId = pickCounterpartId(row, memoryById);
    if (counterpartId && !memoryById.has(counterpartId)) {
      const fetched = await input.fetchCounterpart(counterpartId);
      if (fetched) {
        augmented.push(fetched);
        memoryById.set(fetched.id, fetched);
      }
    }
    pairs.push({
      contradictionId: row.id,
      leftMemoryId: row.leftMemoryId,
      rightMemoryId: row.rightMemoryId,
      leftSummary: row.leftSummary,
      rightSummary: row.rightSummary,
    });
  }
  return { memories: augmented, pairs: dedupePairs(pairs) };
}

/**
 * Render the `## CONTRADICTIONS_DETECTED` markdown block. Returns undefined
 * when there's nothing to render OR when the question type is not one of
 * the contradiction-relevant types (e.g., simple summary). Per spec, the
 * block is always rendered for CR queries OR when pairs are present.
 */
export function buildContradictionsBlock(
  pairs: readonly ContradictionPair[],
  questionType: QuestionType,
): string | undefined {
  if (pairs.length === 0) return undefined;
  const relevant =
    questionType === QuestionType.CONTRADICTION ||
    questionType === QuestionType.SUMMARY ||
    questionType === QuestionType.OTHER;
  if (!relevant) return undefined;
  const lines = pairs.map(
    (p) => `- You said: "${p.leftSummary}" but also: "${p.rightSummary}"`,
  );
  return `## CONTRADICTIONS_DETECTED\n${lines.join('\n')}\n\n`;
}

function isContradictionActive(memory: SearchResult): boolean {
  // The column was added by the audn_bilateral migration; some older rows
  // may not surface it through the row normalizer. Treat absence as false.
  const value = (memory as unknown as { contradiction_active?: boolean }).contradiction_active;
  return value === true;
}

function pickCounterpartId(
  row: ContradictionRow,
  memoryById: Map<string, SearchResult>,
): string | null {
  // Prefer the side that's NOT already in top-K. If both are in, return null
  // (no extra fetch needed). If neither is in, prefer the left memory (the
  // older side that AUDN would have discarded pre-fix).
  const leftIn = memoryById.has(row.leftMemoryId);
  const rightIn = memoryById.has(row.rightMemoryId);
  if (leftIn && !rightIn) return row.rightMemoryId;
  if (!leftIn && rightIn) return row.leftMemoryId;
  if (!leftIn && !rightIn) return row.leftMemoryId;
  return null;
}

function dedupePairs(pairs: readonly ContradictionPair[]): ContradictionPair[] {
  const seen = new Set<string>();
  const out: ContradictionPair[] = [];
  for (const p of pairs) {
    if (seen.has(p.contradictionId)) continue;
    seen.add(p.contradictionId);
    out.push(p);
  }
  return out;
}
