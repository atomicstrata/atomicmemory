/**
 * Tests for composite/member deduplication in packaging paths.
 *
 * Validates:
 * - Soft dedup (flat mode): composites suppressed when atomics cover ≥60%
 * - Hard dedup (tiered mode): covered atomics dropped, composites kept
 * - Edge cases: no composites, no member links, mixed coverage
 */

import { describe, it, expect } from 'vitest';
import {
  deduplicateCompositeMembersForFlatQuery,
  deduplicateCompositeMembersHard,
  deduplicateCompositeMembersSoft,
  prefersAtomicFlatPackaging,
} from '../composite-dedup.js';
import { createSearchResult } from './test-fixtures.js';

function makeMemory(overrides: Partial<import('../../db/repository-types.js').SearchResult> & { id: string }) {
  return createSearchResult({
    user_id: 'test-user', content: `content-${overrides.id}`,
    memory_type: 'factual', namespace: 'test', network: 'direct',
    created_at: new Date('2026-03-27'), last_accessed_at: new Date('2026-03-27'),
    ...overrides,
  });
}

function makeAtomic(id: string) {
  return makeMemory({ id, memory_type: 'factual' });
}

function makeComposite(id: string, memberIds: string[]) {
  return makeMemory({
    id,
    memory_type: 'composite',
    metadata: { memberMemoryIds: memberIds },
  });
}

describe('deduplicateCompositeMembersSoft (flat mode)', () => {
  it('returns unchanged when no composites present', () => {
    const memories = [makeAtomic('a1'), makeAtomic('a2'), makeAtomic('a3')];
    const result = deduplicateCompositeMembersSoft(memories);
    expect(result).toHaveLength(3);
  });

  it('suppresses composite when atomics cover ≥60% of members', () => {
    const a1 = makeAtomic('a1');
    const a2 = makeAtomic('a2');
    const a3 = makeAtomic('a3');
    const composite = makeComposite('c1', ['a1', 'a2', 'a3']);

    const result = deduplicateCompositeMembersSoft([a1, a2, a3, composite]);

    expect(result).toHaveLength(3);
    expect(result.map((m) => m.id)).toEqual(['a1', 'a2', 'a3']);
  });

  it('keeps composite when atomics cover <60% of members', () => {
    const a1 = makeAtomic('a1');
    const composite = makeComposite('c1', ['a1', 'a2', 'a3', 'a4', 'a5']);

    const result = deduplicateCompositeMembersSoft([a1, composite]);

    expect(result).toHaveLength(2);
    expect(result.map((m) => m.id)).toEqual(['a1', 'c1']);
  });

  it('never suppresses atomics regardless of composites', () => {
    const a1 = makeAtomic('a1');
    const a2 = makeAtomic('a2');
    const composite = makeComposite('c1', ['a1', 'a2']);

    const result = deduplicateCompositeMembersSoft([a1, a2, composite]);

    expect(result.some((m) => m.id === 'a1')).toBe(true);
    expect(result.some((m) => m.id === 'a2')).toBe(true);
  });

  it('handles composite with no memberMemoryIds gracefully', () => {
    const a1 = makeAtomic('a1');
    const composite = makeMemory({
      id: 'c1',
      memory_type: 'composite',
      metadata: {},
    });

    const result = deduplicateCompositeMembersSoft([a1, composite]);
    expect(result).toHaveLength(2);
  });

  it('handles composite with empty memberMemoryIds', () => {
    const a1 = makeAtomic('a1');
    const composite = makeComposite('c1', []);

    const result = deduplicateCompositeMembersSoft([a1, composite]);
    expect(result).toHaveLength(2);
  });

  it('respects custom coverage threshold', () => {
    const a1 = makeAtomic('a1');
    const a2 = makeAtomic('a2');
    const composite = makeComposite('c1', ['a1', 'a2', 'a3', 'a4']);

    // 2/4 = 0.50 coverage
    const withDefaultThreshold = deduplicateCompositeMembersSoft([a1, a2, composite]);
    expect(withDefaultThreshold).toHaveLength(3);

    const withLowerThreshold = deduplicateCompositeMembersSoft([a1, a2, composite], 0.4);
    expect(withLowerThreshold).toHaveLength(2);
    expect(withLowerThreshold.map((m) => m.id)).toEqual(['a1', 'a2']);
  });

  it('handles multiple composites with different coverage', () => {
    const a1 = makeAtomic('a1');
    const a2 = makeAtomic('a2');
    const a3 = makeAtomic('a3');
    const highCoverage = makeComposite('c-high', ['a1', 'a2', 'a3']);
    const lowCoverage = makeComposite('c-low', ['a1', 'x1', 'x2', 'x3', 'x4']);

    const result = deduplicateCompositeMembersSoft([a1, a2, a3, highCoverage, lowCoverage]);

    expect(result.map((m) => m.id)).toEqual(['a1', 'a2', 'a3', 'c-low']);
  });

  it('keeps composite when no atomics are present', () => {
    const composite = makeComposite('c1', ['a1', 'a2']);

    const result = deduplicateCompositeMembersSoft([composite]);
    expect(result).toHaveLength(1);
  });
});

describe('deduplicateCompositeMembersHard (tiered mode)', () => {
  it('returns unchanged when no composites present', () => {
    const memories = [makeAtomic('a1'), makeAtomic('a2')];
    const result = deduplicateCompositeMembersHard(memories);
    expect(result).toHaveLength(2);
  });

  it('drops atomics covered by any composite', () => {
    const a1 = makeAtomic('a1');
    const a2 = makeAtomic('a2');
    const a3 = makeAtomic('a3');
    const composite = makeComposite('c1', ['a1', 'a2']);

    const result = deduplicateCompositeMembersHard([a1, a2, a3, composite]);

    expect(result).toHaveLength(2);
    expect(result.map((m) => m.id)).toEqual(['a3', 'c1']);
  });

  it('keeps atomics not covered by any composite', () => {
    const a1 = makeAtomic('a1');
    const a2 = makeAtomic('a2');
    const composite = makeComposite('c1', ['a1']);

    const result = deduplicateCompositeMembersHard([a1, a2, composite]);

    expect(result.map((m) => m.id)).toEqual(['a2', 'c1']);
  });

  it('handles composite with no memberMemoryIds', () => {
    const a1 = makeAtomic('a1');
    const composite = makeMemory({
      id: 'c1',
      memory_type: 'composite',
      metadata: {},
    });

    const result = deduplicateCompositeMembersHard([a1, composite]);
    expect(result).toHaveLength(2);
  });
});

describe('deduplicateCompositeMembersForFlatQuery', () => {
  it('suppresses overlapping composites for current-state queries', () => {
    const current = makeAtomic('current');
    const old = makeAtomic('old');
    const composite = makeComposite('timeline', ['current', 'old']);

    const result = deduplicateCompositeMembersForFlatQuery(
      [composite, current, old],
      'What backend does the user want now?',
    );

    expect(result.map((memory) => memory.id)).toEqual(['current', 'old']);
  });

  it('suppresses overlapping composites for narrow role questions', () => {
    const owner = makeAtomic('owner');
    const helper = makeAtomic('helper');
    const composite = makeComposite('summary', ['owner', 'helper']);

    const result = deduplicateCompositeMembersForFlatQuery(
      [owner, composite, helper],
      'Who handles execution and validation work?',
    );

    expect(result.map((memory) => memory.id)).toEqual(['owner', 'helper']);
  });

  it('keeps broad summary composites when the query asks for an overview', () => {
    const a1 = makeAtomic('a1');
    const composite = makeComposite('summary', ['a1', 'a2', 'a3']);

    const result = deduplicateCompositeMembersForFlatQuery(
      [composite, a1],
      'Summarize the user preferences for this project.',
    );

    expect(result.map((memory) => memory.id)).toEqual(['summary', 'a1']);
  });
});

describe('prefersAtomicFlatPackaging', () => {
  it('treats current-state questions as precision queries', () => {
    expect(prefersAtomicFlatPackaging('What backend does the user want now?')).toBe(true);
  });

  it('treats broad summary prompts as non-precision queries', () => {
    expect(prefersAtomicFlatPackaging('Summarize the current memory-layer work.')).toBe(false);
  });
});
