/**
 * Unit tests for retrieval relevance gates and recall-bypass policy.
 */

import { describe, expect, it } from 'vitest';
import type { SearchResult } from '../../db/repository-types.js';
import { createSearchResult } from './test-fixtures.js';
import { getRetrievalProfile } from '../retrieval-profiles.js';
import {
  applyRankingEligibility,
  classifyQueryDetailed,
  isAggregationQuery,
  resolveRecallBypass,
} from '../retrieval-policy.js';
import { applyRelevanceFilter, resolveRelevanceGate } from '../relevance-policy.js';

function makeResult(overrides: Partial<SearchResult> = {}) {
  return createSearchResult({ id: 'test-id', embedding: [0.1, 0.2], ...overrides });
}

describe('resolveRelevanceGate', () => {
  it('treats explicit request threshold zero as a caller floor', () => {
    const gate = resolveRelevanceGate('What is my favorite color?', 0, { similarityThreshold: 0.7 });
    const result = applyRelevanceFilter([makeResult({ id: 'zero-relevance', similarity: 0 })], gate);

    expect(gate).toMatchObject({
      threshold: 0,
      source: 'request',
      reason: 'caller-threshold',
    });
    expect(result.decisions[0]).toMatchObject({
      id: 'zero-relevance',
      threshold: 0,
      decision: 'kept',
      reason: 'meets-threshold',
    });
  });

  it('treats configured threshold zero as an enabled config floor', () => {
    const gate = resolveRelevanceGate('What is my favorite color?', undefined, { similarityThreshold: 0 });

    expect(gate).toMatchObject({
      threshold: 0,
      source: 'config',
      reason: 'direct-query-default',
    });
  });
});

describe('applyRankingEligibility', () => {
  it.each([
    ['safe', 0.35],
    ['balanced', 0.3],
    ['quality', 0.25],
  ] as const)('uses the %s profile semantic floor before composite ranking', (profileName, threshold) => {
    const profile = getRetrievalProfile(profileName);
    const relevant = makeResult({ id: 'answer', similarity: threshold + 0.05, score: 0.3 });
    const noisy = makeResult({ id: 'recent-important-noise', similarity: threshold - 0.01, score: 10 });
    const result = applyRankingEligibility(
      'What is my favorite color?',
      [noisy, relevant],
      { retrievalProfileSettings: profile },
    );

    expect(profile.rankingMinSimilarity).toBe(threshold);
    expect(result.triggered).toBe(true);
    expect(result.results.map((memory) => memory.id)).toEqual(['answer']);
    expect(result.removedIds).toEqual(['recent-important-noise']);
  });

  it('bypasses recall-oriented and temporal queries', () => {
    const noisy = makeResult({ id: 'low-sim-history', similarity: 0.01, score: 10 });
    const profile = getRetrievalProfile('balanced');

    expect(applyRankingEligibility('Why did this project change?', [noisy], { retrievalProfileSettings: profile }).triggered)
      .toBe(false);
    expect(applyRankingEligibility('What database do I currently use?', [noisy], { retrievalProfileSettings: profile }).triggered)
      .toBe(false);
    expect(applyRankingEligibility('What did I use before switching?', [noisy], { retrievalProfileSettings: profile }).triggered)
      .toBe(false);
  });

  it('bypasses source-scoped and as-of reads', () => {
    const noisy = makeResult({ id: 'low-sim-scoped', similarity: 0.01, score: 10 });
    const profile = getRetrievalProfile('balanced');

    expect(applyRankingEligibility(
      'What is my favorite color?',
      [noisy],
      { retrievalProfileSettings: profile },
      { sourceSite: 'gmail' },
    ).triggered).toBe(false);
    expect(applyRankingEligibility(
      'What is my favorite color?',
      [noisy],
      { retrievalProfileSettings: profile },
      { referenceTime: new Date('2026-01-01T00:00:00.000Z') },
    ).triggered).toBe(false);
  });
});

describe('resolveRecallBypass', () => {
  it.each([
    ['What database do I use?', 'simple'],
    ['What database do I currently use?', 'multi-hop'],
    ['What did I use before switching?', 'complex'],
  ] as const)('pins temporal-state bypass for %s', (query, expectedLabel) => {
    const label = classifyQueryDetailed(query).label;

    expect(label).toBe(expectedLabel);
    expect(resolveRecallBypass(query, label, {})).toBe('temporal-state-query');
  });
});

describe('isAggregationQuery', () => {
  it.each(['how many projects am I working on', 'how much did I spend', 'what is the total cost', 'list all my meetings'])(
    'detects aggregation pattern: %s',
    (query) => {
      expect(isAggregationQuery(query)).toBe(true);
    },
  );

  it('rejects non-aggregation queries', () => {
    expect(isAggregationQuery('how did the architecture change')).toBe(false);
  });
});
