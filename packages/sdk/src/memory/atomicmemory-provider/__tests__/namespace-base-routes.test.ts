/**
 * @file AtomicMemory namespace base-route HTTP wiring
 *
 * Tests each of the 9 base-route methods on the AtomicMemoryHandle:
 * HTTP endpoint, request-body/query shape, response mapping, and scope
 * serialization (user vs workspace). Uses `globalThis.fetch` mocking,
 * same pattern as the provider-level tests.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AtomicMemoryProvider } from '../atomicmemory-provider';
import type {
  AtomicMemoryHandle,
  AtomicMemoryIngestInput,
  AtomicMemorySearchRequest,
  MemoryScope,
} from '../handle';
import {
  jsonResponse,
  installFetchMock,
} from '../../__tests__/shared/http-mocks';

const API_URL = 'https://example.invalid';
const USER_SCOPE: MemoryScope = { kind: 'user', userId: 'u1' };
const WORKSPACE_SCOPE: MemoryScope = {
  kind: 'workspace',
  userId: 'u1',
  workspaceId: 'ws1',
  agentId: 'a1',
};

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
// ingestFull / ingestQuick
// ---------------------------------------------------------------------------

describe('atomicmemory.ingestFull', () => {
  it('POSTs to /memories/ingest with user-scope body', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        episode_id:'e1',
        facts_extracted:2,
        memories_stored:2,
        memories_updated:0,
        memories_deleted:0,
        memories_skipped:0,
        stored_memory_ids: ['m1', 'm2'],
        updated_memory_ids: [],
        links_created:0,
        composites_created:0,
      }),
    );

    const handle = createHandle();
    const input: AtomicMemoryIngestInput = {
      conversation: 'I prefer dark mode.',
      sourceSite: 'chatgpt',
      sourceUrl: 'https://chat.openai.com/c/x',
      configOverride: { hybridSearchEnabled: true },
    };

    const result = await handle.ingestFull(input, USER_SCOPE);

    const call = capturedCall(mockFetch);
    expect(call.method).toBe('POST');
    expect(call.url).toBe(`${API_URL}/v1/memories/ingest`);
    expect(call.body).toEqual({
      user_id: 'u1',
      conversation: 'I prefer dark mode.',
      source_site: 'chatgpt',
      source_url: 'https://chat.openai.com/c/x',
      config_override: { hybridSearchEnabled: true },
    });
    expect(result.episodeId).toBe('e1');
    expect(result.storedMemoryIds).toEqual(['m1', 'm2']);
    expect(result.updatedMemoryIds).toEqual([]);
  });

  it('includes workspace_id and agent_id on workspace-scope body', async () => {
    // agent_scope is intentionally omitted — core's parseIngestBody
    // doesn't consume it on ingest (memories.ts:515-528). See
    // "agent_scope wire serialization" suite below for the explicit
    // guarantee that ingest omits agent_scope.
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        episode_id:'e1',
        facts_extracted:0,
        memories_stored:0,
        memories_updated:0,
        memories_deleted:0,
        memories_skipped:0,
        stored_memory_ids: [], updated_memory_ids: [],
        links_created:0,
        composites_created:0,
      }),
    );
    const handle = createHandle();

    await handle.ingestFull(
      { conversation: 'x', sourceSite: 's' },
      { ...WORKSPACE_SCOPE, agentScope: 'self' },
    );

    const body = capturedCall(mockFetch).body!;
    expect(body.user_id).toBe('u1');
    expect(body.workspace_id).toBe('ws1');
    expect(body.agent_id).toBe('a1');
    expect(body.agent_scope).toBeUndefined();
  });

  it('forwards thread scope as session_id on ingest', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ episode_id:'e1', facts_extracted:0, memories_stored:0, memories_updated:0, memories_deleted:0, memories_skipped:0, stored_memory_ids: [], updated_memory_ids: [], links_created:0, composites_created:0 }),
    );
    const handle = createHandle();

    await handle.ingestFull(
      { conversation: 'x', sourceSite: 's' },
      { ...USER_SCOPE, thread: 'thread-1' },
    );

    expect(capturedCall(mockFetch).body?.session_id).toBe('thread-1');
  });

  it('forwards visibility on workspace scope', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ episode_id:'e1', facts_extracted:0, memories_stored:0, memories_updated:0, memories_deleted:0, memories_skipped:0, stored_memory_ids: [], updated_memory_ids: [], links_created:0, composites_created:0 }),
    );
    const handle = createHandle();

    await handle.ingestFull(
      { conversation: 'x', sourceSite: 's', visibility: 'agent_only' },
      WORKSPACE_SCOPE,
    );

    const body = capturedCall(mockFetch).body!;
    expect(body.visibility).toBe('agent_only');
  });

  it('rejects user-scope ingest with visibility set', async () => {
    const handle = createHandle();
    await expect(
      handle.ingestFull(
        { conversation: 'x', sourceSite: 's', visibility: 'workspace' },
        USER_SCOPE,
      ),
    ).rejects.toThrow(/visibility/i);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('atomicmemory.ingestQuick', () => {
  it('POSTs to /memories/ingest/quick without skip_extraction by default', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ episode_id:'e1', facts_extracted:0, memories_stored:0, memories_updated:0, memories_deleted:0, memories_skipped:0, stored_memory_ids: [], updated_memory_ids: [], links_created:0, composites_created:0 }),
    );
    const handle = createHandle();
    await handle.ingestQuick({ conversation: 'x', sourceSite: 's' }, USER_SCOPE);

    const call = capturedCall(mockFetch);
    expect(call.url).toBe(`${API_URL}/v1/memories/ingest/quick`);
    expect(call.body?.skip_extraction).toBeUndefined();
  });

  it('sets skip_extraction: true when the option is passed', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ episode_id:'e1', facts_extracted:0, memories_stored:0, memories_updated:0, memories_deleted:0, memories_skipped:0, stored_memory_ids: [], updated_memory_ids: [], links_created:0, composites_created:0 }),
    );
    const handle = createHandle();
    await handle.ingestQuick(
      { conversation: 'x', sourceSite: 's' },
      USER_SCOPE,
      { skipExtraction: true },
    );
    expect(capturedCall(mockFetch).body?.skip_extraction).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// search / searchFast
// ---------------------------------------------------------------------------

describe('atomicmemory.search', () => {
  it('POSTs to /memories/search and maps snake_case response to camelCase', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        count: 2,
        retrieval_mode: 'flat',
        memories: [
          { id: 'm1', content: 'a', similarity: 0.9, score: 1.1 },
          { id: 'm2', content: 'b', similarity: 0.8, score: 0.9 },
        ],
        injection_text: '- a\n- b',
        citations: ['m1', 'm2'],
        observability: { retrieval: { stages: [] } },
      }),
    );

    const handle = createHandle();
    const request: AtomicMemorySearchRequest = {
      query: 'q',
      limit: 5,
      threshold: 0.72,
      asOf: new Date('2026-04-01T00:00:00Z'),
      retrievalMode: 'flat',
      configOverride: { hybridSearchEnabled: true, mmrLambda: 0.8 },
    };
    const result = await handle.search(request, USER_SCOPE);

    const call = capturedCall(mockFetch);
    expect(call.url).toBe(`${API_URL}/v1/memories/search`);
    expect(call.body).toEqual({
      user_id: 'u1',
      query: 'q',
      limit: 5,
      threshold: 0.72,
      as_of: '2026-04-01T00:00:00.000Z',
      retrieval_mode: 'flat',
      config_override: { hybridSearchEnabled: true, mmrLambda: 0.8 },
    });

    expect(result.count).toBe(2);
    expect(result.retrievalMode).toBe('flat');
    expect(result.results).toHaveLength(2);
    expect(result.results[0].memory.id).toBe('m1');
    expect(result.injectionText).toBe('- a\n- b');
    expect(result.citations).toEqual(['m1', 'm2']);
    expect(result.observability).toBeDefined();
  });

  it('forwards thread scope and maps returned session_id', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        count: 1,
        retrieval_mode: 'flat',
        memories: [{ id: 'm1', content: 'a', session_id: 'thread-1' }],
      }),
    );

    const handle = createHandle();
    const result = await handle.search(
      { query: 'q' },
      { ...USER_SCOPE, thread: 'thread-1' },
    );

    const call = capturedCall(mockFetch);
    expect(call.body?.session_id).toBe('thread-1');
    expect(result.results[0].memory.scope).toEqual({
      ...USER_SCOPE,
      thread: 'thread-1',
    });
  });

  it('rejects thread-scoped rows without matching session_id', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        count: 1,
        retrieval_mode: 'flat',
        memories: [{ id: 'm1', content: 'a' }],
      }),
    );

    const handle = createHandle();
    await expect(
      handle.search({ query: 'q' }, { ...USER_SCOPE, thread: 'thread-1' }),
    ).rejects.toThrow(/session_id/);
  });

});

describe('atomicmemory.searchFast', () => {
  it('POSTs to /memories/search/fast', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ count: 0, retrieval_mode: 'flat', memories: [] }),
    );
    const handle = createHandle();
    await handle.searchFast({ query: 'q' }, USER_SCOPE);
    expect(capturedCall(mockFetch).url).toBe(`${API_URL}/v1/memories/search/fast`);
  });
});

// ---------------------------------------------------------------------------
// expand / list / get / delete
// ---------------------------------------------------------------------------

describe('atomicmemory.expand', () => {
  it('POSTs memory_ids + scope fields to /memories/expand', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ memories: [{ id: 'm1', content: 'x' }] }),
    );
    const handle = createHandle();
    const memories = await handle.expand(['m1', 'm2'], USER_SCOPE);
    const call = capturedCall(mockFetch);
    expect(call.url).toBe(`${API_URL}/v1/memories/expand`);
    expect(call.body).toEqual({ user_id: 'u1', memory_ids: ['m1', 'm2'] });
    expect(memories).toHaveLength(1);
    expect(memories[0].id).toBe('m1');
  });
});

describe('atomicmemory.list', () => {
  it('GETs /memories/list with user_id + pagination', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        memories: [{ id: 'm1', content: 'a' }, { id: 'm2', content: 'b' }],
        count: 2,
      }),
    );
    const handle = createHandle();
    const page = await handle.list(USER_SCOPE, { limit: 10, offset: 0 });
    const call = capturedCall(mockFetch);
    expect(call.url).toContain(`${API_URL}/v1/memories/list?`);
    expect(call.url).toContain('user_id=u1');
    expect(call.url).toContain('limit=10');
    expect(page.count).toBe(2);
    expect(page.memories).toHaveLength(2);
  });

  it('forwards source_site + episode_id for user scope', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ memories: [], count: 0 }));
    const handle = createHandle();
    await handle.list(USER_SCOPE, { sourceSite: 'claude', episodeId: 'e1' });
    const call = capturedCall(mockFetch);
    expect(call.url).toContain('source_site=claude');
    expect(call.url).toContain('episode_id=e1');
  });

  it('forwards workspace_id + agent_id for workspace scope', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ memories: [], count: 0 }));
    const handle = createHandle();
    await handle.list(WORKSPACE_SCOPE);
    const call = capturedCall(mockFetch);
    expect(call.url).toContain('workspace_id=ws1');
    expect(call.url).toContain('agent_id=a1');
  });

  it('forwards thread scope and maps returned session_id', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        memories: [{ id: 'm1', content: 'a', session_id: 'thread-1' }],
        count: 1,
      }),
    );
    const handle = createHandle();
    const page = await handle.list({ ...WORKSPACE_SCOPE, thread: 'thread-1' });
    const call = capturedCall(mockFetch);
    expect(call.url).toContain('session_id=thread-1');
    expect(page.memories[0].scope).toEqual({
      ...WORKSPACE_SCOPE,
      thread: 'thread-1',
    });
  });

  it('rejects thread-scoped list rows without matching session_id', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ memories: [{ id: 'm1', content: 'a' }], count: 1 }),
    );
    const handle = createHandle();
    await expect(
      handle.list({ ...USER_SCOPE, thread: 'thread-1' }),
    ).rejects.toThrow(/session_id/);
  });
});

describe('atomicmemory.get', () => {
  it('GETs /memories/:id with scope params, returns Memory', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ id: 'm1', content: 'x' }));
    const handle = createHandle();
    const mem = await handle.get('m1', USER_SCOPE);
    const call = capturedCall(mockFetch);
    expect(call.url).toContain(`${API_URL}/v1/memories/m1?`);
    expect(call.url).toContain('user_id=u1');
    expect(mem?.id).toBe('m1');
  });

  it('returns null on 404', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ error: 'not found' }, 404));
    const handle = createHandle();
    const mem = await handle.get('missing', USER_SCOPE);
    expect(mem).toBeNull();
  });
});

describe('atomicmemory.delete', () => {
  it('DELETEs /memories/:id with scope params', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ success: true }));
    const handle = createHandle();
    await handle.delete('m1', USER_SCOPE);
    const call = capturedCall(mockFetch);
    expect(call.method).toBe('DELETE');
    expect(call.url).toContain(`${API_URL}/v1/memories/m1?`);
    expect(call.url).toContain('user_id=u1');
  });

  it('treats 404 as a no-op (idempotent delete)', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ error: 'not found' }, 404));
    const handle = createHandle();
    await expect(handle.delete('missing', USER_SCOPE)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Workspace scope preservation on returned memories
// ---------------------------------------------------------------------------

describe('workspace scope round-trip on returned memories', () => {
  it('get() preserves full workspace scope on the returned memory', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ id: 'm1', content: 'x' }),
    );
    const handle = createHandle();
    const mem = await handle.get('m1', WORKSPACE_SCOPE);
    expect(mem?.scope).toEqual(WORKSPACE_SCOPE);
    // V3's flat Scope has no place for these fields; AtomicMemoryMemory does.
    expect((mem?.scope as { workspaceId?: string }).workspaceId).toBe('ws1');
    expect((mem?.scope as { agentId?: string }).agentId).toBe('a1');
  });

  it('list() preserves workspace scope on every memory in the page', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        memories: [
          { id: 'm1', content: 'a' },
          { id: 'm2', content: 'b' },
        ],
        count: 2,
      }),
    );
    const handle = createHandle();
    const page = await handle.list(WORKSPACE_SCOPE);
    expect(page.memories).toHaveLength(2);
    for (const m of page.memories) {
      expect(m.scope.kind).toBe('workspace');
      expect((m.scope as { workspaceId?: string }).workspaceId).toBe('ws1');
    }
  });

  it('expand() preserves workspace scope on every returned memory', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ memories: [{ id: 'm1', content: 'x' }] }),
    );
    const handle = createHandle();
    const memories = await handle.expand(['m1'], WORKSPACE_SCOPE);
    expect(memories[0].scope).toEqual(WORKSPACE_SCOPE);
  });

  it('search() preserves workspace scope on every result memory', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        count: 1,
        retrieval_mode: 'flat',
        memories: [{ id: 'm1', content: 'x', score: 0.9 }],
      }),
    );
    const handle = createHandle();
    const page = await handle.search({ query: 'q' }, WORKSPACE_SCOPE);
    expect(page.scope).toEqual(WORKSPACE_SCOPE);
    expect(page.results[0].memory.scope.kind).toBe('workspace');
  });
});

// ---------------------------------------------------------------------------
// agent_scope is only sent on search routes (core silently drops it elsewhere)
// ---------------------------------------------------------------------------

describe('agent_scope wire serialization', () => {
  const scopeWithAgentScope = {
    ...WORKSPACE_SCOPE,
    agentScope: 'self' as const,
  };

  it('search() forwards agent_scope on the request body', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ count: 0, retrieval_mode: 'flat', memories: [] }),
    );
    const handle = createHandle();
    await handle.search({ query: 'q' }, scopeWithAgentScope);
    expect(capturedCall(mockFetch).body?.agent_scope).toBe('self');
  });

  it('searchFast() forwards agent_scope on the request body', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ count: 0, retrieval_mode: 'flat', memories: [] }),
    );
    const handle = createHandle();
    await handle.searchFast({ query: 'q' }, scopeWithAgentScope);
    expect(capturedCall(mockFetch).body?.agent_scope).toBe('self');
  });

  it('expand() does NOT forward agent_scope (core drops it there)', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ memories: [] }));
    const handle = createHandle();
    await handle.expand(['m1'], scopeWithAgentScope);
    expect(capturedCall(mockFetch).body?.agent_scope).toBeUndefined();
  });

  it('list() does NOT forward agent_scope query param (core drops it there)', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ memories: [], count: 0 }));
    const handle = createHandle();
    await handle.list(scopeWithAgentScope);
    expect(capturedCall(mockFetch).url).not.toContain('agent_scope');
  });

  it('get() does NOT forward agent_scope query param', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ id: 'm1', content: 'x' }));
    const handle = createHandle();
    await handle.get('m1', scopeWithAgentScope);
    expect(capturedCall(mockFetch).url).not.toContain('agent_scope');
  });

  it('delete() does NOT forward agent_scope query param', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ success: true }));
    const handle = createHandle();
    await handle.delete('m1', scopeWithAgentScope);
    expect(capturedCall(mockFetch).url).not.toContain('agent_scope');
  });

  it('ingestFull() does NOT forward agent_scope on the body', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        episode_id:'e',
        facts_extracted:0,
        memories_stored:0,
        memories_updated:0,
        memories_deleted:0,
        memories_skipped:0,
        stored_memory_ids: [], updated_memory_ids: [],
        links_created:0,
        composites_created:0,
      }),
    );
    const handle = createHandle();
    await handle.ingestFull(
      { conversation: 'x', sourceSite: 's' },
      scopeWithAgentScope,
    );
    expect(capturedCall(mockFetch).body?.agent_scope).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Search result field population
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// agentScope echo-back honesty on routes that do not honor it
// ---------------------------------------------------------------------------

describe('returned memory scope honesty (non-search routes drop agentScope)', () => {
  const scopeWithAgentScope: MemoryScope = {
    ...WORKSPACE_SCOPE,
    agentScope: 'self',
  };

  it('get() strips agentScope from the returned memory\'s scope (core did not apply it)', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ id: 'm1', content: 'x' }));
    const handle = createHandle();
    const mem = await handle.get('m1', scopeWithAgentScope);
    expect(mem?.scope.kind).toBe('workspace');
    expect((mem?.scope as { agentScope?: string }).agentScope).toBeUndefined();
    // Workspace identifiers ARE preserved.
    expect((mem?.scope as { workspaceId?: string }).workspaceId).toBe('ws1');
    expect((mem?.scope as { agentId?: string }).agentId).toBe('a1');
  });

  it('list() strips agentScope from every returned memory\'s scope', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ memories: [{ id: 'm1', content: 'a' }], count: 1 }),
    );
    const handle = createHandle();
    const page = await handle.list(scopeWithAgentScope);
    expect(
      (page.memories[0].scope as { agentScope?: string }).agentScope,
    ).toBeUndefined();
  });

  it('expand() strips agentScope from every returned memory\'s scope', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ memories: [{ id: 'm1', content: 'x' }] }),
    );
    const handle = createHandle();
    const memories = await handle.expand(['m1'], scopeWithAgentScope);
    expect(
      (memories[0].scope as { agentScope?: string }).agentScope,
    ).toBeUndefined();
  });

  it('search() KEEPS agentScope on returned memory scope (core did apply it)', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        count: 1,
        retrieval_mode: 'flat',
        memories: [{ id: 'm1', content: 'x', score: 0.9 }],
      }),
    );
    const handle = createHandle();
    const page = await handle.search({ query: 'q' }, scopeWithAgentScope);
    expect(page.scope).toEqual(scopeWithAgentScope);
    expect(
      (page.results[0].memory.scope as { agentScope?: string }).agentScope,
    ).toBe('self');
  });
});

// ---------------------------------------------------------------------------
// list option scope compatibility
// ---------------------------------------------------------------------------

describe('list() rejects user-scope-only options on workspace scope', () => {
  it('rejects sourceSite on workspace scope (fail-closed before HTTP)', async () => {
    const handle = createHandle();
    await expect(
      handle.list(WORKSPACE_SCOPE, { sourceSite: 'claude' }),
    ).rejects.toThrow(/sourceSite/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects episodeId on workspace scope (fail-closed before HTTP)', async () => {
    const handle = createHandle();
    await expect(
      handle.list(WORKSPACE_SCOPE, { episodeId: 'ep1' }),
    ).rejects.toThrow(/episodeId/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('accepts sourceSite and episodeId on user scope (existing behavior)', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ memories: [], count: 0 }));
    const handle = createHandle();
    await expect(
      handle.list(USER_SCOPE, { sourceSite: 'claude', episodeId: 'ep1' }),
    ).resolves.toBeDefined();
  });
});

describe('search result field population', () => {
  it('populates explicit score semantics on each result (not just memory.metadata)', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        count: 1,
        retrieval_mode: 'flat',
        memories: [
          {
            id: 'm1',
            content: 'x',
            similarity: 0.42,
            semantic_similarity: 0.43,
            score: 1.11,
            ranking_score: 1.23,
            relevance: 0.43,
            importance: 0.7,
          },
        ],
      }),
    );
    const handle = createHandle();
    const page = await handle.search({ query: 'q' }, USER_SCOPE);
    const result = page.results[0];
    expect(result.score).toBe(1.23);
    expect(result.similarity).toBe(0.43);
    expect(result.rankingScore).toBe(1.23);
    expect(result.relevance).toBe(0.43);
    expect(result.importance).toBe(0.7);
  });

  it('leaves explicit optional fields undefined when core omits them', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        count: 1,
        retrieval_mode: 'flat',
        memories: [{ id: 'm1', content: 'x', score: 0.5 }],
      }),
    );
    const handle = createHandle();
    const page = await handle.search({ query: 'q' }, USER_SCOPE);
    expect(page.results[0].similarity).toBeUndefined();
    expect(page.results[0].rankingScore).toBe(0.5);
    expect(page.results[0].relevance).toBeUndefined();
    expect(page.results[0].importance).toBeUndefined();
    expect(page.results[0].score).toBe(0.5);
  });
});
