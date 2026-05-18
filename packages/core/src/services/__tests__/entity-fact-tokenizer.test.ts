/**
 * Unit tests for the EAI (Sprint 4 — Task C) query→lookup tokenizer.
 * Verifies stopword filtering, short-word filtering, number extraction,
 * and the cap that keeps the SQL parameter list small.
 */

import { describe, expect, it } from 'vitest';
import { extractLookupTokens } from '../episode-fetcher.js';

describe('extractLookupTokens', () => {
  it('drops stopwords and short words', () => {
    const tokens = extractLookupTokens('How many problems did I do?');
    expect(tokens).toContain('problems');
    expect(tokens).not.toContain('did');
    expect(tokens).not.toContain('i');
  });

  it('extracts numbers', () => {
    const tokens = extractLookupTokens('When did I hit 25 problems?');
    expect(tokens).toContain('25');
    expect(tokens).toContain('problems');
  });

  it('caps at 8 tokens', () => {
    const tokens = extractLookupTokens('a b c apple banana cherry date elderberry fig grape honeydew');
    expect(tokens.length).toBeLessThanOrEqual(8);
  });

  it('returns empty for stopwords-only query', () => {
    const tokens = extractLookupTokens('what is the and or in');
    expect(tokens).toEqual([]);
  });
});
