/**
 * Affinity-Based Memory Clustering.
 *
 * Identifies groups of related memories that are candidates for
 * consolidation (LLM-based synthesis into abstract memories).
 * Runs as a batch process during off-peak times.
 *
 * Pipeline:
 *   1. Compute pairwise affinity scores (semantic + temporal proximity)
 *   2. Greedy cluster assignment (threshold-based)
 *   3. Return clusters for LLM synthesis (separate step, requires API)
 *
 * Source: SimpleMem consolidation pattern.
 */

import { cosineSimilarity } from './entropy-gate.js';

const DEFAULT_AFFINITY_THRESHOLD = 0.85;
const DEFAULT_MIN_CLUSTER_SIZE = 3;
const DEFAULT_BETA = 0.5;
const DEFAULT_TEMPORAL_LAMBDA = 0.1;
const MS_PER_HOUR = 3_600_000;

export interface AffinityConfig {
  /** Minimum affinity to consider two memories related. */
  threshold: number;
  /** Minimum cluster size to keep. */
  minClusterSize: number;
  /** Weight for semantic vs temporal signal (0=temporal only, 1=semantic only). */
  beta: number;
  /** Temporal decay rate (higher = faster decay with time distance). */
  temporalLambda: number;
}

export const DEFAULT_AFFINITY_CONFIG: AffinityConfig = {
  threshold: DEFAULT_AFFINITY_THRESHOLD,
  minClusterSize: DEFAULT_MIN_CLUSTER_SIZE,
  beta: DEFAULT_BETA,
  temporalLambda: DEFAULT_TEMPORAL_LAMBDA,
};

export interface ClusterableMemory {
  id: string;
  embedding: number[];
  createdAt: Date;
  content: string;
  importance: number;
}

export interface AffinityPair {
  idA: string;
  idB: string;
  score: number;
  semanticSim: number;
  temporalProx: number;
}

export interface MemoryCluster {
  members: ClusterableMemory[];
  avgAffinity: number;
}

/**
 * Compute affinity between two memories.
 * affinity = β × semanticSim + (1-β) × temporalProximity
 */
export function computeAffinity(
  a: ClusterableMemory,
  b: ClusterableMemory,
  config: AffinityConfig = DEFAULT_AFFINITY_CONFIG,
): AffinityPair {
  const semanticSim = cosineSimilarity(a.embedding, b.embedding);
  const temporalProx = computeTemporalProximity(
    a.createdAt,
    b.createdAt,
    config.temporalLambda,
  );
  const score = config.beta * semanticSim + (1 - config.beta) * temporalProx;

  return {
    idA: a.id,
    idB: b.id,
    score,
    semanticSim,
    temporalProx,
  };
}

/**
 * Temporal proximity between two timestamps.
 * Returns exp(-λ × |t1 - t2| / MS_PER_HOUR) — decays with time distance.
 */
export function computeTemporalProximity(
  t1: Date,
  t2: Date,
  lambda: number = DEFAULT_TEMPORAL_LAMBDA,
): number {
  const hoursDiff = Math.abs(t1.getTime() - t2.getTime()) / MS_PER_HOUR;
  return Math.exp(-lambda * hoursDiff);
}

/**
 * Find all pairwise affinities above threshold.
 * Returns pairs sorted by affinity descending.
 */
export function findAffinePairs(
  memories: ClusterableMemory[],
  config: AffinityConfig = DEFAULT_AFFINITY_CONFIG,
): AffinityPair[] {
  const pairs: AffinityPair[] = [];
  for (let i = 0; i < memories.length; i++) {
    for (let j = i + 1; j < memories.length; j++) {
      const pair = computeAffinity(memories[i], memories[j], config);
      if (pair.score >= config.threshold) {
        pairs.push(pair);
      }
    }
  }
  return pairs.sort((a, b) => b.score - a.score);
}

/**
 * Greedy cluster formation from pairwise affinities.
 *
 * For each unassigned memory, find all unassigned neighbors with
 * affinity >= threshold. If the resulting group meets minClusterSize,
 * it becomes a cluster. Each memory is assigned to at most one cluster.
 */
export function formClusters(
  memories: ClusterableMemory[],
  config: AffinityConfig = DEFAULT_AFFINITY_CONFIG,
): MemoryCluster[] {
  const pairs = findAffinePairs(memories, config);
  const adjacency = buildAdjacencyMap(pairs, config.threshold);
  const assigned = new Set<string>();
  const clusters: MemoryCluster[] = [];
  const memoryMap = new Map(memories.map((m) => [m.id, m]));

  const sortedMemories = [...memories].sort((a, b) => b.importance - a.importance);

  for (const memory of sortedMemories) {
    if (assigned.has(memory.id)) continue;

    const neighbors = (adjacency.get(memory.id) ?? [])
      .filter((id) => !assigned.has(id));

    const clusterIds = [memory.id, ...neighbors];
    if (clusterIds.length < config.minClusterSize) continue;

    const members = clusterIds
      .map((id) => memoryMap.get(id))
      .filter((m): m is ClusterableMemory => m !== undefined);

    const avgAffinity = computeAvgClusterAffinity(members, config);

    clusters.push({ members, avgAffinity });
    for (const id of clusterIds) assigned.add(id);
  }

  return clusters;
}

function buildAdjacencyMap(
  pairs: AffinityPair[],
  threshold: number,
): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  for (const pair of pairs) {
    if (pair.score < threshold) continue;
    if (!adj.has(pair.idA)) adj.set(pair.idA, []);
    if (!adj.has(pair.idB)) adj.set(pair.idB, []);
    adj.get(pair.idA)!.push(pair.idB);
    adj.get(pair.idB)!.push(pair.idA);
  }
  return adj;
}

function computeAvgClusterAffinity(
  members: ClusterableMemory[],
  config: AffinityConfig,
): number {
  if (members.length < 2) return 0;
  let total = 0;
  let count = 0;
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      total += computeAffinity(members[i], members[j], config).score;
      count++;
    }
  }
  return count > 0 ? total / count : 0;
}
