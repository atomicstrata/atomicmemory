/**
 * @file Regression tests pinning wire-contract-preserving behavior of
 * the memories route schemas.
 *
 * The codex review on the Phase 2 refactor flagged that generic Zod
 * messages ("Invalid input: expected string, received undefined")
 * would leak through to API clients that match on the exact route-
 * specific error text produced by the pre-refactor inline parsers.
 * This test file locks in the preserved messages and the preserved
 * empty-string pass-through on POST /search filters.
 */

import { describe, it, expect } from 'vitest';
import {
  IngestBodySchema,
  SearchBodySchema,
  ExpandBodySchema,
  ListQuerySchema,
  ResetSourceBodySchema,
  LessonReportBodySchema,
} from '../memories';
import { firstIssueMessage } from './schema-test-helpers.js';

describe('IngestBodySchema — preserved error messages', () => {
  it('missing user_id → "user_id (string) is required"', () => {
    const r = IngestBodySchema.safeParse({
      conversation: 'x',
      source_site: 's',
    });
    expect(firstIssueMessage(r)).toBe('user_id (string) is required');
  });

  it('non-string user_id → same message', () => {
    const r = IngestBodySchema.safeParse({
      user_id: 42,
      conversation: 'x',
      source_site: 's',
    });
    expect(firstIssueMessage(r)).toBe('user_id (string) is required');
  });

  it('empty-string user_id → same message', () => {
    const r = IngestBodySchema.safeParse({
      user_id: '',
      conversation: 'x',
      source_site: 's',
    });
    expect(firstIssueMessage(r)).toBe('user_id (string) is required');
  });

  it('missing conversation → "conversation (string) is required"', () => {
    const r = IngestBodySchema.safeParse({ user_id: 'u', source_site: 's' });
    expect(firstIssueMessage(r)).toBe('conversation (string) is required');
  });

  it('missing source_site → "source_site (string) is required"', () => {
    const r = IngestBodySchema.safeParse({ user_id: 'u', conversation: 'x' });
    expect(firstIssueMessage(r)).toBe('source_site (string) is required');
  });

  it('over-length conversation → "conversation exceeds max length of 100000 characters"', () => {
    const r = IngestBodySchema.safeParse({
      user_id: 'u',
      conversation: 'x'.repeat(100_001),
      source_site: 's',
    });
    expect(firstIssueMessage(r)).toBe(
      'conversation exceeds max length of 100000 characters',
    );
  });
});

describe('SearchBodySchema — preserved empty-string pass-through', () => {
  it('preserves source_site: "" verbatim (matches optionalBodyString)', () => {
    const r = SearchBodySchema.parse({
      user_id: 'u',
      query: 'q',
      source_site: '',
    });
    expect(r.sourceSite).toBe('');
  });

  it('preserves namespace_scope: "" verbatim', () => {
    const r = SearchBodySchema.parse({
      user_id: 'u',
      query: 'q',
      namespace_scope: '',
    });
    expect(r.namespaceScope).toBe('');
  });

  it('preserves session_id as sessionId', () => {
    const r = SearchBodySchema.parse({
      user_id: 'u',
      query: 'q',
      session_id: 'thread-1',
    });
    expect(r.sessionId).toBe('thread-1');
  });

  it('rejects non-string session_id values', () => {
    for (const session_id of [42, ['a'], { x: 1 }]) {
      const r = SearchBodySchema.safeParse({ user_id: 'u', query: 'q', session_id });
      expect(firstIssueMessage(r)).toMatch(/session_id/);
    }
  });

  it('required fields still emit exact prior-parser messages', () => {
    const r = SearchBodySchema.safeParse({ query: 'q' });
    expect(firstIssueMessage(r)).toBe('user_id (string) is required');
  });
});

describe('IngestBodySchema — session scope', () => {
  it('preserves session_id as sessionId', () => {
    const r = IngestBodySchema.parse({
      user_id: 'u',
      conversation: 'x',
      source_site: 'sdk',
      session_id: 'thread-1',
    });
    expect(r.sessionId).toBe('thread-1');
  });

  it('rejects invalid session_id values', () => {
    const base = {
      user_id: 'u',
      conversation: 'x',
      source_site: 'sdk',
    };
    for (const session_id of ['   ', 'abc\n123', 'x'.repeat(257), 42, ['a'], { x: 1 }]) {
      const r = IngestBodySchema.safeParse({ ...base, session_id });
      expect(firstIssueMessage(r)).toMatch(/session_id/);
    }
  });
});

describe('ListQuerySchema — session scope', () => {
  it('preserves session_id as sessionId', () => {
    const r = ListQuerySchema.parse({
      user_id: 'u',
      session_id: 'thread-1',
    });
    expect(r.sessionId).toBe('thread-1');
  });

  it('rejects invalid session_id values', () => {
    for (const session_id of ['   ', 'abc\n123', 'x'.repeat(257), 42, ['a'], { x: 1 }]) {
      const r = ListQuerySchema.safeParse({ user_id: 'u', session_id });
      expect(firstIssueMessage(r)).toMatch(/session_id/);
    }
  });
});

describe('ExpandBodySchema — preserved error messages', () => {
  it('missing memory_ids → "memory_ids (string[]) is required"', () => {
    const r = ExpandBodySchema.safeParse({ user_id: 'u' });
    expect(firstIssueMessage(r)).toBe('memory_ids (string[]) is required');
  });

  it('non-array memory_ids → same message', () => {
    const r = ExpandBodySchema.safeParse({ user_id: 'u', memory_ids: 'abc' });
    expect(firstIssueMessage(r)).toBe('memory_ids (string[]) is required');
  });

  it('array with non-string elements → same message', () => {
    const r = ExpandBodySchema.safeParse({ user_id: 'u', memory_ids: ['a', 42] });
    expect(firstIssueMessage(r)).toBe('memory_ids (string[]) is required');
  });
});

describe('ResetSourceBodySchema / LessonReportBodySchema — preserved messages', () => {
  it('reset-source missing source_site → "source_site (string) is required"', () => {
    const r = ResetSourceBodySchema.safeParse({ user_id: 'u' });
    expect(firstIssueMessage(r)).toBe('source_site (string) is required');
  });

  it('lessons/report missing pattern → "pattern (string) is required"', () => {
    const r = LessonReportBodySchema.safeParse({ user_id: 'u' });
    expect(firstIssueMessage(r)).toBe('pattern (string) is required');
  });
});
