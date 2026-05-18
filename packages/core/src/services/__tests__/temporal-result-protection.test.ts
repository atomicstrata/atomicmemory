/**
 * Unit tests for preserving temporal anchors through late-stage reranking.
 */

import { describe, expect, it } from 'vitest';
import { preserveProtectedResults } from '../temporal-result-protection.js';
import { createSearchResult } from './test-fixtures.js';

function makeResult(id: string, score: number) {
  return createSearchResult({
    id, content: id, user_id: 'u', memory_type: 'fact', network: 'experience',
    created_at: new Date('2026-01-01T00:00:00Z'),
    last_accessed_at: new Date('2026-01-01T00:00:00Z'),
    similarity: score, score,
  });
}

describe('preserveProtectedResults', () => {
  it('keeps protected temporal anchors in the final selection by content fingerprint', () => {
    const selected = [
      makeResult('broad-context', 0.9),
      makeResult('supporting-note', 0.8),
      makeResult('tail-result', 0.1),
    ];
    const protectedContent = 'As of February 15 2026, user got some career advice from Dr. Chen.';
    const candidates = [...selected];
    candidates.push({ ...makeResult('exact-anchor', 0.4), content: protectedContent });
    candidates.push({ ...makeResult('exact-anchor-duplicate', 0.3), content: protectedContent });

    const protectedResults = preserveProtectedResults(
      selected,
      candidates,
      ['user got some career advice from dr chen'],
      3,
    );

    expect(protectedResults.map((result) => result.content)).toContain(protectedContent);
    expect(protectedResults.map((result) => result.id)).not.toContain('tail-result');
  });
});
