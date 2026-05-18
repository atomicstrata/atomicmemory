/**
 * Shared vector math utilities used across embedding, search, and MMR modules.
 * Provides a single canonical implementation of cosine similarity to avoid
 * duplication across the codebase.
 */

/**
 * Cosine similarity between two vectors.
 * Returns 0 for missing, empty, mismatched-length, or zero-magnitude vectors.
 *
 * Defensive guard: callers downstream of multi-channel RRF can produce
 * candidates whose `embedding` was projected away by an intermediate stage
 * (e.g. a cross-encoder rerank that drops the vector to save bytes). Treating
 * those as zero-similarity is preferable to a 500.
 */
export function cosineSimilarity(left: number[] | undefined | null, right: number[] | undefined | null): number {
  if (!left || !right) return 0;
  if (left.length === 0 || right.length === 0 || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let i = 0; i < left.length; i++) {
    dot += left[i] * right[i];
    leftNorm += left[i] * left[i];
    rightNorm += right[i] * right[i];
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}
