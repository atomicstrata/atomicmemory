/**
 * Tests for `buildInjection` budget-constrained metadata.
 *
 * Verifies the v5 `meta.budget_constrained` contract: true iff a larger
 * token budget would have shown more memory content (excluded memories,
 * suppressed tier promotions, or hidden query-term reveals). False when
 * the budget did not affect package content.
 */

import { describe, expect, it } from 'vitest';
import { buildInjection } from '../retrieval-format.js';
import { createSearchResult } from './test-fixtures.js';
import type { SearchResult } from '../../db/repository-types.js';

function makeResult(overrides: Partial<SearchResult> = {}) {
  return createSearchResult({
    id: 'm-default',
    content: 'User prefers TypeScript over JavaScript for new projects.',
    summary: 'Prefers TypeScript',
    overview: 'User prefers TypeScript over JavaScript for new projects.',
    similarity: 0.85,
    score: 0.85,
    importance: 0.7,
    source_site: 'chatgpt',
    namespace: 'tools',
    ...overrides,
  });
}

function makeItalyVisitMemories() {
  return [
    makeResult({
      id: 'a', score: 0.9, summary: 'short A',
      content: 'Caroline visited Italy with friends. ' + 'X'.repeat(600),
      created_at: new Date('2026-01-15'),
    }),
    makeResult({
      id: 'b', score: 0.8, summary: 'short B',
      content: 'Caroline visited Italy again last spring. ' + 'X'.repeat(600),
      created_at: new Date('2026-02-15'),
    }),
    makeResult({
      id: 'c', score: 0.7, summary: 'short C',
      content: 'Caroline visited Italy on holiday. ' + 'X'.repeat(600),
      created_at: new Date('2026-03-15'),
    }),
  ];
}

describe('buildInjection budget-constrained signal', () => {
  it('reports false in flat mode regardless of memory count', () => {
    const result = buildInjection([makeResult()], 'q', 'flat', 50);
    expect(result.budgetConstrained).toBe(false);
    expect(result.includedMemories).toHaveLength(1);
  });

  it('reports false on empty input', () => {
    const result = buildInjection([], 'q', 'tiered', 50);
    expect(result.budgetConstrained).toBe(false);
    expect(result.includedMemories).toEqual([]);
    expect(result.injectionText).toBe('');
  });

  it('reports false in tiered mode when the budget fits everything richly', () => {
    const memories = [
      makeResult({ id: 'a', score: 0.9 }),
      makeResult({ id: 'b', score: 0.8 }),
    ];
    const result = buildInjection(memories, 'q', 'tiered', 100000);
    expect(result.budgetConstrained).toBe(false);
    expect(result.includedMemories.map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('treats omitted tokenBudget as unbounded in tiered mode', () => {
    const memories = [
      makeResult({ id: 'a', summary: 'A'.repeat(4000), content: 'A'.repeat(4000), score: 0.9 }),
      makeResult({ id: 'b', summary: 'B'.repeat(4000), content: 'B'.repeat(4000), score: 0.8 }),
      makeResult({ id: 'c', summary: 'C'.repeat(4000), content: 'C'.repeat(4000), score: 0.7 }),
    ];
    const result = buildInjection(memories, 'q', 'tiered');
    expect(result.budgetConstrained).toBe(false);
    expect(result.includedMemories.map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });

  it('reports true when the L0 sum exceeds the budget and the tail is excluded', () => {
    const memories = [
      makeResult({ id: 'a', summary: 'A'.repeat(80), score: 0.9 }),
      makeResult({ id: 'b', summary: 'B'.repeat(80), score: 0.8 }),
      makeResult({ id: 'c', summary: 'C'.repeat(80), score: 0.7 }),
    ];
    const result = buildInjection(memories, 'q', 'tiered', 25);
    expect(result.budgetConstrained).toBe(true);
    expect(result.includedMemories.length).toBeLessThan(memories.length);
  });

  it('reports true when L0 fits but L2/L1 promotions are blocked solely by budget', () => {
    const memories = [
      makeResult({ id: 'a', summary: 'short', overview: 'O'.repeat(80), content: 'C'.repeat(400), score: 0.9 }),
      makeResult({ id: 'b', summary: 'short', overview: 'O'.repeat(80), content: 'C'.repeat(400), score: 0.8 }),
    ];
    const result = buildInjection(memories, 'q', 'tiered', 30);
    expect(result.budgetConstrained).toBe(true);
    expect(result.includedMemories.map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('returns empty injection when no memory survives L0-fit', () => {
    const memories = [
      makeResult({ id: 'a', summary: 'A'.repeat(400), score: 0.9 }),
    ];
    const result = buildInjection(memories, 'q', 'tiered', 5);
    expect(result.injectionText).toBe('');
    expect(result.includedMemories).toEqual([]);
    expect(result.budgetConstrained).toBe(true);
  });

  it('estimatedContextTokens never exceeds tokenBudget under tight budgets', () => {
    const memories = [
      makeResult({ id: 'a', summary: 'A'.repeat(40), overview: 'O'.repeat(120), content: 'C'.repeat(800), score: 0.9 }),
      makeResult({ id: 'b', summary: 'B'.repeat(40), overview: 'O'.repeat(120), content: 'C'.repeat(800), score: 0.8 }),
    ];
    const tokenBudget = 60;
    const result = buildInjection(memories, 'q', 'tiered', tokenBudget);
    expect(result.estimatedContextTokens ?? 0).toBeLessThanOrEqual(tokenBudget);
  });

  it('preserves non-empty injection when an over-large temporal-endpoint reservation would otherwise blank content', () => {
    const memories = makeItalyVisitMemories();
    const result = buildInjection(memories, 'When did Caroline visit Italy recently?', 'tiered', 30);
    expect(result.injectionText).not.toBe('');
    expect(result.includedMemories.length).toBeGreaterThan(0);
    expect(result.budgetConstrained).toBe(true);
  });

  it('tierAssignments and injectionText reflect only includedMemories under tight budget', () => {
    const memories = [
      makeResult({ id: 'top-keep', summary: 'KEEP_A'.repeat(8), score: 0.9 }),
      makeResult({ id: 'mid-drop', summary: 'DROP_B'.repeat(8), score: 0.8 }),
      makeResult({ id: 'tail-drop', summary: 'DROP_C'.repeat(8), score: 0.7 }),
    ];
    const result = buildInjection(memories, 'q', 'tiered', 18);

    expect(result.includedMemories.length).toBeLessThan(memories.length);
    const includedIds = new Set(result.includedMemories.map((m) => m.id));
    for (const a of result.tierAssignments ?? []) {
      expect(includedIds.has(a.memoryId)).toBe(true);
    }
    for (const excludedId of memories.map((m) => m.id).filter((id) => !includedIds.has(id))) {
      expect(result.injectionText).not.toContain(excludedId);
    }
  });

  it('preserves rank order on tail exclusion (drops tail, never the top hit)', () => {
    const memories = [
      makeResult({ id: 'top-large', summary: 'LARGE'.repeat(20), score: 0.95 }),
      makeResult({ id: 'mid-tiny', summary: 'X', score: 0.7 }),
      makeResult({ id: 'tail-tiny', summary: 'Y', score: 0.5 }),
    ];
    const result = buildInjection(memories, 'q', 'tiered', 30);
    if (result.includedMemories.length > 0) {
      expect(result.includedMemories[0].id).toBe('top-large');
    }
  });

  it('reservation cap is rank-aware: top memory still fits when later memories are smaller', () => {
    const memories = [
      makeResult({ id: 'top', summary: 'T'.repeat(80), score: 0.95 }),
      makeResult({ id: 'mid', summary: 'X', score: 0.5 }),
    ];
    const result = buildInjection(memories, 'When did this happen recently?', 'tiered', 30);
    expect(result.injectionText).not.toBe('');
    expect(result.includedMemories.length).toBeGreaterThan(0);
    expect(result.includedMemories[0].id).toBe('top');
  });

  it('estimatedContextTokens never exceeds budget when extra-block reservation is capped', () => {
    const memories = makeItalyVisitMemories();
    const tokenBudget = 30;
    const result = buildInjection(memories, 'When did Caroline visit Italy recently?', 'tiered', tokenBudget);
    expect(result.estimatedContextTokens ?? 0).toBeLessThanOrEqual(tokenBudget);
    expect(result.budgetConstrained).toBe(true);
  });

  it('omits the temporal extra block from injection text when it would overflow the budget', () => {
    const memories = [
      makeResult({
        id: 'a', score: 0.9, summary: 'short',
        content: 'Caroline visited Italy. ' + 'X'.repeat(600),
        created_at: new Date('2026-01-15'),
      }),
      makeResult({
        id: 'b', score: 0.8, summary: 'short',
        content: 'Caroline visited Italy. ' + 'X'.repeat(600),
        created_at: new Date('2026-02-15'),
      }),
    ];
    const result = buildInjection(memories, 'When did Caroline visit Italy recently?', 'tiered', 30);
    expect(result.injectionText).not.toContain('Temporal evidence candidates');
    expect(result.injectionText).not.toContain('Timeline:');
    expect(result.budgetConstrained).toBe(true);
  });

  it('reclaims reserved budget on extra-block omission via a deterministic second pass', () => {
    // Three short-L0 temporal memories whose content is long enough
    // that the extra block from any single included memory still
    // overflows budget=50. First pass: reservation eats budget, only
    // top fits at L0, extra block computed from { top } is still too
    // large → omit. Second pass with full budget must reclaim the
    // reserved tokens and admit all three.
    const filler = 'X'.repeat(800);
    const memories = [
      makeResult({
        id: 'a', score: 0.95, summary: 'A',
        content: `Caroline visited Italy in January. ${filler}`,
        created_at: new Date('2026-01-15'),
      }),
      makeResult({
        id: 'b', score: 0.9, summary: 'B',
        content: `Caroline visited Italy in February. ${filler}`,
        created_at: new Date('2026-02-15'),
      }),
      makeResult({
        id: 'c', score: 0.85, summary: 'C',
        content: `Caroline visited Italy in March. ${filler}`,
        created_at: new Date('2026-03-15'),
      }),
    ];
    const result = buildInjection(memories, 'When did Caroline visit Italy recently?', 'tiered', 50);
    expect(result.includedMemories.map((m) => m.id)).toEqual(['a', 'b', 'c']);
    expect(result.budgetConstrained).toBe(true);
    expect(result.injectionText).not.toContain('Temporal evidence candidates');
    expect(result.injectionText).not.toContain('Timeline:');
  });
});
