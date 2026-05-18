/**
 * Unit tests for the consolidation service.
 * Tests the bridge between repository data and affinity clustering.
 */

import { describe, expect, it } from 'vitest';
import { toClusterCandidate, type ClusterCandidate, type ConsolidationResult } from '../consolidation-service.js';
import type { MemoryCluster, ClusterableMemory } from '../affinity-clustering.js';

describe('ConsolidationResult shape', () => {
  it('has expected fields', () => {
    const result: ConsolidationResult = {
      memoriesScanned: 10,
      clustersFound: 2,
      memoriesInClusters: 6,
      clusters: [],
    };
    expect(result.memoriesScanned).toBe(10);
    expect(result.clustersFound).toBe(2);
    expect(result.memoriesInClusters).toBe(6);
    expect(result.clusters).toEqual([]);
  });
});

describe('ClusterCandidate shape', () => {
  it('has expected fields', () => {
    const candidate: ClusterCandidate = {
      memberIds: ['a', 'b', 'c'],
      memberContents: ['content a', 'content b', 'content c'],
      avgAffinity: 0.9,
      memberCount: 3,
    };
    expect(candidate.memberIds).toHaveLength(3);
    expect(candidate.memberContents).toHaveLength(3);
    expect(candidate.avgAffinity).toBe(0.9);
    expect(candidate.memberCount).toBe(3);
  });
});

describe('MemoryCluster to ClusterCandidate mapping', () => {
  it('preserves member information', () => {
    const members: ClusterableMemory[] = [
      { id: 'a', embedding: [1, 0], createdAt: new Date(), content: 'fact a', importance: 0.8 },
      { id: 'b', embedding: [0.9, 0.1], createdAt: new Date(), content: 'fact b', importance: 0.7 },
      { id: 'c', embedding: [0.95, 0.05], createdAt: new Date(), content: 'fact c', importance: 0.6 },
    ];
    const cluster: MemoryCluster = { members, avgAffinity: 0.92 };
    const candidate = toClusterCandidate(cluster);
    expect(candidate.memberIds).toEqual(['a', 'b', 'c']);
    expect(candidate.memberContents).toEqual(['fact a', 'fact b', 'fact c']);
    expect(candidate.avgAffinity).toBe(0.92);
    expect(candidate.memberCount).toBe(3);
  });
});
