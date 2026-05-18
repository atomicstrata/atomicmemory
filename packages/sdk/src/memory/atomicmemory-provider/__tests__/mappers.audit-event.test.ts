/**
 * @file Hand-written tests for `toMemoryVersion` / `mapAuditEvent`.
 *
 * The mapper has a small switch statement that classifies the audit
 * event string into a typed union. Until now it was untested, which
 * showed up in fallow's CRAP score (5 cyclomatic × 0% covered =
 * 30.0) — right at the threshold. Five tests, one per branch, drive
 * coverage to 100%.
 */

import { describe, it, expect } from 'vitest';
import { toMemoryVersion } from '../mappers';

const BASE = {
  id: 'v1',
  content: 'c',
  created_at: '2026-04-25T00:00:00.000Z',
  parent_id: 'v0',
};

describe('toMemoryVersion / mapAuditEvent', () => {
  it.each([
    ['created'],
    ['updated'],
    ['superseded'],
    ['invalidated'],
  ])('preserves a known event tag: %s', (event) => {
    const v = toMemoryVersion({ ...BASE, event });
    expect(v.event).toBe(event);
  });

  it('falls back to "created" for an unknown event tag', () => {
    const v = toMemoryVersion({ ...BASE, event: 'mystery-event' });
    expect(v.event).toBe('created');
  });

  it('falls back to "created" when event is undefined', () => {
    const v = toMemoryVersion(BASE);
    expect(v.event).toBe('created');
  });

  it('passes through id / content / parentId verbatim', () => {
    const v = toMemoryVersion({ ...BASE, event: 'updated' });
    expect(v.id).toBe('v1');
    expect(v.content).toBe('c');
    expect(v.parentId).toBe('v0');
  });

  it('parses created_at as a Date with matching ISO', () => {
    const v = toMemoryVersion({ ...BASE, event: 'created' });
    expect(v.createdAt).toBeInstanceOf(Date);
    expect(v.createdAt.toISOString()).toBe(BASE.created_at);
  });
});
