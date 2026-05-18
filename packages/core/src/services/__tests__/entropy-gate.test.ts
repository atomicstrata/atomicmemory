/**
 * Unit tests for entropy-aware write gating.
 * Tests entity novelty, semantic novelty, combined scoring,
 * and threshold-based acceptance.
 */

import { describe, expect, it } from 'vitest';
import {
  computeEntropyScore,
  computeEntityNovelty,
  computeSemanticNovelty,
  cosineSimilarity,
  DEFAULT_ENTROPY_CONFIG,
} from '../entropy-gate.js';

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1.0);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0.0);
  });

  it('returns -1 for opposite vectors', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1.0);
  });

  it('returns 0 for mismatched lengths', () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });

  it('returns 0 for empty vectors', () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it('returns 0 for zero-magnitude vector', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });

  it('handles non-unit vectors correctly', () => {
    const sim = cosineSimilarity([3, 4], [6, 8]);
    expect(sim).toBeCloseTo(1.0);
  });
});

describe('computeEntityNovelty', () => {
  it('returns 1.0 when no entities exist', () => {
    expect(computeEntityNovelty([], new Set())).toBe(1.0);
  });

  it('returns 1.0 when all entities are new', () => {
    const result = computeEntityNovelty(
      ['alice', 'bob'],
      new Set(['charlie']),
    );
    expect(result).toBe(1.0);
  });

  it('returns 0.0 when all entities already exist', () => {
    const result = computeEntityNovelty(
      ['alice', 'bob'],
      new Set(['alice', 'bob', 'charlie']),
    );
    expect(result).toBe(0.0);
  });

  it('returns correct ratio for partial overlap', () => {
    const result = computeEntityNovelty(
      ['alice', 'bob', 'charlie', 'dave'],
      new Set(['alice', 'bob']),
    );
    expect(result).toBe(0.5);
  });
});

describe('computeSemanticNovelty', () => {
  it('returns 1.0 when no previous embedding exists', () => {
    expect(computeSemanticNovelty([0.5, 0.5], null)).toBe(1.0);
  });

  it('returns 1.0 when previous embedding is empty', () => {
    expect(computeSemanticNovelty([0.5, 0.5], [])).toBe(1.0);
  });

  it('returns 0.0 for identical embeddings', () => {
    const emb = [0.1, 0.2, 0.3];
    expect(computeSemanticNovelty(emb, emb)).toBeCloseTo(0.0);
  });

  it('returns ~1.0 for orthogonal embeddings', () => {
    expect(computeSemanticNovelty([1, 0], [0, 1])).toBeCloseTo(1.0);
  });
});

describe('computeEntropyScore', () => {
  it('accepts high-novelty input', () => {
    const result = computeEntropyScore({
      windowEntities: ['new-entity'],
      existingEntities: new Set(),
      windowEmbedding: [1, 0],
      previousEmbedding: [0, 1],
    });
    expect(result.accepted).toBe(true);
    expect(result.score).toBeCloseTo(1.0);
    expect(result.entityNovelty).toBe(1.0);
    expect(result.semanticNovelty).toBeCloseTo(1.0);
  });

  it('rejects low-novelty input', () => {
    const emb = [0.5, 0.5, 0.5];
    const result = computeEntropyScore({
      windowEntities: ['known'],
      existingEntities: new Set(['known']),
      windowEmbedding: emb,
      previousEmbedding: emb,
    });
    expect(result.accepted).toBe(false);
    expect(result.score).toBeCloseTo(0.0);
  });

  it('uses custom config threshold', () => {
    const emb = [0.5, 0.5];
    const result = computeEntropyScore(
      {
        windowEntities: ['a'],
        existingEntities: new Set(['a']),
        windowEmbedding: emb,
        previousEmbedding: emb,
      },
      { threshold: 0.0, alpha: 0.5 },
    );
    expect(result.accepted).toBe(true);
  });

  it('respects alpha weighting toward entities', () => {
    const result = computeEntropyScore(
      {
        windowEntities: ['new'],
        existingEntities: new Set(),
        windowEmbedding: [1, 0],
        previousEmbedding: [1, 0],
      },
      { ...DEFAULT_ENTROPY_CONFIG, alpha: 1.0 },
    );
    expect(result.score).toBeCloseTo(1.0);
  });

  it('respects alpha weighting toward semantics', () => {
    const result = computeEntropyScore(
      {
        windowEntities: ['known'],
        existingEntities: new Set(['known']),
        windowEmbedding: [1, 0],
        previousEmbedding: [0, 1],
      },
      { ...DEFAULT_ENTROPY_CONFIG, alpha: 0.0 },
    );
    expect(result.score).toBeCloseTo(1.0);
  });
});
