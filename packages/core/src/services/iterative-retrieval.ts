/**
 * Deterministic iterative retrieval for compositional multi-hop queries.
 *
 * The first pass finds candidate memories normally. For queries that likely
 * require 5+ facts, a second pass searches around the strongest distinct seeds
 * using blended query+seed embeddings, then merges those neighbors back into
 * the pool with a lower weight.
 */

import type { SearchResult } from '../db/repository-types.js';
import type { SearchStore } from '../db/stores.js';
import { extractSubjectQueryAnchors } from './subject-aware-ranking.js';

const MIN_REQUIRED_FACTS = 5;
const MAX_ITERATIVE_SEEDS = 2;
const SECOND_PASS_WEIGHT = 0.72;
const RELATIONAL_MARKERS = ['connection between', 'relationship between', 'difference between', 'compare', 'versus', 'relate to'];
const TIMELINE_MARKERS = ['timeline', 'order', 'sequence', 'relative to', 'before', 'after', 'how long'];
const SYNTHESIS_MARKERS = ['full', 'broader', 'trajectory', 'future improvement', 'current projects', 'which professors'];

export interface IterativeQueryClassification {
  shouldIterate: boolean;
  estimatedFactCount: number;
  reason: string;
  anchors: string[];
}

export interface IterativeRetrievalResult {
  memories: SearchResult[];
  triggered: boolean;
  estimatedFactCount: number;
  seedIds: string[];
  reason: string;
}

export function classifyIterativeQuery(query: string, results: SearchResult[]): IterativeQueryClassification {
  const anchors = extractSubjectQueryAnchors(query);
  const estimatedFactCount = estimateRequiredFactCount(query, anchors);
  if (results.length < 2) {
    return { shouldIterate: false, estimatedFactCount, reason: 'insufficient-seeds', anchors };
  }
  if (estimatedFactCount < MIN_REQUIRED_FACTS) {
    return { shouldIterate: false, estimatedFactCount, reason: 'below-threshold', anchors };
  }
  return { shouldIterate: true, estimatedFactCount, reason: classifyReason(query), anchors };
}

export async function applyIterativeRetrieval(
  repo: SearchStore,
  userId: string,
  query: string,
  queryEmbedding: number[],
  initialResults: SearchResult[],
  candidateDepth: number,
  sourceSite?: string,
  referenceTime?: Date,
): Promise<IterativeRetrievalResult> {
  const classification = classifyIterativeQuery(query, initialResults);
  if (!classification.shouldIterate) {
    return buildNoopResult(initialResults, classification);
  }

  const seeds = selectIterativeSeeds(initialResults, classification.anchors);
  const expansions = await retrieveSeedNeighbors(
    repo, userId, queryEmbedding, seeds, candidateDepth, sourceSite, referenceTime,
  );
  if (expansions.length === 0) {
    return {
      memories: initialResults,
      triggered: false,
      estimatedFactCount: classification.estimatedFactCount,
      seedIds: seeds.map((seed) => seed.id),
      reason: 'no-neighbors',
    };
  }

  return {
    memories: mergeIterativeResults(initialResults, expansions, candidateDepth),
    triggered: true,
    estimatedFactCount: classification.estimatedFactCount,
    seedIds: seeds.map((seed) => seed.id),
    reason: classification.reason,
  };
}

export function selectIterativeSeeds(results: SearchResult[], anchors: string[]): SearchResult[] {
  const ranked = [...results].sort((left, right) => scoreSeed(right, anchors) - scoreSeed(left, anchors));
  const selected: SearchResult[] = [];
  const seen = new Set<string>();
  for (const result of ranked) {
    const fingerprint = result.content.toLowerCase().slice(0, 96);
    if (seen.has(fingerprint)) continue;
    selected.push(result);
    seen.add(fingerprint);
    if (selected.length >= MAX_ITERATIVE_SEEDS) break;
  }
  return selected;
}

function buildNoopResult(
  memories: SearchResult[],
  classification: IterativeQueryClassification,
): IterativeRetrievalResult {
  return {
    memories,
    triggered: false,
    estimatedFactCount: classification.estimatedFactCount,
    seedIds: [],
    reason: classification.reason,
  };
}

function estimateRequiredFactCount(query: string, anchors: string[]): number {
  const lower = query.toLowerCase();
  return 2
    + countMarkerHits(lower, RELATIONAL_MARKERS)
    + countMarkerHits(lower, TIMELINE_MARKERS)
    + countMarkerHits(lower, SYNTHESIS_MARKERS)
    + countListedItems(query)
    + Math.min(2, Math.max(0, anchors.length - 1))
    + (lower.split(/\s+/).length >= 12 ? 1 : 0);
}

function classifyReason(query: string): string {
  const lower = query.toLowerCase();
  if (hasMarker(lower, TIMELINE_MARKERS)) return 'timeline-composition';
  if (hasMarker(lower, RELATIONAL_MARKERS)) return 'relational-composition';
  return 'broad-synthesis';
}

async function retrieveSeedNeighbors(
  repo: SearchStore,
  userId: string,
  queryEmbedding: number[],
  seeds: SearchResult[],
  candidateDepth: number,
  sourceSite?: string,
  referenceTime?: Date,
): Promise<SearchResult[]> {
  const seenIds = new Set(seeds.map((seed) => seed.id));
  const searches = seeds.map(async (seed) => {
    const blended = blendEmbeddings(queryEmbedding, seed.embedding);
    const neighbors = await repo.searchSimilar(userId, blended, candidateDepth, sourceSite, referenceTime);
    return neighbors.filter((neighbor) => !seenIds.has(neighbor.id));
  });
  return (await Promise.all(searches)).flat();
}

function mergeIterativeResults(
  primary: SearchResult[],
  expansions: SearchResult[],
  limit: number,
): SearchResult[] {
  const merged = new Map(primary.map((result) => [result.id, result] as const));
  for (const result of expansions) {
    const weighted = { ...result, score: result.score * SECOND_PASS_WEIGHT };
    const existing = merged.get(result.id);
    if (!existing || weighted.score > existing.score) {
      merged.set(result.id, existing ? { ...weighted, score: Math.max(existing.score, weighted.score) } : weighted);
    }
  }
  return [...merged.values()].sort((left, right) => right.score - left.score).slice(0, limit);
}

function scoreSeed(result: SearchResult, anchors: string[]): number {
  return result.score + (countAnchorHits(result.content, anchors) * 0.5);
}

function countAnchorHits(content: string, anchors: string[]): number {
  const lower = content.toLowerCase();
  return anchors.filter((anchor) => lower.includes(anchor.toLowerCase())).length;
}

function blendEmbeddings(queryEmbedding: number[], seedEmbedding: number[]): number[] {
  const length = Math.min(queryEmbedding.length, seedEmbedding.length);
  const blended = new Array<number>(length);
  for (let i = 0; i < length; i++) {
    blended[i] = (queryEmbedding[i] * 0.6) + (seedEmbedding[i] * 0.4);
  }
  return blended;
}

function countMarkerHits(query: string, markers: string[]): number {
  return markers.reduce((total, marker) => total + (query.includes(marker) ? 1 : 0), 0);
}

function hasMarker(query: string, markers: string[]): boolean {
  return markers.some((marker) => query.includes(marker));
}

function countListedItems(query: string): number {
  const match = query.match(/:\s*([^?]+)/);
  if (!match) return 0;
  return Math.max(0, match[1].split(',').map((item) => item.trim()).filter(Boolean).length - 1);
}
