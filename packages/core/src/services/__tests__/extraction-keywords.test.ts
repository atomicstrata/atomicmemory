/**
 * Unicode-safe keyword derivation for compact extraction backfill.
 */

import { describe, expect, it } from 'vitest';
import { deriveKeywordsFromFact } from '../extraction-keywords.js';

describe('deriveKeywordsFromFact — Unicode', () => {
  it('keeps accented Latin place names intact', () => {
    const keywords = deriveKeywordsFromFact('User lives in Zürich.');
    expect(keywords).toContain('Zürich');
    expect(keywords).not.toContain('lives');
    expect(keywords).not.toContain('rich');
  });

  it('keeps multi-word accented proper nouns together', () => {
    const keywords = deriveKeywordsFromFact('El usuario vive en São Paulo.');
    expect(keywords).toContain('São Paulo');
    expect(keywords).not.toContain('El');
    expect(keywords).not.toContain('Paulo');
  });

  it('derives non-Latin content words when patterns are sparse', () => {
    const keywords = deriveKeywordsFromFact('用户住在北京。');
    expect(keywords.length).toBeGreaterThan(0);
    expect(keywords.some((term) => term.includes('北京') || term.includes('用户'))).toBe(true);
  });
});
