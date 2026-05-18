/**
 * Unit tests for tiered context loading (L0/L1/L2).
 * Tests token estimation, tier selection, budget allocation,
 * and content fallback behavior.
 */

import { describe, expect, it } from 'vitest';
import {
  estimateTokens,
  getContentAtTier,
  selectTierForBudget,
  assignTiers,
  buildTieredPayload,
} from '../tiered-loading.js';
import { createSearchResult } from './test-fixtures.js';

function makeResult(overrides: Partial<import('../../db/repository-types.js').SearchResult> = {}) {
  return createSearchResult({
    id: 'mem-1',
    content: 'User prefers TypeScript over JavaScript for all new projects due to better type safety and IDE support.',
    embedding: [0.1], importance: 0.7, source_site: 'chatgpt',
    summary: 'Prefers TypeScript over JavaScript',
    overview: 'User prefers TypeScript over JavaScript for new projects. Cites type safety and IDE support as primary reasons.',
    created_at: new Date('2026-01-15'), access_count: 1,
    similarity: 0.85, score: 0.9,
    ...overrides,
  });
}

describe('estimateTokens', () => {
  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('estimates tokens based on character count', () => {
    const text = 'Hello world';
    const tokens = estimateTokens(text);
    expect(tokens).toBe(3);
  });

  it('rounds up to nearest integer', () => {
    expect(estimateTokens('ab')).toBe(1);
  });
});

describe('getContentAtTier', () => {
  it('returns summary at L0', () => {
    const result = makeResult();
    expect(getContentAtTier(result, 'L0')).toBe('Prefers TypeScript over JavaScript');
  });

  it('falls back to headline when summary is empty at L0', () => {
    const result = makeResult({ summary: '' });
    const content = getContentAtTier(result, 'L0');
    expect(content).toContain('...');
    expect(content.split(/\s+/).length).toBeLessThanOrEqual(11);
  });

  it('returns overview at L1', () => {
    const result = makeResult();
    expect(getContentAtTier(result, 'L1')).toContain('Cites type safety');
  });

  it('falls back to full content when overview is empty at L1', () => {
    const result = makeResult({ overview: '' });
    expect(getContentAtTier(result, 'L1')).toBe(result.content);
  });

  it('returns full content at L2', () => {
    const result = makeResult();
    expect(getContentAtTier(result, 'L2')).toBe(result.content);
  });
});

describe('selectTierForBudget', () => {
  it('selects L2 when budget is sufficient', () => {
    const result = makeResult();
    const assignment = selectTierForBudget(result, 1000);
    expect(assignment.tier).toBe('L2');
  });

  it('selects L1 when L2 exceeds budget but L1 fits', () => {
    const result = makeResult({
      content: 'A'.repeat(400),
      overview: 'B'.repeat(80),
    });
    const assignment = selectTierForBudget(result, 50);
    expect(assignment.tier).toBe('L1');
  });

  it('selects L0 when both L2 and L1 exceed budget', () => {
    const result = makeResult({
      content: 'A'.repeat(400),
      overview: 'B'.repeat(400),
      summary: 'Short summary',
    });
    const assignment = selectTierForBudget(result, 5);
    expect(assignment.tier).toBe('L0');
  });

  it('falls back to L0 when overview is empty and L2 exceeds budget', () => {
    const result = makeResult({
      content: 'A'.repeat(400),
      overview: '',
      summary: 'Short',
    });
    const assignment = selectTierForBudget(result, 10);
    expect(assignment.tier).toBe('L0');
  });

  it('includes estimated token count', () => {
    const result = makeResult();
    const assignment = selectTierForBudget(result, 1000);
    expect(assignment.estimatedTokens).toBeGreaterThan(0);
  });
});

describe('assignTiers', () => {
  it('reserves L2 for the top slice only when budget is large', () => {
    const memories = [
      makeResult({ id: 'a', score: 0.9 }),
      makeResult({ id: 'b', score: 0.8 }),
      makeResult({ id: 'c', score: 0.7 }),
    ];
    const { assignments } = assignTiers(memories, 10000);
    expect(assignments).toHaveLength(3);
    expectTierOrder(assignments, ['L2', 'L1', 'L0']);
  });

  it('keeps supporting memories below L2 when budget is tight', () => {
    const memories = [
      makeResult({ id: 'a', content: 'A'.repeat(200), score: 0.9 }),
      makeResult({ id: 'b', content: 'B'.repeat(200), score: 0.8, overview: 'Short overview of B' }),
      makeResult({ id: 'c', content: 'C'.repeat(200), score: 0.7, summary: 'Summary C' }),
    ];
    const { assignments } = assignTiers(memories, 80);
    expectTierOrder(assignments, ['L2', 'L1', 'L0']);
  });

  it('tracks total tokens used', () => {
    const memories = [makeResult()];
    const { totalTokens, budgetUsed } = assignTiers(memories, 10000);
    expect(totalTokens).toBeGreaterThan(0);
    expect(budgetUsed).toBe(totalTokens);
  });

  it('returns empty assignments for empty input', () => {
    const { assignments, totalTokens } = assignTiers([], 1000);
    expect(assignments).toHaveLength(0);
    expect(totalTokens).toBe(0);
  });

  it('all L0 when budget is tiny', () => {
    const memories = [
      makeResult({ id: 'a', content: 'A'.repeat(400), summary: 'SA' }),
      makeResult({ id: 'b', content: 'B'.repeat(400), summary: 'SB' }),
    ];
    const { assignments } = assignTiers(memories, 5);
    expect(assignments.every((a) => a.tier === 'L0')).toBe(true);
  });

  it('uses L1 for non-top memories when budget allows', () => {
    const memories = [
      makeResult({ id: 'a', score: 0.9 }),
      makeResult({ id: 'b', score: 0.8 }),
      makeResult({ id: 'c', score: 0.7 }),
      makeResult({ id: 'd', score: 0.6 }),
    ];
    const { assignments } = assignTiers(memories, 300);
    expect(assignments[0].tier).toBe('L2');
    expect(assignments[1].tier).toBe('L1');
    expect(assignments[2].tier).toBe('L0');
    expect(assignments[3].tier).toBe('L0');
  });

  it('preserves a real L0 tail on larger result sets', () => {
    const memories = [
      makeResult({ id: 'a', score: 0.98 }),
      makeResult({ id: 'b', score: 0.92 }),
      makeResult({ id: 'c', score: 0.88 }),
      makeResult({ id: 'd', score: 0.84 }),
      makeResult({ id: 'e', score: 0.8 }),
      makeResult({ id: 'f', score: 0.76 }),
      makeResult({ id: 'g', score: 0.72 }),
      makeResult({ id: 'h', score: 0.68 }),
    ];
    const { assignments } = assignTiers(memories, 10000);
    expect(assignments.filter((a) => a.tier === 'L2')).toHaveLength(2);
    expect(assignments.filter((a) => a.tier === 'L1')).toHaveLength(2);
    expect(assignments.filter((a) => a.tier === 'L0')).toHaveLength(4);
  });

  it('forces a richer top hit for abstract-aware packaging when budget allows', () => {
    const memories = [
      makeResult({
        id: 'a',
        content: 'A'.repeat(120),
        overview: 'A'.repeat(36),
        summary: 'short',
      }),
      makeResult({
        id: 'b',
        content: 'B'.repeat(120),
        overview: 'B'.repeat(36),
        summary: 'tiny',
      }),
    ];
    const baseline = assignTiers(memories, 20);
    const abstractAware = assignTiers(memories, 20, { forceRichTopHit: true });
    expect(baseline.assignments[0].tier).toBe('L0');
    expect(abstractAware.assignments[0].tier).toBe('L1');
    expect(abstractAware.assignments[1].tier).toBe('L1');
  });
});

describe('buildTieredPayload', () => {
  it('returns content at assigned tier for each memory', () => {
    const memories = [
      makeResult({ id: 'a', summary: 'Summary A' }),
      makeResult({ id: 'b', overview: 'Overview B' }),
    ];
    const assignments = [
      { memoryId: 'a', tier: 'L0' as const, estimatedTokens: 5 },
      { memoryId: 'b', tier: 'L1' as const, estimatedTokens: 10 },
    ];
    const payload = buildTieredPayload(memories, assignments);
    expect(payload[0].tier).toBe('L0');
    expect(payload[0].content).toBe('Summary A');
    expect(payload[1].tier).toBe('L1');
    expect(payload[1].content).toBe('Overview B');
  });

  it('returns empty payload when no assignments are provided', () => {
    const memories = [makeResult({ id: 'a', summary: 'Fallback' })];
    const payload = buildTieredPayload(memories, []);
    expect(payload).toHaveLength(0);
  });

  it('throws when an assignment references a memory not in the input', () => {
    const memories = [makeResult({ id: 'a' })];
    const assignments = [{ memoryId: 'missing', tier: 'L0' as const, estimatedTokens: 5 }];
    expect(() => buildTieredPayload(memories, assignments)).toThrow(/missing/);
  });
});

/** Assert that assignments have the expected tier sequence. */
function expectTierOrder(assignments: Array<{ tier: string }>, expectedTiers: string[]) {
  for (let i = 0; i < expectedTiers.length; i++) {
    expect(assignments[i].tier).toBe(expectedTiers[i]);
  }
}

describe('assignTiers budget metadata', () => {
  it('returns empty constraint metadata when budget fits everything', () => {
    const memories = [
      makeResult({ id: 'a', score: 0.9 }),
      makeResult({ id: 'b', score: 0.8 }),
      makeResult({ id: 'c', score: 0.7 }),
    ];
    const result = assignTiers(memories, 10000);
    expect(result.includedMemories.map((m) => m.id)).toEqual(['a', 'b', 'c']);
    expect(result.excludedMemoryIds).toEqual([]);
    expect(result.budgetLimitedPromotionIds).toEqual([]);
  });

  it('excludes the L0-overflow tail when budget is tighter than the cumulative L0 sum', () => {
    const memories = [
      makeResult({ id: 'a', summary: 'A'.repeat(40) }),
      makeResult({ id: 'b', summary: 'B'.repeat(40) }),
      makeResult({ id: 'c', summary: 'C'.repeat(40) }),
    ];
    const result = assignTiers(memories, 25);
    expect(result.includedMemories.map((m) => m.id)).toEqual(['a', 'b']);
    expect(result.excludedMemoryIds).toEqual(['c']);
    expect(result.assignments).toHaveLength(2);
    expect(result.assignments.map((a) => a.memoryId)).toEqual(['a', 'b']);
  });

  it('records budget-blocked promotions when L0 fits but L1/L2 upgrades cannot', () => {
    const memories = [
      makeResult({ id: 'a', summary: 'short', overview: 'O'.repeat(80), content: 'C'.repeat(400), score: 0.9 }),
      makeResult({ id: 'b', summary: 'short', overview: 'O'.repeat(80), content: 'C'.repeat(400), score: 0.8 }),
    ];
    const result = assignTiers(memories, 30);
    expect(result.excludedMemoryIds).toEqual([]);
    expect(result.includedMemories.map((m) => m.id)).toEqual(['a', 'b']);
    expect(result.budgetLimitedPromotionIds).toContain('a');
  });

  it('does not record quota-only blocks (memory outside MAX_L2_MEMORIES window)', () => {
    const memories = Array.from({ length: 8 }, (_, i) =>
      makeResult({ id: `m${i}`, summary: `s${i}`, content: 'C'.repeat(40), score: 1 - i * 0.05 }),
    );
    const result = assignTiers(memories, 10000);
    // Memories ranked outside the top slice never enter the L2 promotion loop;
    // their L0 → L2/L1 demotion is policy, not budget.
    expect(result.budgetLimitedPromotionIds).toEqual([]);
    expect(result.excludedMemoryIds).toEqual([]);
  });

  it('keeps assignments / includedMemories index-aligned after L0-fit exclusion', () => {
    const memories = [
      makeResult({ id: 'a', summary: 'A'.repeat(40), score: 0.9 }),
      makeResult({ id: 'b', summary: 'B'.repeat(40), score: 0.8 }),
      makeResult({ id: 'c', summary: 'C'.repeat(40), score: 0.7 }),
    ];
    const result = assignTiers(memories, 25);
    for (let i = 0; i < result.includedMemories.length; i++) {
      expect(result.assignments[i].memoryId).toBe(result.includedMemories[i].id);
    }
  });
});
