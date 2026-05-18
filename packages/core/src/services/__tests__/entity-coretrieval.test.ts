/**
 * Tests for entity name co-retrieval: extracting named entities from queries
 * and the co-retrieval logic for pulling in all linked memories.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../config.js', () => ({
  config: {
    queryAugmentationMaxEntities: 5,
    queryAugmentationMinSimilarity: 0.4,
    queryExpansionMinSimilarity: 0.5,
  },
}));
vi.mock('../llm.js', () => ({ llm: { chat: vi.fn() } }));
vi.mock('../embedding.js', () => ({ embedText: vi.fn() }));

const { extractNamedEntityCandidates } = await import('../query-expansion.js');

describe('extractNamedEntityCandidates', () => {
  it('extracts multi-word capitalized sequences', () => {
    const result = extractNamedEntityCandidates(
      'What plan is Acme Corp on?',
    );
    expect(result).toContain('Acme Corp');
  });

  it('extracts multiple named entities', () => {
    const result = extractNamedEntityCandidates(
      'Has Sarah Bradley talked to Acme Corp about the New York office?',
    );
    expect(result).toContain('Sarah Bradley');
    expect(result).toContain('Acme Corp');
    expect(result).toContain('New York');
  });

  it('extracts single capitalized words that are not sentence starters', () => {
    const result = extractNamedEntityCandidates(
      'How should I configure Redis for caching?',
    );
    expect(result).toContain('Redis');
  });

  it('does not extract sentence-starting words', () => {
    const result = extractNamedEntityCandidates(
      'What is the best approach?',
    );
    expect(result).not.toContain('What');
  });

  it('extracts quoted strings', () => {
    const result = extractNamedEntityCandidates(
      'Tell me about the "Golden Gate Bridge" project',
    );
    expect(result).toContain('Golden Gate Bridge');
  });

  it('returns empty for queries with no named entities', () => {
    const result = extractNamedEntityCandidates(
      'how do i set up the development environment?',
    );
    expect(result).toHaveLength(0);
  });

  it('does not extract single-character capitalized words', () => {
    const result = extractNamedEntityCandidates(
      'What does A mean in this context?',
    );
    expect(result).not.toContain('A');
  });

  it('handles mixed case queries', () => {
    const result = extractNamedEntityCandidates(
      'What technical issues has Acme Corp reported recently?',
    );
    expect(result).toContain('Acme Corp');
  });

  it('extracts entities after punctuation', () => {
    const result = extractNamedEntityCandidates(
      'After the meeting, did Tom Bradley send the report?',
    );
    expect(result).toContain('Tom Bradley');
  });

  it('deduplicates candidates', () => {
    const result = extractNamedEntityCandidates(
      'Is Acme Corp happy? Ask Acme Corp directly.',
    );
    const acmeCount = result.filter((c) => c === 'Acme Corp').length;
    expect(acmeCount).toBe(1);
  });
});
