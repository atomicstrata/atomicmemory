/**
 * @file Unit tests for shared Zod schemas.
 *
 * Pins the snake_case wire contracts for WorkspaceContext, AgentScope,
 * RetrievalMode, and the IsoTimestamp helper — so Phase 2 route
 * schemas that compose these keep the pre-Zod behaviors of
 * parseOptionalWorkspaceContext (memories.ts:601) and
 * parseOptionalAgentScope (memories.ts:617).
 */

import { describe, it, expect } from 'vitest';
import {
  MemoryVisibilitySchema,
  WorkspaceContextOutputSchema,
  WorkspaceIdField,
  AgentIdField,
  VisibilityField,
  AgentScopeSchema,
  RetrievalModeSchema,
  IsoTimestamp,
  NonEmptyString,
} from '../common';

describe('MemoryVisibilitySchema', () => {
  it.each(['agent_only', 'restricted', 'workspace'])('accepts %s', v => {
    expect(MemoryVisibilitySchema.safeParse(v).success).toBe(true);
  });

  it('rejects unknown values', () => {
    expect(MemoryVisibilitySchema.safeParse('public').success).toBe(false);
  });
});

describe('Workspace body fields — parser-contract preservation', () => {
  // Mirrors parseOptionalWorkspaceContext (memories.ts:601-615). Current
  // parser NEVER 400s on workspace fields; malformed inputs are
  // silently dropped and the route falls back to user scope.

  it('WorkspaceIdField / AgentIdField are optional at the request level', () => {
    expect(WorkspaceIdField.parse(undefined)).toBeUndefined();
    expect(AgentIdField.parse(undefined)).toBeUndefined();
  });

  it('silently coerces empty-string and non-string inputs to undefined (no 400)', () => {
    // These cases currently reach optionalBodyString -> falsy -> route
    // treats workspace as absent, falls back to user scope. Must not
    // become 400s after the Zod refactor.
    expect(WorkspaceIdField.parse('')).toBeUndefined();
    expect(WorkspaceIdField.parse(42)).toBeUndefined();
    expect(WorkspaceIdField.parse(null)).toBeUndefined();
    expect(WorkspaceIdField.parse({})).toBeUndefined();
    expect(AgentIdField.parse('')).toBeUndefined();
    expect(AgentIdField.parse(42)).toBeUndefined();
  });

  it('passes non-empty string through unchanged', () => {
    expect(WorkspaceIdField.parse('w1')).toBe('w1');
    expect(AgentIdField.parse('a1')).toBe('a1');
  });

  it('VisibilityField silently drops invalid values to undefined', () => {
    expect(VisibilityField.parse('something_invalid')).toBeUndefined();
    expect(VisibilityField.parse(42)).toBeUndefined();
  });

  it('VisibilityField accepts the three valid enum variants', () => {
    expect(VisibilityField.parse('agent_only')).toBe('agent_only');
    expect(VisibilityField.parse('restricted')).toBe('restricted');
    expect(VisibilityField.parse('workspace')).toBe('workspace');
  });
});

describe('WorkspaceContextOutputSchema (post-transform camelCase)', () => {
  it('requires both workspaceId and agentId in the workspace-active branch', () => {
    expect(WorkspaceContextOutputSchema.safeParse({}).success).toBe(false);
    const ok = WorkspaceContextOutputSchema.parse({
      workspaceId: 'w1',
      agentId: 'a1',
    });
    expect(ok).toEqual({ workspaceId: 'w1', agentId: 'a1' });
  });
});

describe('AgentScopeSchema — parser-contract preservation', () => {
  // Mirrors parseOptionalAgentScope (memories.ts:617). Any non-string
  // non-array input silently coerces to undefined; no 400.

  it.each(['all', 'self', 'others', 'agent-42'])('accepts string %s', v => {
    expect(AgentScopeSchema.parse(v)).toBe(v);
  });

  it('accepts array of agent ids', () => {
    expect(AgentScopeSchema.parse(['a1', 'a2'])).toEqual(['a1', 'a2']);
  });

  it('silently coerces non-string non-array inputs to undefined (no 400)', () => {
    expect(AgentScopeSchema.parse(42)).toBeUndefined();
    expect(AgentScopeSchema.parse({})).toBeUndefined();
    expect(AgentScopeSchema.parse(null)).toBeUndefined();
  });
});

describe('RetrievalModeSchema', () => {
  it.each(['flat', 'tiered', 'abstract-aware'])('accepts %s', v => {
    expect(RetrievalModeSchema.safeParse(v).success).toBe(true);
  });

  it('rejects unknown modes', () => {
    expect(RetrievalModeSchema.safeParse('hybrid').success).toBe(false);
  });
});

describe('IsoTimestamp — parser-contract preservation', () => {
  // Mirrors parseOptionalIsoTimestamp (memories.ts:641). Empty string
  // and null are treated as absent (no 400); any other non-ISO value
  // throws.

  it('accepts a valid ISO-8601 timestamp', () => {
    expect(IsoTimestamp.parse('2026-01-15T12:00:00Z')).toBe('2026-01-15T12:00:00Z');
  });

  it('treats empty string / null / undefined as absent (undefined, no 400)', () => {
    expect(IsoTimestamp.parse('')).toBeUndefined();
    expect(IsoTimestamp.parse(null)).toBeUndefined();
    expect(IsoTimestamp.parse(undefined)).toBeUndefined();
  });

  it('rejects non-empty garbage strings with 400', () => {
    expect(IsoTimestamp.safeParse('not-a-date').success).toBe(false);
  });
});

describe('NonEmptyString — parser-contract preservation', () => {
  // Mirrors requireBodyString (memories.ts:571): truthy + typeof string.
  // No trim; whitespace-only is truthy and passes.

  it('rejects empty string', () => {
    expect(NonEmptyString.safeParse('').success).toBe(false);
  });

  it('rejects non-string inputs', () => {
    expect(NonEmptyString.safeParse(42).success).toBe(false);
    expect(NonEmptyString.safeParse(null).success).toBe(false);
    expect(NonEmptyString.safeParse(undefined).success).toBe(false);
  });

  it('does NOT trim — preserves surrounding whitespace verbatim', () => {
    const parsed = NonEmptyString.parse('  hello  ');
    expect(parsed).toBe('  hello  ');
  });

  it('accepts whitespace-only strings to match requireBodyString truthy check', () => {
    // Current requireBodyString accepts "   " because it is truthy and a
    // string. Do not tighten this here — handlers may rely on it.
    expect(NonEmptyString.safeParse('   ').success).toBe(true);
  });
});
