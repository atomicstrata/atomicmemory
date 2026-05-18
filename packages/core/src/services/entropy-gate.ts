/**
 * Entropy-Aware Write Gating.
 *
 * Filters low-information writes before they reach the memory store.
 * A candidate memory is discarded if its entropy score falls below
 * ENTROPY_THRESHOLD (default 0.35), meaning it adds little novel
 * information relative to what's already stored.
 *
 * Entropy score combines two signals:
 *   - Entity novelty: ratio of new entities to total entities in the text
 *   - Semantic novelty: cosine distance from the previous context embedding
 *
 * Source: SimpleMem pattern (entropy-aware gating at threshold 0.35).
 */

import { cosineSimilarity } from '../vector-math.js';

const DEFAULT_ENTROPY_THRESHOLD = 0.35;
const DEFAULT_ALPHA = 0.5;

export interface EntropyGateConfig {
  threshold: number;
  alpha: number;
}

export const DEFAULT_ENTROPY_CONFIG: EntropyGateConfig = {
  threshold: DEFAULT_ENTROPY_THRESHOLD,
  alpha: DEFAULT_ALPHA,
};

export interface EntropyInput {
  /** Entities extracted from the candidate text. */
  windowEntities: string[];
  /** Entities already known from existing memories. */
  existingEntities: Set<string>;
  /** Embedding of the candidate text. */
  windowEmbedding: number[];
  /** Embedding of the previous context window (null if first). */
  previousEmbedding: number[] | null;
}

export interface EntropyResult {
  score: number;
  entityNovelty: number;
  semanticNovelty: number;
  accepted: boolean;
}

/**
 * Compute the entropy score for a candidate memory.
 * Score = α × entityNovelty + (1-α) × semanticNovelty.
 */
export function computeEntropyScore(
  input: EntropyInput,
  config: EntropyGateConfig = DEFAULT_ENTROPY_CONFIG,
): EntropyResult {
  const entityNovelty = computeEntityNovelty(
    input.windowEntities,
    input.existingEntities,
  );
  const semanticNovelty = computeSemanticNovelty(
    input.windowEmbedding,
    input.previousEmbedding,
  );

  const score = config.alpha * entityNovelty + (1 - config.alpha) * semanticNovelty;

  return {
    score,
    entityNovelty,
    semanticNovelty,
    accepted: score >= config.threshold,
  };
}

/**
 * Ratio of new (unseen) entities to total entities in the window.
 * Returns 1.0 if no entities are present (assume novel).
 */
export function computeEntityNovelty(
  windowEntities: string[],
  existingEntities: Set<string>,
): number {
  if (windowEntities.length === 0) return 1.0;
  const newCount = windowEntities.filter((e) => !existingEntities.has(e)).length;
  return newCount / windowEntities.length;
}

/**
 * Semantic distance from previous context embedding.
 * Returns 1.0 if no previous embedding exists (assume fully novel).
 */
export function computeSemanticNovelty(
  current: number[],
  previous: number[] | null,
): number {
  if (!previous || previous.length === 0) return 1.0;
  return 1 - cosineSimilarity(current, previous);
}

export { cosineSimilarity };
