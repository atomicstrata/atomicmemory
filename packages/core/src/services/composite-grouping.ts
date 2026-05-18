/**
 * Composite Memory Grouping — clusters related atomic facts from a single episode
 * into paragraph-length composite memories that benefit from tiered loading (L0/L1/L2).
 *
 * Atomistic extraction produces single-sentence facts (median ~80 chars) where
 * L1 overviews are identical to L2 content, making tiered retrieval degenerate to
 * flat mode. Composites bridge this gap: they join related facts into paragraph-length
 * content that generateL1Overview() can meaningfully compress.
 *
 * Algorithm: Greedy single-linkage clustering on cosine similarity of fact embeddings.
 * Clusters with < minClusterSize members are skipped (no compression benefit).
 */

import { config } from '../config.js';
import { cosineSimilarity } from './embedding.js';
import { generateL1Overview } from './tiered-context.js';

export interface CompositeInput {
  memoryId: string;
  content: string;
  embedding: number[];
  importance: number;
  keywords: string[];
  headline: string;
}

export interface CompositeMemory {
  /** Paragraph joining member facts in importance-descending order. */
  content: string;
  /** L0: headline from the most important member fact. */
  headline: string;
  /** L1: overview generated from the composite content (first 2-3 sentences). */
  overview: string;
  /** Centroid of member fact embeddings. */
  embedding: number[];
  /** Max importance across member facts. */
  importance: number;
  /** Union of all member keywords, deduplicated. */
  keywords: string[];
  /** IDs of the atomic memories grouped into this composite. */
  memberMemoryIds: string[];
}

/**
 * Group facts from a single episode into composite memories by topic similarity.
 * Returns only composites with ≥ minClusterSize members.
 */
export function buildComposites(facts: CompositeInput[]): CompositeMemory[] {
  if (facts.length < config.compositeMinClusterSize) return [];

  const clusters = clusterBySimilarity(
    facts,
    config.compositeSimilarityThreshold,
  );

  return clusters
    .filter((cluster) => cluster.length >= config.compositeMinClusterSize)
    .map(synthesizeComposite);
}

/**
 * Greedy single-linkage clustering: assign each fact to the most similar
 * existing cluster (by centroid), or start a new cluster if below threshold.
 *
 * Clusters are capped at compositeMaxClusterSize to prevent "everything-bagel"
 * composites where centroid drift causes unrelated facts to cluster together.
 */
function clusterBySimilarity(
  facts: CompositeInput[],
  threshold: number,
): CompositeInput[][] {
  const clusters: CompositeInput[][] = [];
  const centroids: number[][] = [];
  const maxSize = config.compositeMaxClusterSize;

  for (const fact of facts) {
    let bestClusterIndex = -1;
    let bestSimilarity = -1;

    for (let i = 0; i < centroids.length; i++) {
      if (clusters[i].length >= maxSize) continue;
      const sim = cosineSimilarity(fact.embedding, centroids[i]);
      if (sim > bestSimilarity) {
        bestSimilarity = sim;
        bestClusterIndex = i;
      }
    }

    if (bestClusterIndex >= 0 && bestSimilarity >= threshold) {
      clusters[bestClusterIndex].push(fact);
      centroids[bestClusterIndex] = computeCentroid(clusters[bestClusterIndex]);
    } else {
      clusters.push([fact]);
      centroids.push([...fact.embedding]);
    }
  }

  return clusters;
}

/** Synthesize a composite memory from a cluster of related facts. */
function synthesizeComposite(cluster: CompositeInput[]): CompositeMemory {
  const sorted = [...cluster].sort((a, b) => b.importance - a.importance);
  const content = sorted.map((f) => f.content).join(' ');
  const headline = sorted[0].headline;
  const overview = generateL1Overview(content);
  const embedding = computeCentroid(cluster);
  const importance = Math.max(...cluster.map((f) => f.importance));
  const keywords = deduplicateKeywords(cluster.flatMap((f) => f.keywords));
  const memberMemoryIds = cluster.map((f) => f.memoryId);

  return {
    content,
    headline,
    overview: overview !== content ? overview : '',
    embedding,
    importance,
    keywords,
    memberMemoryIds,
  };
}

/** Compute the centroid (element-wise mean) of a set of embeddings. */
function computeCentroid(facts: CompositeInput[]): number[] {
  if (facts.length === 0) return [];
  const dim = facts[0].embedding.length;
  const sum = new Float64Array(dim);
  for (const fact of facts) {
    for (let i = 0; i < dim; i++) {
      sum[i] += fact.embedding[i];
    }
  }
  const centroid = new Array<number>(dim);
  for (let i = 0; i < dim; i++) {
    centroid[i] = sum[i] / facts.length;
  }
  return centroid;
}


/** Deduplicate keywords preserving original casing of first occurrence. */
function deduplicateKeywords(keywords: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const kw of keywords) {
    const lower = kw.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      result.push(kw);
    }
  }
  return result;
}
