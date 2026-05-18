/**
 * @file AtomicMemory namespace agents HTTP wiring
 *
 * Covers the 5 agents methods against a mocked fetch. Verifies:
 *   - wire paths + methods (NB: under /v1/agents, NOT /v1/memories)
 *   - camel↔snake mapping on trust + conflict payloads
 *   - snake→camel + ISO→Date mapping on MemoryConflict rows
 *   - resolveConflict takes conflictId (no userId — core keys by id)
 *   - optional displayName on setTrust
 *   - getTrust returns null trustLevel (not 404) when no record exists
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AtomicMemoryProvider } from '../atomicmemory-provider';
import type {
  AgentConflict,
  AtomicMemoryHandle,
  ConflictResolution,
} from '../handle';
import {
  installFetchMock,
  jsonResponse,
} from '../../__tests__/shared/http-mocks';

const API_URL = 'https://example.invalid';
const USER_ID = 'u1';
const AGENT_ID = 'agent-researcher';

function createHandle(): AtomicMemoryHandle {
  return new AtomicMemoryProvider({ apiUrl: API_URL }).getExtension<AtomicMemoryHandle>(
    'atomicmemory.base',
  )!;
}

function capturedCall(
  mockFetch: ReturnType<typeof vi.fn>,
): { url: string; body?: Record<string, unknown>; method?: string } {
  const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
  const body =
    typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
  return { url, body, method: init?.method };
}

let mockFetch: ReturnType<typeof vi.fn>;
beforeEach(() => {
  mockFetch = installFetchMock();
});

// ---------------------------------------------------------------------------
// setTrust
// ---------------------------------------------------------------------------

describe('atomicmemory.agents.setTrust', () => {
  it('PUTs /v1/agents/trust with camelCase → snake_case body', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ agent_id: AGENT_ID, trust_level: 0.8 }),
    );

    const handle = createHandle();
    const result = await handle.agents.setTrust(USER_ID, AGENT_ID, 0.8);

    const call = capturedCall(mockFetch);
    expect(call.method).toBe('PUT');
    expect(call.url).toBe(`${API_URL}/v1/agents/trust`);
    expect(call.body).toEqual({
      user_id: USER_ID,
      agent_id: AGENT_ID,
      trust_level: 0.8,
    });
    expect(result).toEqual({ agentId: AGENT_ID, trustLevel: 0.8 });
  });

  it('forwards optional displayName as display_name when provided', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ agent_id: AGENT_ID, trust_level: 0.9 }),
    );
    const handle = createHandle();
    await handle.agents.setTrust(USER_ID, AGENT_ID, 0.9, 'Researcher Bot');
    expect(capturedCall(mockFetch).body?.display_name).toBe('Researcher Bot');
  });

  it('omits display_name when not provided', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ agent_id: AGENT_ID, trust_level: 0.5 }),
    );
    const handle = createHandle();
    await handle.agents.setTrust(USER_ID, AGENT_ID, 0.5);
    expect(capturedCall(mockFetch).body?.display_name).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getTrust
// ---------------------------------------------------------------------------

describe('atomicmemory.agents.getTrust', () => {
  it('GETs /v1/agents/trust with user_id + agent_id query params', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ agent_id: AGENT_ID, trust_level: 0.75 }),
    );

    const handle = createHandle();
    const result = await handle.agents.getTrust(USER_ID, AGENT_ID);

    const call = capturedCall(mockFetch);
    expect(call.method).toBeUndefined(); // GET
    expect(call.url).toBe(
      `${API_URL}/v1/agents/trust?user_id=${USER_ID}&agent_id=${AGENT_ID}`,
    );
    expect(result).toEqual({ agentId: AGENT_ID, trustLevel: 0.75 });
  });

  it('returns the core-default trust level when no record exists (does NOT 404 or emit null)', async () => {
    // Core's getTrustLevel returns DEFAULT_TRUST_LEVEL (0.5) rather
    // than null when no row matches — see
    // atomicmemory-core/src/db/agent-trust-repository.ts:46,56. The
    // route forwards that value verbatim (agents.ts:41-42). Callers
    // who need to distinguish "unset" from "explicitly 0.5" must
    // track provenance themselves; the wire does not expose the
    // distinction.
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ agent_id: AGENT_ID, trust_level: 0.5 }),
    );
    const handle = createHandle();
    const result = await handle.agents.getTrust(USER_ID, AGENT_ID);
    expect(result).toEqual({ agentId: AGENT_ID, trustLevel: 0.5 });
  });
});

// ---------------------------------------------------------------------------
// conflicts
// ---------------------------------------------------------------------------

describe('atomicmemory.agents.conflicts', () => {
  const rawConflict = {
    id: 'conflict-1',
    user_id: USER_ID,
    new_memory_id: 'mem-new',
    existing_memory_id: 'mem-existing',
    new_agent_id: 'agent-a',
    existing_agent_id: 'agent-b',
    new_trust_level: 0.8,
    existing_trust_level: 0.6,
    contradiction_confidence: 0.92,
    clarification_note: 'Conflicting facts about tech stack',
    status: 'open',
    resolution_policy: null,
    resolved_at: null,
    created_at: '2026-04-15T00:00:00.000Z',
    auto_resolve_after: '2026-04-22T00:00:00.000Z',
  };

  it('GETs /v1/agents/conflicts and maps snake→camel + ISO→Date', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ conflicts: [rawConflict], count: 1 }),
    );

    const handle = createHandle();
    const result = await handle.agents.conflicts(USER_ID);

    const call = capturedCall(mockFetch);
    expect(call.url).toBe(
      `${API_URL}/v1/agents/conflicts?user_id=${USER_ID}`,
    );
    expect(result.count).toBe(1);
    expect(result.conflicts).toHaveLength(1);

    const conflict: AgentConflict = result.conflicts[0];
    expect(conflict.id).toBe('conflict-1');
    expect(conflict.userId).toBe(USER_ID);
    expect(conflict.newMemoryId).toBe('mem-new');
    expect(conflict.existingMemoryId).toBe('mem-existing');
    expect(conflict.newAgentId).toBe('agent-a');
    expect(conflict.existingAgentId).toBe('agent-b');
    expect(conflict.newTrustLevel).toBe(0.8);
    expect(conflict.existingTrustLevel).toBe(0.6);
    expect(conflict.contradictionConfidence).toBe(0.92);
    expect(conflict.clarificationNote).toBe('Conflicting facts about tech stack');
    expect(conflict.status).toBe('open');
    expect(conflict.resolutionPolicy).toBeNull();
    expect(conflict.resolvedAt).toBeNull();
    expect(conflict.createdAt).toBeInstanceOf(Date);
    expect(conflict.createdAt.toISOString()).toBe('2026-04-15T00:00:00.000Z');
    expect(conflict.autoResolveAfter).toBeInstanceOf(Date);
    expect(conflict.autoResolveAfter?.toISOString()).toBe(
      '2026-04-22T00:00:00.000Z',
    );
  });

  it('coerces resolved_at + auto_resolve_after to null Dates when set', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        conflicts: [
          {
            ...rawConflict,
            status: 'resolved_new',
            resolution_policy: 'manual',
            resolved_at: '2026-04-20T12:00:00.000Z',
            auto_resolve_after: null,
          },
        ],
        count: 1,
      }),
    );
    const handle = createHandle();
    const result = await handle.agents.conflicts(USER_ID);
    const conflict = result.conflicts[0];
    expect(conflict.status).toBe('resolved_new');
    expect(conflict.resolutionPolicy).toBe('manual');
    expect(conflict.resolvedAt).toBeInstanceOf(Date);
    expect(conflict.resolvedAt?.toISOString()).toBe('2026-04-20T12:00:00.000Z');
    expect(conflict.autoResolveAfter).toBeNull();
  });

  it('returns an empty list when the user has no conflicts', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ conflicts: [], count: 0 }),
    );
    const handle = createHandle();
    const result = await handle.agents.conflicts(USER_ID);
    expect(result).toEqual({ conflicts: [], count: 0 });
  });
});

// ---------------------------------------------------------------------------
// resolveConflict
// ---------------------------------------------------------------------------

describe('atomicmemory.agents.resolveConflict', () => {
  it('PUTs /v1/agents/conflicts/:id/resolve with resolution in the body', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ id: 'conflict-1', status: 'resolved_new' }),
    );

    const handle = createHandle();
    const result = await handle.agents.resolveConflict(
      'conflict-1',
      'resolved_new',
    );

    const call = capturedCall(mockFetch);
    expect(call.method).toBe('PUT');
    expect(call.url).toBe(
      `${API_URL}/v1/agents/conflicts/conflict-1/resolve`,
    );
    expect(call.body).toEqual({ resolution: 'resolved_new' });
    expect(result).toEqual({ id: 'conflict-1', status: 'resolved_new' });
  });

  it('URL-encodes conflictId into the path', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ id: 'x', status: 'resolved_both' }),
    );
    const handle = createHandle();
    await handle.agents.resolveConflict(
      'conflict with spaces',
      'resolved_both',
    );
    expect(capturedCall(mockFetch).url).toContain(
      '/v1/agents/conflicts/conflict%20with%20spaces/resolve',
    );
  });

  it('covers every ConflictResolution variant', async () => {
    const variants: ConflictResolution[] = [
      'resolved_new',
      'resolved_existing',
      'resolved_both',
    ];
    for (const r of variants) {
      mockFetch = installFetchMock();
      mockFetch.mockResolvedValueOnce(jsonResponse({ id: 'c', status: r }));
      const handle = createHandle();
      const result = await handle.agents.resolveConflict('c', r);
      expect(result.status).toBe(r);
      expect(capturedCall(mockFetch).body?.resolution).toBe(r);
    }
  });

  it('does NOT send user_id — core keys resolve by conflictId (agents.ts:61-72)', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ id: 'c', status: 'resolved_new' }),
    );
    const handle = createHandle();
    await handle.agents.resolveConflict('c', 'resolved_new');
    const body = capturedCall(mockFetch).body!;
    expect(body.user_id).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// autoResolveConflicts
// ---------------------------------------------------------------------------

describe('atomicmemory.agents.autoResolveConflicts', () => {
  it('POSTs /v1/agents/conflicts/auto-resolve with user_id in body', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ resolved: 4 }));

    const handle = createHandle();
    const result = await handle.agents.autoResolveConflicts(USER_ID);

    const call = capturedCall(mockFetch);
    expect(call.method).toBe('POST');
    expect(call.url).toBe(`${API_URL}/v1/agents/conflicts/auto-resolve`);
    expect(call.body).toEqual({ user_id: USER_ID });
    expect(result).toEqual({ resolved: 4 });
  });

  it('returns resolved: 0 when no conflicts qualified', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ resolved: 0 }));
    const handle = createHandle();
    const result = await handle.agents.autoResolveConflicts(USER_ID);
    expect(result.resolved).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Workspace contamination guard
// ---------------------------------------------------------------------------

describe('agents methods never emit workspace fields on the wire', () => {
  const handle = (): AtomicMemoryHandle => createHandle();

  it('every method keeps workspace_id / agent_scope off the wire', async () => {
    // setTrust
    mockFetch = installFetchMock();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ agent_id: AGENT_ID, trust_level: 0.5 }),
    );
    await handle().agents.setTrust(USER_ID, AGENT_ID, 0.5);
    assertCleanCall(mockFetch);

    // getTrust
    mockFetch = installFetchMock();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ agent_id: AGENT_ID, trust_level: null }),
    );
    await handle().agents.getTrust(USER_ID, AGENT_ID);
    assertCleanCall(mockFetch);

    // conflicts
    mockFetch = installFetchMock();
    mockFetch.mockResolvedValueOnce(jsonResponse({ conflicts: [], count: 0 }));
    await handle().agents.conflicts(USER_ID);
    assertCleanCall(mockFetch);

    // resolveConflict
    mockFetch = installFetchMock();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ id: 'c', status: 'resolved_new' }),
    );
    await handle().agents.resolveConflict('c', 'resolved_new');
    assertCleanCall(mockFetch);

    // autoResolveConflicts
    mockFetch = installFetchMock();
    mockFetch.mockResolvedValueOnce(jsonResponse({ resolved: 0 }));
    await handle().agents.autoResolveConflicts(USER_ID);
    assertCleanCall(mockFetch);
  });
});

function assertCleanCall(mockFetch: ReturnType<typeof vi.fn>): void {
  const call = capturedCall(mockFetch);
  expect(call.url).not.toContain('workspace_id');
  expect(call.url).not.toContain('agent_scope');
  if (call.body) {
    expect(call.body.workspace_id).toBeUndefined();
    expect(call.body.agent_scope).toBeUndefined();
  }
}
