/**
 * Unit tests for abstract-query retrieval policy decisions.
 */

import { describe, expect, it } from 'vitest';
import {
  isAbstractQuery,
  prefersAbstractAwareRetrieval,
  shouldUseAbstractHybridFallback,
} from '../abstract-query-policy.js';

describe('isAbstractQuery', () => {
  it('detects why/how rationale questions', () => {
    expect(isAbstractQuery('Why did Caroline choose the adoption agency?')).toBe(true);
    expect(isAbstractQuery('How does Melanie prioritize self-care?')).toBe(true);
  });

  it('detects meaning-oriented what questions', () => {
    expect(isAbstractQuery('What did Melanie realize after the charity race?')).toBe(true);
    expect(isAbstractQuery("What does Caroline's necklace symbolize?")).toBe(true);
  });

  it('ignores direct slot-lookup questions', () => {
    expect(isAbstractQuery('What did Caroline research?')).toBe(false);
    expect(isAbstractQuery('When did Melanie paint a sunrise?')).toBe(false);
  });
});

describe('abstract-aware retrieval toggles', () => {
  it('only enables abstract-aware logic for the explicit mode', () => {
    expect(prefersAbstractAwareRetrieval('abstract-aware', 'Why did she choose it?')).toBe(true);
    expect(prefersAbstractAwareRetrieval('tiered', 'Why did she choose it?')).toBe(false);
  });

  it('only enables hybrid fallback after an empty semantic result set', () => {
    expect(shouldUseAbstractHybridFallback('abstract-aware', 'Why did she choose it?', 0)).toBe(true);
    expect(shouldUseAbstractHybridFallback('abstract-aware', 'Why did she choose it?', 2)).toBe(false);
    expect(shouldUseAbstractHybridFallback('tiered', 'Why did she choose it?', 0)).toBe(false);
  });
});
