/**
 * Unit tests for Personalized PageRank (PPR) link expansion.
 * Tests the pure algorithm without database dependencies.
 */

import { describe, it, expect } from 'vitest';
import { runPPR } from '../ppr.js';

function makeAdjacency(edges: [string, string][]): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  for (const [a, b] of edges) {
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a)!.add(b);
    adj.get(b)!.add(a);
  }
  return adj;
}

describe('runPPR', () => {
  it('returns empty for empty seeds', () => {
    const adj = makeAdjacency([['a', 'b']]);
    const result = runPPR(adj, new Map());
    expect(result.scores.size).toBe(0);
    expect(result.iterations).toBe(0);
  });

  it('returns empty for empty adjacency', () => {
    const result = runPPR(new Map(), new Map([['a', 0.9]]));
    expect(result.scores.size).toBe(0);
    expect(result.iterations).toBe(0);
  });

  it('propagates score from seed to direct neighbor', () => {
    const adj = makeAdjacency([['seed', 'neighbor']]);
    const result = runPPR(adj, new Map([['seed', 1.0]]));

    expect(result.scores.has('neighbor')).toBe(true);
    expect(result.scores.get('neighbor')!).toBeGreaterThan(0);
    expect(result.iterations).toBeGreaterThan(0);
  });

  it('scores direct neighbors higher than 2-hop neighbors', () => {
    const adj = makeAdjacency([
      ['seed', 'hop1'],
      ['hop1', 'hop2'],
    ]);
    const result = runPPR(adj, new Map([['seed', 1.0]]));

    const hop1Score = result.scores.get('hop1') ?? 0;
    const hop2Score = result.scores.get('hop2') ?? 0;

    expect(hop1Score).toBeGreaterThan(hop2Score);
    expect(hop2Score).toBeGreaterThan(0);
  });

  it('concentrates more score on densely-connected nodes', () => {
    const adj = makeAdjacency([
      ['seed', 'dense'],
      ['seed', 'sparse'],
      ['dense', 'extra1'],
      ['dense', 'extra2'],
      ['extra1', 'dense'],
      ['extra2', 'dense'],
    ]);
    const result = runPPR(adj, new Map([['seed', 1.0]]));

    const denseScore = result.scores.get('dense') ?? 0;
    const sparseScore = result.scores.get('sparse') ?? 0;

    expect(denseScore).toBeGreaterThan(sparseScore);
  });

  it('distributes score across multiple seeds', () => {
    const adj = makeAdjacency([
      ['s1', 'shared'],
      ['s2', 'shared'],
    ]);
    const result = runPPR(adj, new Map([['s1', 0.8], ['s2', 0.6]]));

    expect(result.scores.has('shared')).toBe(true);
    expect(result.scores.get('shared')!).toBeGreaterThan(0);
  });

  it('excludes seed nodes from expansion scores', () => {
    const adj = makeAdjacency([['seed', 'neighbor']]);
    const result = runPPR(adj, new Map([['seed', 1.0]]));

    expect(result.scores.has('seed')).toBe(false);
    expect(result.scores.has('neighbor')).toBe(true);
  });

  it('converges within max iterations', () => {
    const adj = makeAdjacency([
      ['s', 'a'], ['a', 'b'], ['b', 'c'], ['c', 'd'],
    ]);
    const result = runPPR(adj, new Map([['s', 1.0]]), { maxIterations: 50 });

    expect(result.iterations).toBeLessThanOrEqual(50);
    expect(result.iterations).toBeGreaterThan(1);
  });

  it('higher damping increases score propagation depth', () => {
    const adj = makeAdjacency([
      ['s', 'a'], ['a', 'b'], ['b', 'c'],
    ]);
    const lowDamp = runPPR(adj, new Map([['s', 1.0]]), { damping: 0.3 });
    const highDamp = runPPR(adj, new Map([['s', 1.0]]), { damping: 0.8 });

    const lowC = lowDamp.scores.get('c') ?? 0;
    const highC = highDamp.scores.get('c') ?? 0;

    expect(highC).toBeGreaterThan(lowC);
  });

  it('handles disconnected components gracefully', () => {
    const adj = makeAdjacency([
      ['seed', 'connected'],
      ['isolated1', 'isolated2'],
    ]);
    const result = runPPR(adj, new Map([['seed', 1.0]]));

    expect(result.scores.has('connected')).toBe(true);
    expect(result.scores.get('isolated1') ?? 0).toBe(0);
    expect(result.scores.get('isolated2') ?? 0).toBe(0);
  });
});
