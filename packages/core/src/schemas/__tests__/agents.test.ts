/**
 * @file Regression tests pinning the agents-route schemas' preserved
 * wire-contract error messages and input-coercion quirks.
 *
 * Source of truth for the prior inline parsers: `src/routes/agents.ts`
 * (pre-refactor, lines 86-109).
 */

import { describe, it, expect } from 'vitest';
import {
  SetTrustBodySchema,
  GetTrustQuerySchema,
  UserIdFromQuerySchema,
  UserIdFromBodySchema,
  ResolveConflictBodySchema,
} from '../agents';
import { firstIssueMessage } from './schema-test-helpers.js';

describe('SetTrustBodySchema — preserved messages', () => {
  it('missing agent_id → "agent_id is required"', () => {
    const r = SetTrustBodySchema.safeParse({
      user_id: 'u',
      trust_level: 0.5,
    });
    expect(firstIssueMessage(r)).toBe('agent_id is required');
  });

  it('missing user_id → "user_id is required"', () => {
    const r = SetTrustBodySchema.safeParse({
      agent_id: 'a',
      trust_level: 0.5,
    });
    expect(firstIssueMessage(r)).toBe('user_id is required');
  });

  it('non-number trust_level → type message', () => {
    const r = SetTrustBodySchema.safeParse({
      agent_id: 'a',
      user_id: 'u',
      trust_level: 'high',
    });
    expect(firstIssueMessage(r)).toBe(
      'trust_level must be a number between 0.0 and 1.0',
    );
  });

  it('out-of-range trust_level → range message (not type message)', () => {
    const r = SetTrustBodySchema.safeParse({
      agent_id: 'a',
      user_id: 'u',
      trust_level: 1.5,
    });
    expect(firstIssueMessage(r)).toBe('trust_level must be between 0.0 and 1.0');
  });

  it('array agent_id → takes first element (preserves requireString quirk)', () => {
    const r = SetTrustBodySchema.parse({
      agent_id: ['ag-first', 'ag-second'],
      user_id: 'u',
      trust_level: 0.5,
    });
    expect(r.agentId).toBe('ag-first');
  });

  it('empty-array agent_id → "agent_id is required"', () => {
    const r = SetTrustBodySchema.safeParse({
      agent_id: [],
      user_id: 'u',
      trust_level: 0.5,
    });
    expect(firstIssueMessage(r)).toBe('agent_id is required');
  });
});

describe('Query + body user_id schemas — preserved messages', () => {
  it('GET /trust missing agent_id → "agent_id is required"', () => {
    const r = GetTrustQuerySchema.safeParse({ user_id: 'u' });
    expect(firstIssueMessage(r)).toBe('agent_id is required');
  });

  it('GET /conflicts missing user_id → "user_id is required"', () => {
    const r = UserIdFromQuerySchema.safeParse({});
    expect(firstIssueMessage(r)).toBe('user_id is required');
  });

  it('POST /conflicts/auto-resolve missing user_id → "user_id is required"', () => {
    const r = UserIdFromBodySchema.safeParse({});
    expect(firstIssueMessage(r)).toBe('user_id is required');
  });
});

describe('ResolveConflictBodySchema — preserved resolution message', () => {
  it.each(['resolved_new', 'resolved_existing', 'resolved_both'])(
    'accepts valid enum %s',
    v => {
      expect(ResolveConflictBodySchema.parse({ resolution: v }).resolution).toBe(v);
    },
  );

  it('rejects unknown value with exact list message', () => {
    const r = ResolveConflictBodySchema.safeParse({ resolution: 'resolved_eventually' });
    expect(firstIssueMessage(r)).toBe(
      'resolution must be "resolved_new", "resolved_existing", or "resolved_both"',
    );
  });

  it('rejects non-string with exact list message', () => {
    const r = ResolveConflictBodySchema.safeParse({ resolution: 42 });
    expect(firstIssueMessage(r)).toBe(
      'resolution must be "resolved_new", "resolved_existing", or "resolved_both"',
    );
  });
});
