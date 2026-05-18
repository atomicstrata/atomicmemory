/**
 * Unit tests for composite memory grouping.
 * Validates clustering, synthesis, and L1 overview generation for composites.
 */

import { describe, it, expect, beforeEach } from 'vitest';

// Must mock config before importing the module under test
import { vi } from 'vitest';
vi.mock('../../config.js', () => ({
  config: {
    compositeGroupingEnabled: true,
    compositeMinClusterSize: 2,
    compositeMaxClusterSize: 3,
    compositeSimilarityThreshold: 0.55,
  },
}));

import { buildComposites, type CompositeInput } from '../composite-grouping.js';

/** Create a fake embedding vector (unit-normalized). */
function fakeEmbedding(seed: number, dim: number = 8): number[] {
  const raw = Array.from({ length: dim }, (_, i) => Math.sin(seed * (i + 1)));
  const norm = Math.sqrt(raw.reduce((s, v) => s + v * v, 0));
  return raw.map((v) => v / norm);
}

/** Create a cluster of similar embeddings by adding small perturbations. */
function similarEmbeddings(seed: number, count: number, dim: number = 8): number[][] {
  const base = fakeEmbedding(seed, dim);
  return Array.from({ length: count }, (_, i) => {
    const perturbed = base.map((v, j) => v + (i * 0.01 * Math.cos(j)));
    const norm = Math.sqrt(perturbed.reduce((s, v) => s + v * v, 0));
    return perturbed.map((v) => v / norm);
  });
}

describe('buildComposites', () => {
  it('groups similar facts into a composite', () => {
    const embeddings = similarEmbeddings(1, 3);
    const facts: CompositeInput[] = [
      { memoryId: 'a', content: 'User prefers TypeScript for all projects.', embedding: embeddings[0], importance: 0.8, keywords: ['TypeScript'], headline: 'Prefers TypeScript' },
      { memoryId: 'b', content: 'User uses strict TypeScript configuration with no any types.', embedding: embeddings[1], importance: 0.7, keywords: ['TypeScript', 'strict'], headline: 'Strict TypeScript config' },
      { memoryId: 'c', content: 'User configures ESLint with TypeScript parser.', embedding: embeddings[2], importance: 0.5, keywords: ['ESLint', 'TypeScript'], headline: 'ESLint TypeScript setup' },
    ];

    const composites = buildComposites(facts);

    expect(composites.length).toBe(1);
    const composite = composites[0];
    expect(composite.memberMemoryIds).toHaveLength(3);
    expect(composite.memberMemoryIds).toContain('a');
    expect(composite.memberMemoryIds).toContain('b');
    expect(composite.memberMemoryIds).toContain('c');
    expect(composite.importance).toBe(0.8);
    expect(composite.headline).toBe('Prefers TypeScript');
    expect(composite.content).toContain('TypeScript');
    expect(composite.keywords).toContain('TypeScript');
    expect(composite.keywords).toContain('ESLint');
    expect(composite.keywords).toContain('strict');
  });

  it('produces a non-empty L1 overview when joined content exceeds truncation threshold', () => {
    const embeddings = similarEmbeddings(2, 3);
    // Multi-sentence facts so the joined content has >3 sentences within the
    // compositeMaxClusterSize cap (3 facts × 2 sentences = 6 sentences joined).
    const facts: CompositeInput[] = [
      { memoryId: 'a', content: 'User is building a React application. It tracks personal finances.', embedding: embeddings[0], importance: 0.7, keywords: ['React'], headline: 'Finance tracker' },
      { memoryId: 'b', content: 'The backend uses Supabase. It provides the database layer.', embedding: embeddings[1], importance: 0.6, keywords: ['Supabase'], headline: 'Supabase backend' },
      { memoryId: 'c', content: 'Tailwind CSS handles styling. The project uses utility classes.', embedding: embeddings[2], importance: 0.5, keywords: ['Tailwind'], headline: 'Tailwind styling' },
    ];

    const composites = buildComposites(facts);

    expect(composites.length).toBe(1);
    const composite = composites[0];
    // 6 sentences joined; generateL1Overview truncates to first 3
    expect(composite.overview).not.toBe('');
    expect(composite.overview.length).toBeLessThan(composite.content.length);
  });

  it('separates unrelated facts into different clusters', () => {
    const techEmbeddings = similarEmbeddings(10, 2);
    const foodEmbeddings = similarEmbeddings(99, 2);
    const facts: CompositeInput[] = [
      { memoryId: 'a', content: 'User prefers Vim for code editing.', embedding: techEmbeddings[0], importance: 0.7, keywords: ['Vim'], headline: 'Uses Vim' },
      { memoryId: 'b', content: 'User configures Vim with Lua-based plugins.', embedding: techEmbeddings[1], importance: 0.5, keywords: ['Vim', 'Lua'], headline: 'Vim Lua plugins' },
      { memoryId: 'c', content: 'User enjoys Italian cuisine, especially pasta.', embedding: foodEmbeddings[0], importance: 0.3, keywords: ['Italian'], headline: 'Likes Italian food' },
      { memoryId: 'd', content: 'User cooks homemade pasta every weekend.', embedding: foodEmbeddings[1], importance: 0.3, keywords: ['pasta'], headline: 'Weekend pasta' },
    ];

    const composites = buildComposites(facts);

    expect(composites.length).toBe(2);
    const memberSets = composites.map((c) => new Set(c.memberMemoryIds));
    const techCluster = memberSets.find((s) => s.has('a'));
    const foodCluster = memberSets.find((s) => s.has('c'));
    expect(techCluster).toBeDefined();
    expect(foodCluster).toBeDefined();
    expect(techCluster!.has('b')).toBe(true);
    expect(foodCluster!.has('d')).toBe(true);
  });

  it('skips singletons (clusters with only 1 member)', () => {
    const embeddings1 = similarEmbeddings(1, 2);
    const loneEmbedding = fakeEmbedding(50);
    const facts: CompositeInput[] = [
      { memoryId: 'a', content: 'Fact A about topic one.', embedding: embeddings1[0], importance: 0.5, keywords: [], headline: 'Fact A' },
      { memoryId: 'b', content: 'Fact B about topic one.', embedding: embeddings1[1], importance: 0.5, keywords: [], headline: 'Fact B' },
      { memoryId: 'c', content: 'Completely different isolated fact.', embedding: loneEmbedding, importance: 0.5, keywords: [], headline: 'Isolated' },
    ];

    const composites = buildComposites(facts);

    expect(composites.length).toBe(1);
    expect(composites[0].memberMemoryIds).not.toContain('c');
  });

  it('caps cluster size at compositeMaxClusterSize', () => {
    // 5 highly similar facts — without the cap all 5 would land in one cluster.
    // With compositeMaxClusterSize=3 the first cluster fills to 3 and the
    // remaining 2 spill into a second cluster (which meets minClusterSize=2).
    const embeddings = similarEmbeddings(7, 5);
    const facts: CompositeInput[] = embeddings.map((emb, i) => ({
      memoryId: String.fromCharCode(97 + i),
      content: `Similar fact number ${i + 1} about the same topic.`,
      embedding: emb,
      importance: 0.5,
      keywords: ['topic'],
      headline: `Fact ${i + 1}`,
    }));

    const composites = buildComposites(facts);

    // Every composite must respect the cap
    for (const composite of composites) {
      expect(composite.memberMemoryIds.length).toBeLessThanOrEqual(3);
    }
    // All 5 facts should still be accounted for across composites
    const allMembers = composites.flatMap((c) => c.memberMemoryIds);
    expect(allMembers.sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('returns empty array when fewer facts than minClusterSize', () => {
    const facts: CompositeInput[] = [
      { memoryId: 'a', content: 'Single fact.', embedding: fakeEmbedding(1), importance: 0.5, keywords: [], headline: 'Single' },
    ];

    const composites = buildComposites(facts);
    expect(composites).toEqual([]);
  });

  it('deduplicates keywords across member facts', () => {
    const embeddings = similarEmbeddings(3, 2);
    const facts: CompositeInput[] = [
      { memoryId: 'a', content: 'Uses React and TypeScript.', embedding: embeddings[0], importance: 0.5, keywords: ['React', 'TypeScript'], headline: 'React TS' },
      { memoryId: 'b', content: 'Prefers React hooks pattern.', embedding: embeddings[1], importance: 0.5, keywords: ['React', 'hooks'], headline: 'React hooks' },
    ];

    const composites = buildComposites(facts);

    expect(composites.length).toBe(1);
    const kwLower = composites[0].keywords.map((k) => k.toLowerCase());
    const reactCount = kwLower.filter((k) => k === 'react').length;
    expect(reactCount).toBe(1);
  });
});
