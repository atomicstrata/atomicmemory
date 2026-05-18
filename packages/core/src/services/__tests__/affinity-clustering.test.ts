/**
 * Unit tests for affinity-based memory clustering.
 * Tests pairwise affinity, temporal proximity, pair finding,
 * and greedy cluster formation.
 */

import { describe, expect, it } from 'vitest';
import type { ClusterableMemory } from '../affinity-clustering.js';
import {
  computeAffinity,
  computeTemporalProximity,
  findAffinePairs,
  formClusters,
  DEFAULT_AFFINITY_CONFIG,
} from '../affinity-clustering.js';

function makeMem(overrides: Partial<ClusterableMemory> = {}): ClusterableMemory {
  return {
    id: 'mem-1',
    embedding: [1, 0, 0],
    createdAt: new Date('2026-01-15T12:00:00Z'),
    content: 'Test memory content',
    importance: 0.5,
    ...overrides,
  };
}

describe('computeTemporalProximity', () => {
  it('returns 1.0 for identical timestamps', () => {
    const t = new Date('2026-01-15T12:00:00Z');
    expect(computeTemporalProximity(t, t)).toBeCloseTo(1.0);
  });

  it('decays with time distance', () => {
    const t1 = new Date('2026-01-15T12:00:00Z');
    const t2 = new Date('2026-01-15T22:00:00Z');
    const prox = computeTemporalProximity(t1, t2);
    expect(prox).toBeGreaterThan(0);
    expect(prox).toBeLessThan(1);
  });

  it('decays faster with higher lambda', () => {
    const t1 = new Date('2026-01-15T12:00:00Z');
    const t2 = new Date('2026-01-16T12:00:00Z');
    const slow = computeTemporalProximity(t1, t2, 0.05);
    const fast = computeTemporalProximity(t1, t2, 0.5);
    expect(slow).toBeGreaterThan(fast);
  });

  it('is symmetric', () => {
    const t1 = new Date('2026-01-15T12:00:00Z');
    const t2 = new Date('2026-01-16T12:00:00Z');
    expect(computeTemporalProximity(t1, t2)).toBeCloseTo(
      computeTemporalProximity(t2, t1),
    );
  });
});

describe('computeAffinity', () => {
  it('returns high score for identical memories', () => {
    const a = makeMem({ id: 'a' });
    const b = makeMem({ id: 'b' });
    const pair = computeAffinity(a, b);
    expect(pair.score).toBeCloseTo(1.0);
    expect(pair.idA).toBe('a');
    expect(pair.idB).toBe('b');
  });

  it('returns low score for dissimilar memories', () => {
    const a = makeMem({ id: 'a', embedding: [1, 0, 0] });
    const b = makeMem({
      id: 'b',
      embedding: [0, 1, 0],
      createdAt: new Date('2026-06-01T00:00:00Z'),
    });
    const pair = computeAffinity(a, b);
    expect(pair.score).toBeLessThan(0.5);
  });

  it('weights semantic vs temporal via beta', () => {
    const a = makeMem({ id: 'a', embedding: [1, 0] });
    const b = makeMem({ id: 'b', embedding: [0, 1] });
    const semanticOnly = computeAffinity(a, b, {
      ...DEFAULT_AFFINITY_CONFIG,
      beta: 1.0,
    });
    const temporalOnly = computeAffinity(a, b, {
      ...DEFAULT_AFFINITY_CONFIG,
      beta: 0.0,
    });
    expect(semanticOnly.score).toBeCloseTo(0.0);
    expect(temporalOnly.score).toBeCloseTo(1.0);
  });
});

describe('findAffinePairs', () => {
  it('returns empty for no memories', () => {
    expect(findAffinePairs([])).toEqual([]);
  });

  it('returns empty for single memory', () => {
    expect(findAffinePairs([makeMem()])).toEqual([]);
  });

  it('finds pairs above threshold', () => {
    const memories = [
      makeMem({ id: 'a', embedding: [1, 0, 0] }),
      makeMem({ id: 'b', embedding: [0.99, 0.1, 0] }),
      makeMem({
        id: 'c',
        embedding: [0, 1, 0],
        createdAt: new Date('2026-06-01'),
      }),
    ];
    const pairs = findAffinePairs(memories);
    const abPair = pairs.find(
      (p) => (p.idA === 'a' && p.idB === 'b') || (p.idA === 'b' && p.idB === 'a'),
    );
    expect(abPair).toBeDefined();
  });

  it('sorts pairs by score descending', () => {
    const memories = [
      makeMem({ id: 'a', embedding: [1, 0] }),
      makeMem({ id: 'b', embedding: [0.99, 0.1] }),
      makeMem({ id: 'c', embedding: [0.98, 0.2] }),
    ];
    const config = { ...DEFAULT_AFFINITY_CONFIG, threshold: 0.5 };
    const pairs = findAffinePairs(memories, config);
    for (let i = 1; i < pairs.length; i++) {
      expect(pairs[i - 1].score).toBeGreaterThanOrEqual(pairs[i].score);
    }
  });
});

describe('formClusters', () => {
  it('returns empty for no memories', () => {
    expect(formClusters([])).toEqual([]);
  });

  it('returns empty when no cluster meets min size', () => {
    const memories = [
      makeMem({ id: 'a' }),
      makeMem({ id: 'b', embedding: [0, 1, 0] }),
    ];
    const clusters = formClusters(memories);
    expect(clusters).toEqual([]);
  });

  it('forms cluster from similar memories', () => {
    const base = new Date('2026-01-15T12:00:00Z');
    const memories = [
      makeMem({ id: 'a', embedding: [1, 0, 0], createdAt: base, importance: 0.9 }),
      makeMem({ id: 'b', embedding: [0.99, 0.1, 0], createdAt: base, importance: 0.8 }),
      makeMem({ id: 'c', embedding: [0.98, 0.15, 0], createdAt: base, importance: 0.7 }),
    ];
    const clusters = formClusters(memories);
    expect(clusters.length).toBeGreaterThanOrEqual(1);
    expect(clusters[0].members.length).toBeGreaterThanOrEqual(3);
    expect(clusters[0].avgAffinity).toBeGreaterThan(0);
  });

  it('assigns each memory to at most one cluster', () => {
    const base = new Date('2026-01-15T12:00:00Z');
    const memories = Array.from({ length: 6 }, (_, i) =>
      makeMem({
        id: `m${i}`,
        embedding: [1, 0.01 * i, 0],
        createdAt: base,
        importance: 1 - i * 0.1,
      }),
    );
    const clusters = formClusters(memories);
    const allIds = clusters.flatMap((c) => c.members.map((m) => m.id));
    const uniqueIds = new Set(allIds);
    expect(uniqueIds.size).toBe(allIds.length);
  });

  it('respects custom min cluster size', () => {
    const base = new Date('2026-01-15T12:00:00Z');
    const memories = [
      makeMem({ id: 'a', embedding: [1, 0], createdAt: base }),
      makeMem({ id: 'b', embedding: [0.99, 0.1], createdAt: base }),
      makeMem({ id: 'c', embedding: [0.98, 0.15], createdAt: base }),
    ];
    const config = { ...DEFAULT_AFFINITY_CONFIG, minClusterSize: 5 };
    const clusters = formClusters(memories, config);
    expect(clusters).toEqual([]);
  });
});
