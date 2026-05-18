/**
 * Unit tests for event-chain-detector.ts.
 *
 * Covers the six contract cases described in the implementation task:
 *  1. Empty input → empty chains
 *  2. 3 members, 3 distinct dates, same entity → 1 chain, sorted by observedAt
 *  3. Below minMembers (2 per entity) → no chains
 *  4. Below minDistinctDates (3 members, same date) → no chains
 *  5. Multiple entities each forming a chain → both chains, sorted by score DESC
 *  6. Mixed: some entities form chains, some don't → only chains returned
 */

import { describe, expect, it } from 'vitest';
import { detectEventChains, type ChainDetectorCandidate } from '../event-chain-detector.js';

const MIN_MEMBERS = 3;
const MIN_DISTINCT_DATES = 3;

function makeCandidate(
  id: string,
  text: string,
  observedAt: Date,
  entityIds?: string[],
): ChainDetectorCandidate {
  return { id, text, observedAt, entityIds };
}

describe('detectEventChains', () => {
  it('returns empty chains for empty input', () => {
    const result = detectEventChains({
      candidates: [],
      minMembers: MIN_MEMBERS,
      minDistinctDates: MIN_DISTINCT_DATES,
    });
    expect(result.chains).toHaveLength(0);
  });

  it('returns one chain when 3 members share an entity and span 3 distinct dates', () => {
    const d1 = new Date('2026-01-01T10:00:00Z');
    const d2 = new Date('2026-01-02T10:00:00Z');
    const d3 = new Date('2026-01-03T10:00:00Z');
    const candidates: ChainDetectorCandidate[] = [
      makeCandidate('m3', 'project-x update C', d3, ['project-x']),
      makeCandidate('m1', 'project-x update A', d1, ['project-x']),
      makeCandidate('m2', 'project-x update B', d2, ['project-x']),
    ];
    const result = detectEventChains({ candidates, minMembers: MIN_MEMBERS, minDistinctDates: MIN_DISTINCT_DATES });
    expect(result.chains).toHaveLength(1);
    const chain = result.chains[0];
    expect(chain.entity).toBe('project-x');
    expect(chain.members).toHaveLength(3);
    // sorted ascending by observedAt
    expect(chain.members[0].memoryId).toBe('m1');
    expect(chain.members[1].memoryId).toBe('m2');
    expect(chain.members[2].memoryId).toBe('m3');
  });

  it('returns no chains when entity has fewer than minMembers', () => {
    const d1 = new Date('2026-01-01T10:00:00Z');
    const d2 = new Date('2026-01-02T10:00:00Z');
    const candidates: ChainDetectorCandidate[] = [
      makeCandidate('m1', 'thing A', d1, ['entity-a']),
      makeCandidate('m2', 'thing B', d2, ['entity-a']),
    ];
    const result = detectEventChains({ candidates, minMembers: MIN_MEMBERS, minDistinctDates: MIN_DISTINCT_DATES });
    expect(result.chains).toHaveLength(0);
  });

  it('returns no chains when all members share the same observed_at date', () => {
    const sameDay = new Date('2026-03-15T10:00:00Z');
    const candidates: ChainDetectorCandidate[] = [
      makeCandidate('m1', 'topic Y first mention', sameDay, ['topic-y']),
      makeCandidate('m2', 'topic Y second mention', sameDay, ['topic-y']),
      makeCandidate('m3', 'topic Y third mention', sameDay, ['topic-y']),
    ];
    const result = detectEventChains({ candidates, minMembers: MIN_MEMBERS, minDistinctDates: MIN_DISTINCT_DATES });
    expect(result.chains).toHaveLength(0);
  });

  it('returns both chains sorted by score DESC when two entities each form a chain', () => {
    const d1 = new Date('2026-02-01T10:00:00Z');
    const d2 = new Date('2026-02-02T10:00:00Z');
    const d3 = new Date('2026-02-03T10:00:00Z');
    const d4 = new Date('2026-02-04T10:00:00Z');
    // entity-a has 4 members × 4 dates = score 16
    // entity-b has 3 members × 3 dates = score 9
    const candidates: ChainDetectorCandidate[] = [
      makeCandidate('a1', 'alpha one', d1, ['entity-a']),
      makeCandidate('a2', 'alpha two', d2, ['entity-a']),
      makeCandidate('a3', 'alpha three', d3, ['entity-a']),
      makeCandidate('a4', 'alpha four', d4, ['entity-a']),
      makeCandidate('b1', 'beta one', d1, ['entity-b']),
      makeCandidate('b2', 'beta two', d2, ['entity-b']),
      makeCandidate('b3', 'beta three', d3, ['entity-b']),
    ];
    const result = detectEventChains({ candidates, minMembers: MIN_MEMBERS, minDistinctDates: MIN_DISTINCT_DATES });
    expect(result.chains).toHaveLength(2);
    expect(result.chains[0].entity).toBe('entity-a');
    expect(result.chains[0].score).toBeGreaterThan(result.chains[1].score);
    expect(result.chains[1].entity).toBe('entity-b');
  });

  it('returns only chained entities when some entities do not form chains', () => {
    const d1 = new Date('2026-04-10T10:00:00Z');
    const d2 = new Date('2026-04-11T10:00:00Z');
    const d3 = new Date('2026-04-12T10:00:00Z');
    const candidates: ChainDetectorCandidate[] = [
      // entity-chain: forms a valid chain (3 members, 3 dates)
      makeCandidate('c1', 'chain first', d1, ['entity-chain']),
      makeCandidate('c2', 'chain second', d2, ['entity-chain']),
      makeCandidate('c3', 'chain third', d3, ['entity-chain']),
      // entity-solo: only 1 member, cannot form a chain
      makeCandidate('s1', 'solo mention', d1, ['entity-solo']),
    ];
    const result = detectEventChains({ candidates, minMembers: MIN_MEMBERS, minDistinctDates: MIN_DISTINCT_DATES });
    expect(result.chains).toHaveLength(1);
    expect(result.chains[0].entity).toBe('entity-chain');
  });
});
