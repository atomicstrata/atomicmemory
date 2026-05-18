/**
 * Unit tests for literal/list answer protection.
 *
 * These tests cover the default-off reranking guard used by targeted
 * LoCoMo-style list questions where exact named answers can be dropped by MMR.
 */

import { describe, expect, it } from 'vitest';
import { protectLiteralListAnswerCandidates } from '../literal-list-protection.js';
import { createSearchResult } from './test-fixtures.js';

function buildResult(id: string, content: string, score: number) {
  return createSearchResult({
    id,
    content,
    user_id: 'u1',
    memory_type: 'fact',
    network: 'experience',
    created_at: new Date('2023-07-06T00:00:00.000Z'),
    last_accessed_at: new Date('2023-07-06T00:00:00.000Z'),
    score,
  });
}

describe('protectLiteralListAnswerCandidates', () => {
  it('protects named pet-answer memories for pet-name questions', () => {
    const result = protectLiteralListAnswerCandidates(
      "What are Melanie's pets' names?",
      [
        buildResult('generic', 'Melanie likes animals and enjoys caring for them.', 0.9),
        buildResult('bailey', 'We got another cat named Bailey too.', 0.4),
      ],
      3,
    );

    expect(result.protectedIds).toEqual(['bailey']);
    expect(result.reasons).toContain('named-entity');
    expect(result.reasons).toContain('pet-domain');
    expect(result.results.find((item) => item.id === 'bailey')?.score).toBeGreaterThan(4);
  });

  it('protects quoted music-answer memories for artist-list questions', () => {
    const result = protectLiteralListAnswerCandidates(
      'What musical artists or bands has Melanie seen in concert?',
      [
        buildResult('playlist', 'Melanie has been listening to upbeat music lately.', 0.8),
        buildResult('summer', '"Summer Sounds" played an awesome pop song.', 0.5),
      ],
      3,
    );

    expect(result.protectedIds).toEqual(['summer']);
    expect(result.reasons).toContain('quoted-title');
    expect(result.reasons).toContain('music-domain');
    expect(result.reasons).toContain('performance-event');
  });

  it('prefers seen-live performer evidence over quoted song preferences', () => {
    const result = protectLiteralListAnswerCandidates(
      'What musical artists or bands has Melanie seen?',
      [
        buildResult('song', 'Melanie enjoys modern music, specifically Ed Sheeran song "Perfect".', 0.9),
        buildResult('summer', '"Summer Sounds"- The playing an awesome pop song got everyone dancing.', 0.4),
      ],
      1,
    );

    expect(result.protectedIds).toEqual(['summer']);
  });

  it('does nothing when the protection budget is zero', () => {
    const result = protectLiteralListAnswerCandidates(
      "What are Melanie's pets' names?",
      [buildResult('bailey', 'We got another cat named Bailey too.', 0.4)],
      0,
    );

    expect(result.protectedIds).toEqual([]);
    expect(result.protectedFingerprints).toEqual([]);
  });
});
