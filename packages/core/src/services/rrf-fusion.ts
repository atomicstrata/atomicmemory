/**
 * Weighted reciprocal rank fusion helpers for combining ranked retrieval channels.
 *
 * This keeps channel fusion deterministic and score-scale agnostic: each channel
 * votes by rank instead of raw score, so a noisy lexical channel cannot displace
 * strong semantic matches by score magnitude alone.
 */

export interface RankedResult {
  id: string;
  score: number;
}

export interface WeightedRrfChannel<T extends RankedResult> {
  name: string;
  weight: number;
  results: T[];
}

export const DEFAULT_RRF_K = 60;

export function weightedRRF<T extends RankedResult>(
  channels: WeightedRrfChannel<T>[],
  limit: number,
  k: number = DEFAULT_RRF_K,
): T[] {
  if (channels.length === 0 || limit <= 0) return [];

  const canonical = new Map<string, T>();
  const fusedScores = new Map<string, number>();

  for (const channel of channels) {
    for (let index = 0; index < channel.results.length; index++) {
      const result = channel.results[index];
      if (!canonical.has(result.id)) {
        canonical.set(result.id, result);
      }
      const contribution = channel.weight / (k + index + 1);
      fusedScores.set(result.id, (fusedScores.get(result.id) ?? 0) + contribution);
    }
  }

  return [...fusedScores.entries()]
    .sort((left, right) => {
      if (right[1] !== left[1]) return right[1] - left[1];
      const leftCanonical = canonical.get(left[0]);
      const rightCanonical = canonical.get(right[0]);
      return (rightCanonical?.score ?? 0) - (leftCanonical?.score ?? 0);
    })
    .slice(0, limit)
    .map(([id, score]) => ({ ...canonical.get(id)!, score }));
}
