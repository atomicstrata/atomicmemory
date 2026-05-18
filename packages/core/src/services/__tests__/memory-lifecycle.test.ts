/**
 * Unit tests for memory-lifecycle.ts.
 * Tests decay cycle retention scoring, candidate evaluation,
 * memory count cap checking, and recommendation logic.
 */

import { describe, it, expect } from 'vitest';
import {
  computeRetentionScore,
  evaluateDecayCandidates,
  checkMemoryCap,
  DEFAULT_DECAY_CONFIG,
  type DecayConfig,
  type CapConfig,
} from '../memory-lifecycle.js';
import { createMemoryRow } from './test-fixtures.js';

function makeMemory(overrides: Partial<import('../../db/repository-types.js').MemoryRow> & { id: string }) {
  return createMemoryRow({
    content: `Memory ${overrides.id}`,
    source_site: 'claude.ai',
    created_at: new Date('2026-01-01'),
    last_accessed_at: new Date('2026-01-01'),
    ...overrides,
  });
}

const NOW = new Date('2026-03-18T12:00:00Z');
const DAYS_MS = 24 * 60 * 60 * 1000;

describe('computeRetentionScore', () => {
  it('returns high score for recently accessed, important memory', () => {
    const memory = makeMemory({
      id: '1',
      importance: 0.9,
      last_accessed_at: new Date(NOW.getTime() - 1 * DAYS_MS),
      access_count: 5,
    });
    const score = computeRetentionScore(memory, NOW, DEFAULT_DECAY_CONFIG);
    expect(score).toBeGreaterThan(0.7);
  });

  it('returns low score for old, unimportant, never-accessed memory', () => {
    const memory = makeMemory({
      id: '2',
      importance: 0.1,
      last_accessed_at: new Date(NOW.getTime() - 90 * DAYS_MS),
      access_count: 0,
    });
    const score = computeRetentionScore(memory, NOW, DEFAULT_DECAY_CONFIG);
    expect(score).toBeLessThan(0.15);
  });

  it('decays over time following exponential curve', () => {
    const base = {
      id: '3',
      importance: 0.5,
      access_count: 0,
    };
    const fresh = makeMemory({ ...base, last_accessed_at: new Date(NOW.getTime() - 1 * DAYS_MS) });
    const week = makeMemory({ ...base, last_accessed_at: new Date(NOW.getTime() - 7 * DAYS_MS) });
    const month = makeMemory({ ...base, last_accessed_at: new Date(NOW.getTime() - 30 * DAYS_MS) });
    const quarter = makeMemory({ ...base, last_accessed_at: new Date(NOW.getTime() - 90 * DAYS_MS) });

    const scores = [fresh, week, month, quarter].map(
      (m) => computeRetentionScore(m, NOW, DEFAULT_DECAY_CONFIG),
    );

    expect(scores[0]).toBeGreaterThan(scores[1]);
    expect(scores[1]).toBeGreaterThan(scores[2]);
    expect(scores[2]).toBeGreaterThan(scores[3]);
  });

  it('importance protects memories from decay', () => {
    const highImportance = makeMemory({
      id: '4',
      importance: 1.0,
      last_accessed_at: new Date(NOW.getTime() - 60 * DAYS_MS),
      access_count: 0,
    });
    const lowImportance = makeMemory({
      id: '5',
      importance: 0.1,
      last_accessed_at: new Date(NOW.getTime() - 60 * DAYS_MS),
      access_count: 0,
    });

    const highScore = computeRetentionScore(highImportance, NOW, DEFAULT_DECAY_CONFIG);
    const lowScore = computeRetentionScore(lowImportance, NOW, DEFAULT_DECAY_CONFIG);
    expect(highScore).toBeGreaterThan(lowScore);
    expect(highScore).toBeGreaterThan(DEFAULT_DECAY_CONFIG.retentionThreshold);
  });

  it('access count boosts retention', () => {
    const base = {
      id: '6',
      importance: 0.3,
      last_accessed_at: new Date(NOW.getTime() - 45 * DAYS_MS),
    };
    const neverAccessed = makeMemory({ ...base, access_count: 0 });
    const frequentlyAccessed = makeMemory({ ...base, access_count: 10 });

    const neverScore = computeRetentionScore(neverAccessed, NOW, DEFAULT_DECAY_CONFIG);
    const freqScore = computeRetentionScore(frequentlyAccessed, NOW, DEFAULT_DECAY_CONFIG);
    expect(freqScore).toBeGreaterThan(neverScore);
  });

  it('access count caps at 10 for normalization', () => {
    const base = {
      id: '7',
      importance: 0.5,
      last_accessed_at: new Date(NOW.getTime() - 30 * DAYS_MS),
    };
    const ten = makeMemory({ ...base, access_count: 10 });
    const hundred = makeMemory({ ...base, access_count: 100 });

    const tenScore = computeRetentionScore(ten, NOW, DEFAULT_DECAY_CONFIG);
    const hundredScore = computeRetentionScore(hundred, NOW, DEFAULT_DECAY_CONFIG);
    expect(tenScore).toBe(hundredScore);
  });

  it('trust score multiplies into retention', () => {
    const trusted = makeMemory({
      id: '8',
      importance: 0.5,
      last_accessed_at: new Date(NOW.getTime() - 30 * DAYS_MS),
      access_count: 0,
      trust_score: 1.0,
    });
    const untrusted = makeMemory({
      id: '9',
      importance: 0.5,
      last_accessed_at: new Date(NOW.getTime() - 30 * DAYS_MS),
      access_count: 0,
      trust_score: 0.3,
    });

    const trustedScore = computeRetentionScore(trusted, NOW, DEFAULT_DECAY_CONFIG);
    const untrustedScore = computeRetentionScore(untrusted, NOW, DEFAULT_DECAY_CONFIG);
    expect(untrustedScore).toBeCloseTo(trustedScore * 0.3, 5);
  });
});

describe('evaluateDecayCandidates', () => {
  it('returns empty candidates when all memories are healthy', () => {
    const memories = [
      makeMemory({ id: '1', importance: 0.8, last_accessed_at: new Date(NOW.getTime() - 1 * DAYS_MS), access_count: 5 }),
      makeMemory({ id: '2', importance: 0.9, last_accessed_at: new Date(NOW.getTime() - 2 * DAYS_MS), access_count: 3 }),
    ];
    const result = evaluateDecayCandidates(memories, NOW);
    expect(result.candidatesForArchival).toHaveLength(0);
  });

  it('identifies stale low-importance memories for archival', () => {
    const memories = [
      makeMemory({ id: 'healthy', importance: 0.9, last_accessed_at: new Date(NOW.getTime() - 5 * DAYS_MS), access_count: 3 }),
      makeMemory({ id: 'stale', importance: 0.05, last_accessed_at: new Date(NOW.getTime() - 90 * DAYS_MS), access_count: 0 }),
    ];
    const result = evaluateDecayCandidates(memories, NOW);
    expect(result.candidatesForArchival.length).toBeGreaterThanOrEqual(1);
    expect(result.candidatesForArchival[0].id).toBe('stale');
  });

  it('respects minimum age — skips young memories', () => {
    const memories = [
      makeMemory({
        id: 'young',
        importance: 0.01,
        last_accessed_at: new Date(NOW.getTime() - 1 * DAYS_MS),
        access_count: 0,
        created_at: new Date(NOW.getTime() - 3 * DAYS_MS),
      }),
    ];
    const result = evaluateDecayCandidates(memories, NOW);
    expect(result.memoriesEvaluated).toBe(0);
    expect(result.candidatesForArchival).toHaveLength(0);
  });

  it('sorts candidates by retention score ascending', () => {
    const memories = [
      makeMemory({ id: 'low', importance: 0.05, last_accessed_at: new Date(NOW.getTime() - 120 * DAYS_MS), access_count: 0 }),
      makeMemory({ id: 'medium', importance: 0.1, last_accessed_at: new Date(NOW.getTime() - 90 * DAYS_MS), access_count: 0 }),
    ];
    const result = evaluateDecayCandidates(memories, NOW);
    if (result.candidatesForArchival.length >= 2) {
      expect(result.candidatesForArchival[0].retentionScore)
        .toBeLessThanOrEqual(result.candidatesForArchival[1].retentionScore);
    }
  });

  it('computes average retention score', () => {
    const memories = [
      makeMemory({ id: '1', importance: 0.5, last_accessed_at: new Date(NOW.getTime() - 30 * DAYS_MS), access_count: 0 }),
      makeMemory({ id: '2', importance: 0.5, last_accessed_at: new Date(NOW.getTime() - 30 * DAYS_MS), access_count: 0 }),
    ];
    const result = evaluateDecayCandidates(memories, NOW);
    expect(result.avgRetentionScore).toBeGreaterThan(0);
    expect(result.avgRetentionScore).toBeLessThan(1);
  });

  it('handles empty memory list', () => {
    const result = evaluateDecayCandidates([], NOW);
    expect(result.memoriesEvaluated).toBe(0);
    expect(result.candidatesForArchival).toHaveLength(0);
    expect(result.avgRetentionScore).toBe(0);
  });

  it('custom config overrides default threshold', () => {
    const memories = [
      makeMemory({ id: '1', importance: 0.3, last_accessed_at: new Date(NOW.getTime() - 60 * DAYS_MS), access_count: 0 }),
    ];
    const strict: DecayConfig = { ...DEFAULT_DECAY_CONFIG, retentionThreshold: 0.5 };
    const lenient: DecayConfig = { ...DEFAULT_DECAY_CONFIG, retentionThreshold: 0.05 };

    const strictResult = evaluateDecayCandidates(memories, NOW, strict);
    const lenientResult = evaluateDecayCandidates(memories, NOW, lenient);
    expect(strictResult.candidatesForArchival.length)
      .toBeGreaterThanOrEqual(lenientResult.candidatesForArchival.length);
  });

  it('includes days since access in candidate output', () => {
    const memories = [
      makeMemory({ id: '1', importance: 0.01, last_accessed_at: new Date(NOW.getTime() - 60 * DAYS_MS), access_count: 0 }),
    ];
    const result = evaluateDecayCandidates(memories, NOW);
    if (result.candidatesForArchival.length > 0) {
      expect(result.candidatesForArchival[0].daysSinceAccess).toBeCloseTo(60, 0);
    }
  });
});

describe('checkMemoryCap', () => {
  it('returns ok when well below cap', () => {
    const result = checkMemoryCap(100);
    expect(result.status).toBe('ok');
    expect(result.recommendation).toBe('none');
  });

  it('returns warn when approaching cap', () => {
    const result = checkMemoryCap(4200);
    expect(result.status).toBe('warn');
    expect(result.recommendation).toBe('consolidate');
  });

  it('returns exceeded when at cap', () => {
    const result = checkMemoryCap(5000);
    expect(result.status).toBe('exceeded');
    expect(result.recommendation).toBe('decay');
  });

  it('recommends consolidate-and-decay when significantly over cap', () => {
    const result = checkMemoryCap(6500);
    expect(result.status).toBe('exceeded');
    expect(result.recommendation).toBe('consolidate-and-decay');
  });

  it('computes correct usage ratio', () => {
    const result = checkMemoryCap(2500);
    expect(result.usageRatio).toBe(0.5);
  });

  it('respects custom cap config', () => {
    const small: CapConfig = { maxMemories: 100, warnRatio: 0.8 };
    const result = checkMemoryCap(85, small);
    expect(result.status).toBe('warn');
    expect(result.maxMemories).toBe(100);
  });

  it('returns ok at exactly warn boundary minus one', () => {
    const result = checkMemoryCap(3999);
    expect(result.status).toBe('ok');
  });

  it('returns warn at exactly warn boundary', () => {
    const result = checkMemoryCap(4000);
    expect(result.status).toBe('warn');
  });

  it('returns exceeded at exactly max', () => {
    const result = checkMemoryCap(5000);
    expect(result.status).toBe('exceeded');
    expect(result.usageRatio).toBe(1.0);
  });

  it('handles zero memories', () => {
    const result = checkMemoryCap(0);
    expect(result.status).toBe('ok');
    expect(result.usageRatio).toBe(0);
    expect(result.recommendation).toBe('none');
  });
});
