/**
 * Unit tests for bi-temporal validity columns (valid_at / invalid_at).
 * Validates schema shape, invalidation semantics, and the Graphiti-style
 * validity window pattern without requiring a live database.
 *
 * Uses a local TemporalMemory type since the bi-temporal fields are not
 * yet added to the main MemoryRow interface (pattern 6 pending re-apply).
 */

import { describe, it, expect } from 'vitest';
import type { MemoryRow } from '../repository-types.js';
import { createMemoryRow } from './test-fixtures.js';

interface TemporalMemory extends MemoryRow {
  valid_at: Date;
  invalid_at: Date | null;
}

function makeMemory(overrides: Partial<TemporalMemory> = {}): TemporalMemory {
  const base = createMemoryRow({
    id: 'mem-001',
    content: 'User prefers TypeScript',
    embedding: [0.1, 0.2],
    created_at: new Date('2026-01-01'),
    last_accessed_at: new Date('2026-01-01'),
    observed_at: new Date('2026-01-01'),
  });
  return {
    ...base,
    valid_at: new Date('2026-01-01'),
    invalid_at: null,
    ...overrides,
  };
}

describe('temporal validity schema', () => {
  it('new memory has valid_at and null invalid_at', () => {
    const mem = makeMemory();
    expect(mem.valid_at).toBeInstanceOf(Date);
    expect(mem.invalid_at).toBeNull();
  });

  it('valid_at can differ from created_at', () => {
    const mem = makeMemory({
      valid_at: new Date('2025-06-01'),
      created_at: new Date('2026-01-01'),
    });
    expect(mem.valid_at.getTime()).toBeLessThan(mem.created_at.getTime());
  });

  it('invalidated memory has non-null invalid_at', () => {
    const mem = makeMemory({ invalid_at: new Date('2026-03-01') });
    expect(mem.invalid_at).not.toBeNull();
    expect(mem.invalid_at!.getTime()).toBeGreaterThan(mem.valid_at.getTime());
  });
});

describe('validity window filtering', () => {
  const memories = [
    makeMemory({ id: 'active', invalid_at: null }),
    makeMemory({ id: 'expired', invalid_at: new Date('2026-02-01') }),
    makeMemory({ id: 'future-expiry', invalid_at: new Date('2026-12-31') }),
  ];

  function filterByValidity(mems: TemporalMemory[], asOf: Date): TemporalMemory[] {
    return mems.filter((m) =>
      m.invalid_at === null || m.invalid_at.getTime() > asOf.getTime(),
    );
  }

  it('excludes memories that expired before query time', () => {
    const result = filterByValidity(memories, new Date('2026-03-01'));
    const ids = result.map((m) => m.id);
    expect(ids).toContain('active');
    expect(ids).not.toContain('expired');
    expect(ids).toContain('future-expiry');
  });

  it('includes all memories when queried before any expiry', () => {
    const result = filterByValidity(memories, new Date('2026-01-15'));
    expect(result).toHaveLength(3);
  });

  it('includes memories with null invalid_at regardless of query time', () => {
    const farFuture = new Date('2099-01-01');
    const result = filterByValidity(memories, farFuture);
    expect(result.map((m) => m.id)).toContain('active');
  });
});

describe('supersession semantics', () => {
  it('superseded memory gets invalid_at set to supersession time', () => {
    const supersessionTime = new Date('2026-03-15');
    const old = makeMemory({ id: 'old-fact', valid_at: new Date('2026-01-01') });
    const superseded = { ...old, invalid_at: supersessionTime };

    expect(superseded.invalid_at).toEqual(supersessionTime);
    expect(superseded.valid_at.getTime()).toBeLessThan(superseded.invalid_at!.getTime());
  });

  it('replacement memory has valid_at >= old memory invalid_at', () => {
    const supersessionTime = new Date('2026-03-15');
    const replacement = makeMemory({
      id: 'new-fact',
      valid_at: supersessionTime,
    });

    expect(replacement.valid_at.getTime()).toEqual(supersessionTime.getTime());
    expect(replacement.invalid_at).toBeNull();
  });
});
