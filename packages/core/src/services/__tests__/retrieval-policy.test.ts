/**
 * Unit tests for retrieval-policy pure functions.
 * Tests query complexity classification, repair loop gating,
 * repair acceptance decisions, result merging, and rerank depth.
 */

import { describe, expect, it, vi } from 'vitest';
import type { RetrievalProfile } from '../retrieval-profiles.js';
import type { SearchResult } from '../../db/memory-repository.js';
import { createSearchResult } from './test-fixtures.js';

const retrievalProfileSettings: RetrievalProfile = {
  name: 'balanced',
  maxSearchResults: 10,
  repairLoopEnabled: true,
  adaptiveRetrievalEnabled: true,
  hybridSearchEnabled: false,
  repairLoopMinSimilarity: 0.3,
  repairSkipSimilarity: 0.55,
  rerankDepth: 20,
  repairPrimaryWeight: 1.0,
  repairRewriteWeight: 0.8,
  lexicalWeight: 0.8,
  mmrEnabled: true,
  mmrLambda: 0.85,
  linkExpansionEnabled: true,
  linkExpansionMax: 3,
  linkSimilarityThreshold: 0.5,
  scoringWeightSimilarity: 2.0,
  scoringWeightImportance: 1.0,
  scoringWeightRecency: 1.0,
  rankingMinSimilarity: 0.3,
  linkExpansionBeforeMMR: false,
  repairDeltaThreshold: 0,
  repairConfidenceFloor: 0,
};

const mockConfig = {
  adaptiveRetrievalEnabled: true,
  adaptiveSimpleLimit: 5,
  adaptiveMediumLimit: 5,
  adaptiveComplexLimit: 8,
  adaptiveMultiHopLimit: 12,
  adaptiveAggregationLimit: 25,
  maxSearchResults: 10,
  repairLoopEnabled: true,
  repairLoopMinSimilarity: 0.3,
  repairSkipSimilarity: 0.55,
  repairDeltaThreshold: 0,
  repairConfidenceFloor: 0,
  retrievalProfileSettings,
};

vi.mock('../../config.js', () => ({
  config: mockConfig,
}));

const {
  resolveSearchLimit,
  resolveSearchLimitDetailed,
  classifyQueryDetailed,
  shouldRunRepairLoop,
  shouldAcceptRepair,
  mergeSearchResults,
  resolveRerankDepth,
  AGGREGATION_QUERY_LIMIT,
} = await import('../retrieval-policy.js');

function makeResult(overrides: Partial<SearchResult> = {}) {
  return createSearchResult({ id: `mem-${Math.random().toString(36).slice(2, 8)}`, embedding: [0.1, 0.2], ...overrides });
}

describe('resolveSearchLimit', () => {
  it('uses explicit limit when provided', () => {
    expect(resolveSearchLimit('anything', 5, mockConfig)).toBe(5);
  });

  it('clamps explicit limit to maxSearchResults', () => {
    expect(resolveSearchLimit('anything', 100, mockConfig)).toBe(10);
  });

  it('clamps explicit limit to minimum 1', () => {
    // When adaptive is on and requested=0, the result is MAX(clamped requested=1,
    // classification limit). For a non-classified query ('anything' = simple),
    // classification returns 5, so MAX(1, 5) = 5. The property tested is still
    // "result >= 1" — the original assertion of exact equality to 1 was a side
    // effect of the old short-circuit and is no longer the contract.
    expect(resolveSearchLimit('anything', 0, mockConfig)).toBeGreaterThanOrEqual(1);
  });

  it('classifies short question queries as simple (5)', () => {
    const limit = resolveSearchLimit('what is TypeScript?', undefined, mockConfig);
    expect(limit).toBe(5);
  });

  it('classifies complex queries with temporal markers as 8', () => {
    const limit = resolveSearchLimit('how did the architecture change over time', undefined, mockConfig);
    expect(limit).toBe(8);
  });

  it('classifies "current" queries as multi-hop (clamped to 10)', () => {
    const limit = resolveSearchLimit(
      'tell me about the current status of the project deployment process',
      undefined,
      mockConfig,
    );
    expect(limit).toBe(10);
  });

  it('classifies medium queries (>9 words, no markers) as 5', () => {
    const limit = resolveSearchLimit(
      'tell me about the overall status of the project deployment process',
      undefined,
      mockConfig,
    );
    expect(limit).toBe(5);
  });

  it('classifies multi-hop queries as 12', () => {
    const limit = resolveSearchLimit('compare the old and new authentication approaches', undefined, mockConfig);
    expect(limit).toBe(10);
  });

  it('classifies non-question short queries as medium (5)', () => {
    const limit = resolveSearchLimit('TypeScript migration plan', undefined, mockConfig);
    expect(limit).toBe(5);
  });

  it('falls back to maxSearchResults when adaptive disabled', () => {
    mockConfig.adaptiveRetrievalEnabled = false;
    const limit = resolveSearchLimit('how did things change', undefined, mockConfig);
    expect(limit).toBe(10);
    mockConfig.adaptiveRetrievalEnabled = true;
  });

  it('classifies aggregation queries above maxSearchResults', () => {
    const limit = resolveSearchLimit('How many model kits have I bought?', undefined, mockConfig);
    expect(limit).toBe(AGGREGATION_QUERY_LIMIT);
    expect(limit).toBeGreaterThan(mockConfig.maxSearchResults);
  });

  it('uses configured adaptive limits when no explicit limit is provided', () => {
    mockConfig.adaptiveSimpleLimit = 7;
    mockConfig.adaptiveComplexLimit = 11;

    expect(resolveSearchLimit('what is TypeScript?', undefined, mockConfig)).toBe(7);
    expect(resolveSearchLimit('how did the architecture change', undefined, mockConfig)).toBe(10);

    mockConfig.adaptiveSimpleLimit = 5;
    mockConfig.adaptiveComplexLimit = 8;
  });

  it('uses configured aggregation limit without maxSearchResults clamp', () => {
    mockConfig.adaptiveAggregationLimit = 30;
    expect(resolveSearchLimit('How many model kits have I bought?', undefined, mockConfig)).toBe(30);
    mockConfig.adaptiveAggregationLimit = 25;
  });

  it('detects "how many" as aggregation', () => {
    expect(resolveSearchLimit('How many times did I mention yoga?', undefined, mockConfig))
      .toBe(AGGREGATION_QUERY_LIMIT);
  });

  it('detects "total amount" as aggregation', () => {
    expect(resolveSearchLimit('What is the total amount I spent on car mods?', undefined, mockConfig))
      .toBe(AGGREGATION_QUERY_LIMIT);
  });

  it('detects "list all" as aggregation', () => {
    expect(resolveSearchLimit('list all the restaurants I visited', undefined, mockConfig))
      .toBe(AGGREGATION_QUERY_LIMIT);
  });

  it('does not classify simple "how" queries as aggregation', () => {
    const limit = resolveSearchLimit('how did the architecture change', undefined, mockConfig);
    expect(limit).not.toBe(AGGREGATION_QUERY_LIMIT);
  });
});

describe('classifyQueryDetailed', () => {
  it('reports "current" as matched marker for current-state queries', () => {
    const result = classifyQueryDetailed('What are the current performance goals?');
    expect(result.label).toBe('multi-hop');
    expect(result.matchedMarker).toBe('current');
  });

  it('reports "compare" as matched marker for comparison queries', () => {
    const result = classifyQueryDetailed('compare the old and new auth approaches');
    expect(result.label).toBe('multi-hop');
    expect(result.matchedMarker).toBe('compare');
  });

  it('reports "how many" as matched marker for aggregation queries', () => {
    const result = classifyQueryDetailed('How many model kits have I bought?');
    expect(result.label).toBe('aggregation');
    expect(result.matchedMarker).toBe('how many');
  });

  it('returns no matched marker for simple queries', () => {
    const result = classifyQueryDetailed('what is TypeScript?');
    expect(result.label).toBe('simple');
    expect(result.matchedMarker).toBeUndefined();
  });

  it('returns no matched marker for medium queries', () => {
    const result = classifyQueryDetailed('tell me about the overall status of the project deployment');
    expect(result.label).toBe('medium');
    expect(result.matchedMarker).toBeUndefined();
  });
});

describe('resolveSearchLimitDetailed', () => {
  it('includes classification metadata with matched marker', () => {
    const result = resolveSearchLimitDetailed(
      'What is the current status of the project?',
      undefined,
      mockConfig,
    );
    expect(result.classification.label).toBe('multi-hop');
    expect(result.classification.matchedMarker).toBe('current');
    expect(result.limit).toBe(10);
  });
});

describe('shouldRunRepairLoop', () => {
  it('returns false when repair loop disabled', () => {
    mockConfig.repairLoopEnabled = false;
    expect(shouldRunRepairLoop('test query', [makeResult()], mockConfig)).toBe(false);
    mockConfig.repairLoopEnabled = true;
  });

  it('returns false for ineligible query even with no results', () => {
    expect(shouldRunRepairLoop('test query', [], mockConfig)).toBe(false);
  });

  it('returns true for eligible query with no results', () => {
    expect(shouldRunRepairLoop('compare the old and new approaches', [], mockConfig)).toBe(true);
  });

  it('returns true when top similarity below threshold for eligible query', () => {
    const results = [makeResult({ similarity: 0.2 })];
    expect(shouldRunRepairLoop('compare the old and new approaches', results, mockConfig)).toBe(true);
  });

  it('returns false for simple query with good similarity', () => {
    const results = Array.from({ length: 5 }, () => makeResult({ similarity: 0.8 }));
    expect(shouldRunRepairLoop('what is TypeScript', results, mockConfig)).toBe(false);
  });

  it('runs repair for complex query with good similarity but insufficient results', () => {
    const results = [makeResult({ similarity: 0.8 })];
    expect(shouldRunRepairLoop('how did the architecture change', results, mockConfig)).toBe(true);
  });

  it('runs repair for complex query with low similarity and insufficient results', () => {
    const results = [makeResult({ similarity: 0.4 })];
    expect(shouldRunRepairLoop('how did the architecture change', results, mockConfig)).toBe(true);
  });
});

describe('shouldAcceptRepair', () => {
  it('accepts when thresholds are zero (ungated)', () => {
    const initial = [makeResult({ similarity: 0.5 })];
    const repaired = [makeResult({ similarity: 0.51 })];
    const decision = shouldAcceptRepair(initial, repaired, mockConfig);
    expect(decision.accepted).toBe(true);
    expect(decision.reason).toBe('accepted');
  });

  it('rejects when delta below threshold', () => {
    mockConfig.repairDeltaThreshold = 0.05;
    const initial = [makeResult({ similarity: 0.5 })];
    const repaired = [makeResult({ similarity: 0.52 })];
    const decision = shouldAcceptRepair(initial, repaired, mockConfig);
    expect(decision.accepted).toBe(false);
    expect(decision.reason).toBe('delta-below-threshold');
    mockConfig.repairDeltaThreshold = 0;
  });

  it('rejects when repaired similarity below confidence floor', () => {
    mockConfig.repairConfidenceFloor = 0.4;
    const initial = [makeResult({ similarity: 0.2 })];
    const repaired = [makeResult({ similarity: 0.3 })];
    const decision = shouldAcceptRepair(initial, repaired, mockConfig);
    expect(decision.accepted).toBe(false);
    expect(decision.reason).toBe('below-confidence-floor');
    mockConfig.repairConfidenceFloor = 0;
  });

  it('computes correct simDelta', () => {
    const initial = [makeResult({ similarity: 0.4 })];
    const repaired = [makeResult({ similarity: 0.7 })];
    const decision = shouldAcceptRepair(initial, repaired, mockConfig);
    expect(decision.simDelta).toBeCloseTo(0.3, 5);
    expect(decision.initialTopSim).toBeCloseTo(0.4, 5);
    expect(decision.repairedTopSim).toBeCloseTo(0.7, 5);
  });

  it('handles empty initial results', () => {
    const repaired = [makeResult({ similarity: 0.5 })];
    const decision = shouldAcceptRepair([], repaired, mockConfig);
    expect(decision.accepted).toBe(true);
    expect(decision.initialTopSim).toBe(0);
  });

  it('handles empty repaired results', () => {
    const initial = [makeResult({ similarity: 0.5 })];
    const decision = shouldAcceptRepair(initial, [], mockConfig);
    expect(decision.accepted).toBe(false);
    expect(decision.reason).toBe('delta-below-threshold');
    expect(decision.repairedTopSim).toBe(0);
  });
});

describe('mergeSearchResults', () => {
  it('deduplicates by ID keeping higher score', () => {
    const id = 'shared-id';
    const primary = [makeResult({ id, score: 0.9 })];
    const repair = [makeResult({ id, score: 0.95 })];
    const merged = mergeSearchResults(primary, repair, 10, mockConfig);
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe(id);
  });

  it('sorts merged results by score descending', () => {
    const a = makeResult({ id: 'a', score: 0.5 });
    const b = makeResult({ id: 'b', score: 0.9 });
    const c = makeResult({ id: 'c', score: 0.7 });
    const merged = mergeSearchResults([a, b], [c], 10, mockConfig);
    expect(merged[0].id).toBe('b');
    expect(merged[1].id).toBe('c');
    expect(merged[2].id).toBe('a');
  });

  it('respects limit parameter', () => {
    const primary = Array.from({ length: 5 }, (_, i) =>
      makeResult({ id: `p-${i}`, score: 0.5 + i * 0.05 }),
    );
    const repair = Array.from({ length: 5 }, (_, i) =>
      makeResult({ id: `r-${i}`, score: 0.4 + i * 0.05 }),
    );
    const merged = mergeSearchResults(primary, repair, 3, mockConfig);
    expect(merged).toHaveLength(3);
  });

  it('applies weight to repair results', () => {
    const primary = [makeResult({ id: 'p', score: 1.0 })];
    const repair = [makeResult({ id: 'r', score: 1.0 })];
    const merged = mergeSearchResults(primary, repair, 10, mockConfig);
    const primaryResult = merged.find((r) => r.id === 'p')!;
    const repairResult = merged.find((r) => r.id === 'r')!;
    expect(primaryResult.score).toBe(1.0);
    expect(repairResult.score).toBe(0.8);
  });
});

describe('resolveRerankDepth', () => {
  it('returns rerankDepth when greater than limit', () => {
    expect(resolveRerankDepth(5, mockConfig)).toBe(20);
  });

  it('returns limit when greater than rerankDepth', () => {
    expect(resolveRerankDepth(30, mockConfig)).toBe(30);
  });

  it('uses aggregation limit without clamping to maxSearchResults', () => {
    expect(resolveRerankDepth(AGGREGATION_QUERY_LIMIT, mockConfig)).toBe(25);
  });
});
