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
  UserIdQuerySchema,
  UserIdLimitQuerySchema,
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

describe('IngestBodySchema — content_class (Radar C3)', () => {
  const base = { user_id: 'u', conversation: 'x', source_site: 's' };

  it('accepts each valid content_class and surfaces it as contentClass', () => {
    for (const content_class of ['summary', 'redacted', 'raw'] as const) {
      const r = IngestBodySchema.parse({ ...base, content_class });
      expect(r.contentClass).toBe(content_class);
    }
  });

  it('absent content_class → contentClass undefined (handler treats as raw)', () => {
    const r = IngestBodySchema.parse({ ...base });
    expect(r.contentClass).toBeUndefined();
  });

  it('rejects an invalid content_class value', () => {
    const r = IngestBodySchema.safeParse({ ...base, content_class: 'verbatim' });
    expect(firstIssueMessage(r)).toBe(
      'content_class must be one of: summary, redacted, raw',
    );
  });

  it('rejects a non-string content_class', () => {
    const r = IngestBodySchema.safeParse({ ...base, content_class: 7 });
    expect(firstIssueMessage(r)).toMatch(/content_class must be one of/);
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

describe('NUL-byte rejection on strings reaching Postgres (QA release-1.1.0 core-robustness:nul.*)', () => {
  // A percent-encoded NUL (%00) decodes to a 1-char string that satisfies
  // `.min(1)`, then 500s at Postgres (which cannot store \x00 in text). The
  // shared validators must reject it so the request stays on the 4xx path.
  // Built via fromCharCode so this source file carries no raw NUL byte.
  const NUL = `qa${String.fromCharCode(0)}evil`;

  describe('query params (RequiredQueryString)', () => {
    it('UserIdQuerySchema rejects, and the message names the NUL byte', () => {
      const r = UserIdQuerySchema.safeParse({ user_id: NUL });
      expect(r.success).toBe(false);
      expect(firstIssueMessage(r)).toMatch(/NUL/i);
    });
    it('UserIdLimitQuerySchema rejects a NUL user_id', () => {
      expect(UserIdLimitQuerySchema.safeParse({ user_id: NUL }).success).toBe(false);
    });
    it('ListQuerySchema rejects a NUL user_id', () => {
      expect(ListQuerySchema.safeParse({ user_id: NUL }).success).toBe(false);
    });
  });

  describe('request bodies (requiredStringBody) — not only query params', () => {
    it('IngestBodySchema rejects a NUL user_id with an accurate (not "required") message', () => {
      const r = IngestBodySchema.safeParse({ user_id: NUL, conversation: 'x', source_site: 's' });
      expect(r.success).toBe(false);
      expect(firstIssueMessage(r)).toMatch(/user_id must not contain NUL/i);
    });
    it('IngestBodySchema rejects a NUL in free-text conversation too', () => {
      const r = IngestBodySchema.safeParse({ user_id: 'u', conversation: NUL, source_site: 's' });
      expect(r.success).toBe(false);
      expect(firstIssueMessage(r)).toMatch(/NUL/i);
    });
  });

  it('a normal user_id still passes (positive control)', () => {
    expect(UserIdQuerySchema.safeParse({ user_id: 'qa-user-1' }).success).toBe(true);
  });
});
