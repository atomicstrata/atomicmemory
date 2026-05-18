/**
 * Unit tests for weighted reciprocal rank fusion.
 */

import { describe, expect, it } from 'vitest';
import { weightedRRF, type WeightedRrfChannel } from '../rrf-fusion.js';

interface TestResult {
  id: string;
  score: number;
  content: string;
}

describe('weightedRRF', () => {
  it('returns empty when no channels are provided', () => {
    expect(weightedRRF<TestResult>([], 5)).toEqual([]);
  });

  it('favors items supported by multiple channels', () => {
    const semantic: WeightedRrfChannel<TestResult> = {
      name: 'semantic',
      weight: 1.2,
      results: [
        { id: 'a', score: 0.9, content: 'semantic-a' },
        { id: 'b', score: 0.8, content: 'semantic-b' },
      ],
    };
    const keyword: WeightedRrfChannel<TestResult> = {
      name: 'keyword',
      weight: 1.0,
      results: [
        { id: 'b', score: 0.7, content: 'keyword-b' },
        { id: 'c', score: 0.6, content: 'keyword-c' },
      ],
    };

    const fused = weightedRRF([semantic, keyword], 3, 10);

    expect(fused.map((result) => result.id)).toEqual(['b', 'a', 'c']);
  });

  it('preserves the first canonical result when an item appears in multiple channels', () => {
    const semantic: WeightedRrfChannel<TestResult> = {
      name: 'semantic',
      weight: 1.2,
      results: [{ id: 'shared', score: 0.9, content: 'semantic-version' }],
    };
    const entity: WeightedRrfChannel<TestResult> = {
      name: 'entity',
      weight: 1.3,
      results: [{ id: 'shared', score: 0.4, content: 'entity-version' }],
    };

    const fused = weightedRRF([semantic, entity], 1, 10);

    expect(fused[0].content).toBe('semantic-version');
  });
});
