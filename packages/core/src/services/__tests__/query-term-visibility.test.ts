/**
 * Tests for `preserveQueryTermVisibility` tier-selection policy.
 *
 * Verifies the contract that visibility upgrades pick the affordable
 * tier that reveals the most missing query terms (tie-broken by lower
 * extra tokens) rather than the first revealing tier seen in iteration
 * order, and that exhausted-budget reveals are flagged as
 * `budgetBlockedVisibilityIds`.
 */

import { describe, expect, it } from 'vitest';
import { preserveQueryTermVisibility } from '../query-term-visibility.js';
import type { TierAssignment } from '../tiered-loading.js';
import { estimateTokens } from '../tiered-loading.js';
import { createSearchResult } from './test-fixtures.js';

interface VisibilityFixture {
  summary: string;
  overview: string;
  content: string;
  query: string;
  budget?: number;
}

function runVisibility(fixture: VisibilityFixture) {
  const memory = createSearchResult({
    id: 'mem',
    summary: fixture.summary,
    overview: fixture.overview,
    content: fixture.content,
  });
  const assignment: TierAssignment = {
    memoryId: 'mem',
    tier: 'L0',
    estimatedTokens: estimateTokens(memory.summary),
  };
  const result = preserveQueryTermVisibility([memory], [assignment], fixture.query, fixture.budget ?? 1000);
  return { result, assignment };
}

describe('preserveQueryTermVisibility tier selection', () => {
  it('picks the tier that reveals the most missing terms when several tiers are affordable', () => {
    const { result } = runVisibility({
      summary: 'general background note',
      overview: 'Caroline attended a workshop in Vermont.',
      content: 'Caroline attended a counseling workshop in Vermont about grief therapy.',
      query: 'workshop counseling grief therapy',
    });
    expect(result.assignments[0].tier).toBe('L2');
    expect(result.budgetBlockedVisibilityIds).toEqual([]);
  });

  it('breaks reveal-count ties by lower extra tokens (prefers L1 over L2 when both reveal the same terms)', () => {
    const { result } = runVisibility({
      summary: 'no match here',
      overview: 'Caroline attended a workshop yesterday.',
      content: 'Caroline attended a workshop yesterday. ' + 'X'.repeat(2000),
      query: 'workshop',
    });
    expect(result.assignments[0].tier).toBe('L1');
  });

  it('flags budgetBlockedVisibilityIds when every revealing tier exceeds the remaining budget', () => {
    const { result } = runVisibility({
      summary: 'no match here',
      overview: 'Caroline attended a counseling workshop. ' + 'Y'.repeat(400),
      content: 'Caroline attended a counseling workshop. ' + 'Z'.repeat(800),
      query: 'workshop counseling',
      budget: 5,
    });
    expect(result.assignments[0].tier).toBe('L0');
    expect(result.budgetBlockedVisibilityIds).toEqual(['mem']);
  });

  it('applies a zero-extra-token upgrade when a richer tier reveals a missing term at the same token cost', () => {
    // summary and overview both 15 chars -> ceil(15*0.25) = 4 tokens,
    // so the L1 upgrade carries extra=0. content is much longer, so
    // L2 also reveals "workshop" but at a strictly higher token cost.
    // The reveal-maximizing + lower-extra-tokens policy must select L1.
    const { result, assignment } = runVisibility({
      summary: 'alpha beta gamm',
      overview: 'go workshop foo',
      content: 'go workshop foo and a lot more text after it',
      query: 'workshop',
    });
    expect(result.assignments[0].tier).toBe('L1');
    expect(result.assignments[0].estimatedTokens).toBe(assignment.estimatedTokens);
    expect(result.budgetBlockedVisibilityIds).toEqual([]);
  });

  it('leaves assignments unchanged when no missing query term is present in any richer tier', () => {
    const { result } = runVisibility({
      summary: 'an unrelated note about cats',
      overview: 'still about cats',
      content: 'cats cats cats',
      query: 'workshop',
    });
    expect(result.assignments[0].tier).toBe('L0');
    expect(result.budgetBlockedVisibilityIds).toEqual([]);
  });
});
