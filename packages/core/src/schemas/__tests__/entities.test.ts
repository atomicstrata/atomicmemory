/**
 * @file Schema tests for /v1/entities param + merge-body validation, focused on
 * the QA release-1.1.0 `core-robustness:nul.*` hardening: a `%00` path segment
 * (e.g. GET /v1/entities/user/qa%00x/profile) or a NUL entity_id in the merge
 * body must 4xx at validation, not 500 at Postgres.
 */

import { describe, it, expect } from 'vitest';
import {
  EntityTypeParamSchema,
  MemoryHistoryParamSchema,
  MergeBodySchema,
} from '../entities';

const NUL = `qa${String.fromCharCode(0)}x`; // built via fromCharCode → no raw NUL in source

describe('entities identifiers reject NUL bytes', () => {
  it('EntityTypeParamSchema rejects a NUL entity_id (path param)', () => {
    expect(EntityTypeParamSchema.safeParse({ entity_type: 'user', entity_id: NUL }).success).toBe(false);
  });

  it('MemoryHistoryParamSchema rejects a NUL entity_id and a NUL memory_id', () => {
    expect(
      MemoryHistoryParamSchema.safeParse({ entity_type: 'user', entity_id: NUL, memory_id: 'm' }).success,
    ).toBe(false);
    expect(
      MemoryHistoryParamSchema.safeParse({ entity_type: 'user', entity_id: 'e', memory_id: NUL }).success,
    ).toBe(false);
  });

  it('MergeBodySchema rejects a NUL entity_id in source or target', () => {
    const ok = { entity_type: 'user', entity_id: 'good' };
    expect(MergeBodySchema.safeParse({ source: { entity_type: 'user', entity_id: NUL }, target: ok }).success).toBe(false);
    expect(MergeBodySchema.safeParse({ source: ok, target: { entity_type: 'user', entity_id: NUL } }).success).toBe(false);
  });

  it('positive control: a normal entity_id still validates', () => {
    const r = EntityTypeParamSchema.safeParse({ entity_type: 'user', entity_id: 'qa-ent-a' });
    expect(r.success).toBe(true);
  });

  it('still rejects an invalid entity_type (unchanged behaviour)', () => {
    expect(EntityTypeParamSchema.safeParse({ entity_type: 'nope', entity_id: 'e' }).success).toBe(false);
  });
});
