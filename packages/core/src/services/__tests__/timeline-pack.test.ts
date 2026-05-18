/**
 * Unit tests for timeline-pack derived retrieval projection.
 *
 * Covers: spansMultipleDates gate, pack building, formatting with
 * [CURRENT] tag, and single-date passthrough (no pack created).
 */

import { describe, expect, it } from 'vitest';
import {
  spansMultipleDates,
  buildTimelinePack,
  formatTimelinePack,
} from '../timeline-pack.js';
import { createSearchResult } from './test-fixtures.js';

function makeResult(overrides: Partial<import('../../db/repository-types.js').SearchResult> = {}) {
  return createSearchResult({
    id: 'mem-1', content: 'Some fact', embedding: [0.1],
    importance: 0.7, source_site: 'chatgpt',
    created_at: new Date('2026-01-15T00:00:00Z'), access_count: 1,
    similarity: 0.85, score: 0.9,
    ...overrides,
  });
}

describe('spansMultipleDates', () => {
  it('returns false for empty input', () => {
    expect(spansMultipleDates([])).toBe(false);
  });

  it('returns false when all memories share one date', () => {
    const memories = [
      makeResult({ created_at: new Date('2026-01-15T10:00:00Z') }),
      makeResult({ created_at: new Date('2026-01-15T18:00:00Z') }),
    ];
    expect(spansMultipleDates(memories)).toBe(false);
  });

  it('returns true when memories span two dates', () => {
    const memories = [
      makeResult({ created_at: new Date('2026-01-15') }),
      makeResult({ created_at: new Date('2026-03-20') }),
    ];
    expect(spansMultipleDates(memories)).toBe(true);
  });
});

describe('buildTimelinePack', () => {
  it('sorts entries chronologically and marks latest as current', () => {
    const memories = [
      makeResult({ id: 'newer', content: 'PostgreSQL now', created_at: new Date('2026-03-15') }),
      makeResult({ id: 'older', content: 'MongoDB before', created_at: new Date('2026-01-10') }),
    ];
    const pack = buildTimelinePack('backend', memories);

    expect(pack.topic).toBe('backend');
    expect(pack.entries).toHaveLength(2);
    expect(pack.entries[0].memoryId).toBe('older');
    expect(pack.entries[0].isCurrent).toBe(false);
    expect(pack.entries[1].memoryId).toBe('newer');
    expect(pack.entries[1].isCurrent).toBe(true);
    expect(pack.latestEntryId).toBe('newer');
  });

  it('handles three entries across three dates', () => {
    const memories = [
      makeResult({ id: 'c', created_at: new Date('2026-03-01') }),
      makeResult({ id: 'a', created_at: new Date('2026-01-01') }),
      makeResult({ id: 'b', created_at: new Date('2026-02-01') }),
    ];
    const pack = buildTimelinePack('topic', memories);

    expect(pack.entries.map((e) => e.memoryId)).toEqual(['a', 'b', 'c']);
    expect(pack.entries[2].isCurrent).toBe(true);
    expect(pack.entries[0].isCurrent).toBe(false);
    expect(pack.entries[1].isCurrent).toBe(false);
  });
});

describe('formatTimelinePack', () => {
  it('produces Timeline header with [CURRENT] on latest entry', () => {
    const memories = [
      makeResult({ id: 'old', content: 'User prefers MongoDB.', created_at: new Date('2026-01-10') }),
      makeResult({ id: 'new', content: 'User switched to PostgreSQL.', created_at: new Date('2026-03-15') }),
    ];
    const pack = buildTimelinePack('database', memories);
    const formatted = formatTimelinePack(pack);

    expect(formatted).toContain('### Timeline: database');
    expect(formatted).toContain('[CURRENT] User switched to PostgreSQL.');
    expect(formatted).not.toContain('[CURRENT] User prefers MongoDB.');
  });

  it('includes answer/context kind labels', () => {
    const memories = [
      makeResult({ id: 'a', content: 'Attended workshop in January', created_at: new Date('2026-01-15') }),
      makeResult({ id: 'b', content: 'Generic context info', created_at: new Date('2026-03-01') }),
    ];
    const pack = buildTimelinePack('events', memories);
    const formatted = formatTimelinePack(pack);

    expect(formatted).toContain('[answer]');
    expect(formatted).toContain('[context]');
  });

  it('formats dates as YYYY-MM-DD', () => {
    const memories = [
      makeResult({ id: 'a', created_at: new Date('2026-01-15') }),
      makeResult({ id: 'b', created_at: new Date('2026-03-20') }),
    ];
    const pack = buildTimelinePack('topic', memories);
    const formatted = formatTimelinePack(pack);

    expect(formatted).toContain('[2026-01-15]');
    expect(formatted).toContain('[2026-03-20]');
  });
});
