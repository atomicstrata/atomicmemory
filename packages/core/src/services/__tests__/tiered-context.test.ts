/**
 * Unit tests for tiered context loading (L0/L1/L2).
 * Tests pure functions for tier generation, assignment, and formatting.
 */

import { describe, it, expect } from 'vitest';
import {
  generateL1Overview,
  buildTieredContent,
  assignTiers,
  formatTieredInjection,
  estimateTokens,
  calculateTokenSavings,
  DEFAULT_TIER_THRESHOLDS,
  type TierAssignment,
} from '../tiered-context.js';

describe('generateL1Overview', () => {
  it('returns full content for short text (<=2 sentences)', () => {
    expect(generateL1Overview('User likes cats.')).toBe('User likes cats.');
  });

  it('returns full content for exactly two sentences', () => {
    const text = 'First sentence. Second sentence.';
    expect(generateL1Overview(text)).toBe(text);
  });

  it('extracts first 3 sentences from longer content', () => {
    const text = 'First fact. Second fact. Third fact. Fourth fact. Fifth fact.';
    const overview = generateL1Overview(text);
    expect(overview).toBe('First fact. Second fact. Third fact.');
  });

  it('falls back to 2 sentences if 3 exceed 300 chars', () => {
    const long = 'A'.repeat(120) + '. ' + 'B'.repeat(120) + '. ' + 'C'.repeat(120) + '.';
    const overview = generateL1Overview(long);
    const sentenceCount = overview.split(/(?<=[.!?])\s+/).filter(Boolean).length;
    expect(sentenceCount).toBeLessThanOrEqual(2);
  });
});

describe('buildTieredContent', () => {
  it('uses summary as L0 when available', () => {
    const result = buildTieredContent('Full content here.', 'Summary');
    expect(result.l0).toBe('Summary');
    expect(result.l2).toBe('Full content here.');
  });

  it('generates headline as L0 fallback when summary is empty', () => {
    const content = 'A very long content string that goes on and on with many words beyond ten total words here';
    const result = buildTieredContent(content, '');
    expect(result.l0).toContain('...');
    expect(result.l0.split(/\s+/).length).toBeLessThanOrEqual(11);
  });

  it('sets L1 to null when content is short enough to equal overview', () => {
    const result = buildTieredContent('Short fact.', 'Short');
    expect(result.l1).toBeNull();
  });

  it('generates L1 overview for multi-sentence content', () => {
    const content = 'First sentence. Second sentence. Third sentence. Fourth sentence.';
    const result = buildTieredContent(content, 'Headline');
    expect(result.l1).not.toBeNull();
    expect(result.l1).toBe('First sentence. Second sentence. Third sentence.');
  });

  it('preserves full content as L2', () => {
    const content = 'Complete original content with all details.';
    const result = buildTieredContent(content, 'Headline');
    expect(result.l2).toBe(content);
  });
});

describe('assignTiers', () => {
  const makeMemory = (id: string, score: number, contentLength: number = 100) => ({
    id,
    score,
    content: 'S1. S2. S3. ' + 'x'.repeat(contentLength),
    summary: `Summary of ${id}`,
  });

  it('returns empty array for empty input', () => {
    expect(assignTiers([], 1000)).toEqual([]);
  });

  it('assigns L2 to high-score memories within budget', () => {
    const result = assignTiers([makeMemory('a', 0.9)], 10000);
    expect(result[0].tier).toBe('L2');
  });

  it('assigns L0 to low-score memories', () => {
    const result = assignTiers([makeMemory('a', 0.1)], 10000);
    expect(result[0].tier).toBe('L0');
  });

  it('assigns L1 to mid-score memories', () => {
    const result = assignTiers([makeMemory('a', 0.5, 200)], 10000);
    expect(result[0].tier).toBe('L1');
  });

  it('downgrades tier when budget is exhausted', () => {
    const memories = [
      makeMemory('a', 0.9, 400),
      makeMemory('b', 0.8, 400),
      makeMemory('c', 0.7, 400),
    ];
    const tinyBudget = 5;
    const result = assignTiers(memories, tinyBudget);
    const hasDowngrade = result.some((r) => r.tier !== 'L2');
    expect(hasDowngrade).toBe(true);
  });

  it('preserves original order in output', () => {
    const memories = [
      makeMemory('first', 0.3),
      makeMemory('second', 0.9),
      makeMemory('third', 0.6),
    ];
    const result = assignTiers(memories, 10000);
    expect(result[0].memoryId).toBe('first');
    expect(result[1].memoryId).toBe('second');
    expect(result[2].memoryId).toBe('third');
  });

  it('uses custom thresholds when provided', () => {
    const strictThresholds = { l2MinScore: 0.95, l1MinScore: 0.80 };
    const result = assignTiers([makeMemory('a', 0.9, 200)], 10000, strictThresholds);
    expect(result[0].tier).not.toBe('L2');
  });

  it('total tokens stay within budget', () => {
    const memories = Array.from({ length: 10 }, (_, i) =>
      makeMemory(`mem-${i}`, 0.5 + (i * 0.05), 300),
    );
    const budget = 500;
    const result = assignTiers(memories, budget);
    const totalTokens = result.reduce((sum, r) => sum + r.estimatedTokens, 0);
    expect(totalTokens).toBeLessThanOrEqual(budget + 20);
  });
});

describe('formatTieredInjection', () => {
  const makeAssignment = (
    id: string,
    tier: 'L0' | 'L1' | 'L2',
    content: string,
  ): TierAssignment => ({
    memoryId: id,
    tier,
    content,
    estimatedTokens: estimateTokens(content),
  });

  it('returns empty string for empty assignments', () => {
    expect(formatTieredInjection([])).toBe('');
  });

  it('includes mode="tiered" attribute', () => {
    const result = formatTieredInjection([makeAssignment('a', 'L2', 'Full')]);
    expect(result).toContain('mode="tiered"');
  });

  it('includes tier attribute on each memory', () => {
    const result = formatTieredInjection([
      makeAssignment('a', 'L0', 'Summary'),
      makeAssignment('b', 'L2', 'Full content'),
    ]);
    expect(result).toContain('tier="L0"');
    expect(result).toContain('tier="L2"');
  });

  it('includes tier counts in header', () => {
    const result = formatTieredInjection([
      makeAssignment('a', 'L0', 'S1'),
      makeAssignment('b', 'L1', 'S2'),
      makeAssignment('c', 'L2', 'S3'),
    ]);
    expect(result).toContain('tiers="L0:1,L1:1,L2:1"');
  });

  it('includes expand_ids for non-L2 memories', () => {
    const result = formatTieredInjection([
      makeAssignment('expandable', 'L0', 'Summary'),
      makeAssignment('full', 'L2', 'Content'),
    ]);
    expect(result).toContain('expand_ids="expandable"');
    expect(result).not.toContain('expand_ids="full"');
  });

  it('omits expand hint when all memories are L2', () => {
    const result = formatTieredInjection([makeAssignment('a', 'L2', 'Full')]);
    expect(result).not.toContain('expand_hint');
  });

  it('includes expand hint when some memories are not L2', () => {
    const result = formatTieredInjection([makeAssignment('a', 'L0', 'Short')]);
    expect(result).toContain('expand_hint');
  });

  it('escapes XML special characters', () => {
    const result = formatTieredInjection([makeAssignment('a', 'L2', 'x < y & z > w')]);
    expect(result).toContain('x &lt; y &amp; z &gt; w');
  });
});

describe('estimateTokens', () => {
  it('returns at least 1 for empty string', () => {
    expect(estimateTokens('')).toBe(1);
  });

  it('estimates ~4 chars per token', () => {
    const text = 'a'.repeat(100);
    expect(estimateTokens(text)).toBe(25);
  });
});

describe('calculateTokenSavings', () => {
  it('returns 0 for empty inputs', () => {
    expect(calculateTokenSavings([], [])).toBe(0);
  });

  it('returns 0 when all assignments are L2', () => {
    const assignments: TierAssignment[] = [{
      memoryId: 'a',
      tier: 'L2',
      content: 'x'.repeat(100),
      estimatedTokens: 25,
    }];
    expect(calculateTokenSavings(assignments, [100])).toBe(0);
  });

  it('returns positive savings when tiers reduce tokens', () => {
    const assignments: TierAssignment[] = [{
      memoryId: 'a',
      tier: 'L0',
      content: 'Short',
      estimatedTokens: 2,
    }];
    const savings = calculateTokenSavings(assignments, [400]);
    expect(savings).toBeGreaterThan(0);
  });
});

describe('DEFAULT_TIER_THRESHOLDS', () => {
  it('has L2 threshold higher than L1', () => {
    expect(DEFAULT_TIER_THRESHOLDS.l2MinScore).toBeGreaterThan(DEFAULT_TIER_THRESHOLDS.l1MinScore);
  });

  it('thresholds are between 0 and 1', () => {
    expect(DEFAULT_TIER_THRESHOLDS.l2MinScore).toBeGreaterThan(0);
    expect(DEFAULT_TIER_THRESHOLDS.l2MinScore).toBeLessThanOrEqual(1);
    expect(DEFAULT_TIER_THRESHOLDS.l1MinScore).toBeGreaterThan(0);
    expect(DEFAULT_TIER_THRESHOLDS.l1MinScore).toBeLessThanOrEqual(1);
  });
});
