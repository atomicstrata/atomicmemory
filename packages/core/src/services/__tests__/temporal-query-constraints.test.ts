/**
 * Unit tests for explicit month/date query constraint ranking.
 */

import { describe, expect, it } from 'vitest';
import { applyTemporalQueryConstraints } from '../temporal-query-constraints.js';
import { createSearchResult } from './test-fixtures.js';

function result(id: string, content: string, createdAt: string, score: number) {
  return createSearchResult({
    id,
    content,
    score,
    created_at: new Date(createdAt),
    observed_at: new Date(createdAt),
  });
}

describe('applyTemporalQueryConstraints', () => {
  it('boosts and protects candidates matching an explicit month and query keywords', () => {
    const ranked = applyTemporalQueryConstraints(
      'What did Caroline do for the pride parade in August?',
      [
        result('october', 'Caroline went to the October pride parade.', '2023-10-13T00:00:00.000Z', 0.9),
        result('august', 'Caroline volunteered at the pride parade.', '2023-08-19T00:00:00.000Z', 0.3),
      ],
      2,
    );

    expect(ranked.constraints).toEqual(['august']);
    expect(ranked.protectedIds).toEqual(['august']);
    expect(ranked.results[0]?.id).toBe('august');
  });

  it('does not boost month matches that lack query keyword support', () => {
    const ranked = applyTemporalQueryConstraints(
      'What did Caroline do for the pride parade in August?',
      [
        result('beach', 'Caroline visited the beach in August.', '2023-08-19T00:00:00.000Z', 0.9),
        result('parade', 'Caroline mentioned the pride parade.', '2023-10-13T00:00:00.000Z', 0.8),
      ],
      2,
    );

    expect(ranked.protectedIds).toEqual([]);
    expect(ranked.results[0]?.id).toBe('beach');
  });

  it('honors explicit month-year constraints', () => {
    const ranked = applyTemporalQueryConstraints(
      'What changed in August 2024?',
      [
        result('old', 'The project changed in August 2023.', '2023-08-01T00:00:00.000Z', 0.9),
        result('new', 'The project changed during planning.', '2024-08-01T00:00:00.000Z', 0.2),
      ],
      2,
    );

    expect(ranked.constraints).toEqual(['august 2024']);
    expect(ranked.protectedIds).toEqual(['new']);
    expect(ranked.results[0]?.id).toBe('new');
  });
});
