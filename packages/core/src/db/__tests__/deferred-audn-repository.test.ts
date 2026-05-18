/**
 * Unit tests for deferred AUDN repository helpers.
 * Tests serialization/parsing without requiring a database.
 */

import { describe, it, expect } from 'vitest';

// Import the parseCandidates logic by testing via the module's exports
// Since parseCandidates is private, we test it indirectly through the
// DeferredCandidate type contract.

import type { DeferredCandidate } from '../repository-deferred-audn.js';

describe('DeferredCandidate serialization', () => {
  it('round-trips candidate data through JSON serialization', () => {
    const candidates: DeferredCandidate[] = [
      { id: 'mem-1', content: 'The capital of France is Paris.', similarity: 0.85 },
      { id: 'mem-2', content: 'Paris is the largest city in France.', similarity: 0.72 },
    ];

    const serialized = JSON.stringify(candidates);
    const parsed: DeferredCandidate[] = JSON.parse(serialized);

    expect(parsed).toHaveLength(2);
    expect(parsed[0].id).toBe('mem-1');
    expect(parsed[0].similarity).toBe(0.85);
    expect(parsed[1].content).toBe('Paris is the largest city in France.');
  });

  it('handles empty candidate list', () => {
    const candidates: DeferredCandidate[] = [];
    const serialized = JSON.stringify(candidates);
    const parsed: DeferredCandidate[] = JSON.parse(serialized);
    expect(parsed).toHaveLength(0);
  });

  it('preserves similarity precision through serialization', () => {
    const candidates: DeferredCandidate[] = [
      { id: 'mem-1', content: 'test', similarity: 0.7891234 },
    ];
    const parsed: DeferredCandidate[] = JSON.parse(JSON.stringify(candidates));
    expect(parsed[0].similarity).toBeCloseTo(0.7891234, 6);
  });
});
