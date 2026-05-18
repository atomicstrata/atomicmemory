/**
 * @file AtomicMemory namespace lifecycle HTTP wiring
 *
 * Exercises each of the 7 lifecycle methods against a mocked fetch:
 *   consolidate, decay, cap, stats, resetSource, reconcile,
 *   reconcileStatus.
 * All routes are user-scoped per core (no workspace_id / agent_id on
 * these routes); tests verify body/query shape and response plumbing
 * against the actual core route contracts documented at memories.ts.
 *
 * Wire format is snake_case; SDK surface is camelCase. Mocks use the
 * snake_case shape core actually emits; assertions use the camelCase
 * shape the handle returns.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AtomicMemoryProvider } from '../atomicmemory-provider';
import type { AtomicMemoryHandle } from '../handle';
import {
  jsonResponse,
  installFetchMock,
} from '../../__tests__/shared/http-mocks';

const API_URL = 'https://example.invalid';
const USER_ID = 'u1';

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
// consolidate (scan + execute)
// ---------------------------------------------------------------------------

describe('atomicmemory.lifecycle.consolidate', () => {
  it('POSTs to /memories/consolidate with user_id only (default scan)', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        memories_scanned: 42,
        clusters_found: 3,
        memories_in_clusters: 9,
        clusters: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }],
      }),
    );

    const handle = createHandle();
    const result = await handle.lifecycle.consolidate(USER_ID);

    const call = capturedCall(mockFetch);
    expect(call.method).toBe('POST');
    expect(call.url).toBe(`${API_URL}/v1/memories/consolidate`);
    expect(call.body).toEqual({ user_id: USER_ID });
    expect(result).toEqual({
      memoriesScanned: 42,
      clustersFound: 3,
      memoriesInClusters: 9,
      clusters: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }],
    });
  });

  it('forwards execute:true when the option is passed', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        clusters_consolidated: 2,
        memories_archived: 5,
        memories_created: 2,
        consolidated_memory_ids: ['m1', 'm2'],
      }),
    );

    const handle = createHandle();
    const result = await handle.lifecycle.consolidate(USER_ID, true);

    expect(capturedCall(mockFetch).body).toEqual({
      user_id: USER_ID,
      execute: true,
    });
    expect(result).toEqual({
      clustersConsolidated: 2,
      memoriesArchived: 5,
      memoriesCreated: 2,
      consolidatedMemoryIds: ['m1', 'm2'],
    });
  });

  it('does not forward execute when false (matches core default at memories.ts:305)', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        memories_scanned: 0,
        clusters_found: 0,
        memories_in_clusters: 0,
        clusters: [],
      }),
    );
    const handle = createHandle();
    await handle.lifecycle.consolidate(USER_ID, false);
    expect(capturedCall(mockFetch).body?.execute).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// decay
// ---------------------------------------------------------------------------

describe('atomicmemory.lifecycle.decay', () => {
  it('POSTs to /memories/decay with user_id only (dryRun defaults to true server-side)', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        memories_evaluated: 10,
        candidates_for_archival: [
          {
            id: 'm1',
            content: 'c1',
            retention_score: 0.1,
            importance: 0.5,
            days_since_access: 30,
            access_count: 0,
          },
        ],
        retention_threshold: 0.2,
        avg_retention_score: 0.5,
        archived: 0,
      }),
    );

    const handle = createHandle();
    const result = await handle.lifecycle.decay(USER_ID);

    const call = capturedCall(mockFetch);
    expect(call.method).toBe('POST');
    expect(call.url).toBe(`${API_URL}/v1/memories/decay`);
    expect(call.body).toEqual({ user_id: USER_ID });
    expect(result.memoriesEvaluated).toBe(10);
    expect(result.candidatesForArchival[0].retentionScore).toBe(0.1);
    expect(result.retentionThreshold).toBe(0.2);
    expect(result.avgRetentionScore).toBe(0.5);
    expect(result.archived).toBe(0);
  });

  it('forwards dry_run:false when the option is explicitly passed', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        memories_evaluated: 10,
        candidates_for_archival: [],
        retention_threshold: 0.2,
        avg_retention_score: 0.5,
        archived: 2,
      }),
    );
    const handle = createHandle();
    await handle.lifecycle.decay(USER_ID, false);
    expect(capturedCall(mockFetch).body).toEqual({
      user_id: USER_ID,
      dry_run: false,
    });
  });

  it('does not forward dry_run when true (core defaults to dry run)', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        memories_evaluated: 0,
        candidates_for_archival: [],
        retention_threshold: 0.2,
        avg_retention_score: 0,
        archived: 0,
      }),
    );
    const handle = createHandle();
    await handle.lifecycle.decay(USER_ID, true);
    expect(capturedCall(mockFetch).body?.dry_run).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// cap / stats (GET query-string routes)
// ---------------------------------------------------------------------------

describe('atomicmemory.lifecycle.cap', () => {
  it('GETs /memories/cap with user_id query param', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        active_memories: 50,
        max_memories: 100,
        status: 'ok',
        usage_ratio: 0.5,
        recommendation: 'none',
      }),
    );

    const handle = createHandle();
    const result = await handle.lifecycle.cap(USER_ID);

    const call = capturedCall(mockFetch);
    expect(call.url).toBe(`${API_URL}/v1/memories/cap?user_id=${USER_ID}`);
    expect(result).toEqual({
      activeMemories: 50,
      maxMemories: 100,
      status: 'ok',
      usageRatio: 0.5,
      recommendation: 'none',
    });
  });

  it('accepts all three CapStatus values from core (ok | warn | exceeded)', async () => {
    // Matches core's CapStatus at memory-lifecycle.ts:133. Regression for
    // the earlier SDK mismatch where we advertised 'warning' / 'over'.
    const scenarios = [
      { status: 'ok' as const, usage_ratio: 0.5, recommendation: 'none' as const },
      { status: 'warn' as const, usage_ratio: 0.85, recommendation: 'consolidate' as const },
      { status: 'exceeded' as const, usage_ratio: 1.2, recommendation: 'consolidate-and-decay' as const },
    ];

    for (const s of scenarios) {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          active_memories: 50,
          max_memories: 100,
          status: s.status,
          usage_ratio: s.usage_ratio,
          recommendation: s.recommendation,
        }),
      );
      const handle = createHandle();
      const result = await handle.lifecycle.cap(USER_ID);
      expect(result.status).toBe(s.status);
    }
  });
});

describe('atomicmemory.lifecycle.stats', () => {
  it('GETs /memories/stats with user_id query param and returns camelCase', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        count: 42,
        avg_importance: 0.6,
        source_distribution: { chatgpt: 30, claude: 12 },
      }),
    );

    const handle = createHandle();
    const result = await handle.lifecycle.stats(USER_ID);

    const call = capturedCall(mockFetch);
    expect(call.url).toBe(`${API_URL}/v1/memories/stats?user_id=${USER_ID}`);
    expect(result).toEqual({
      count: 42,
      avgImportance: 0.6,
      sourceDistribution: { chatgpt: 30, claude: 12 },
    });
  });
});

// ---------------------------------------------------------------------------
// resetSource
// ---------------------------------------------------------------------------

describe('atomicmemory.lifecycle.resetSource', () => {
  it('POSTs to /memories/reset-source with user_id + source_site', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        deleted_memories: 12,
        deleted_episodes: 3,
      }),
    );

    const handle = createHandle();
    const result = await handle.lifecycle.resetSource(USER_ID, 'chatgpt');

    const call = capturedCall(mockFetch);
    expect(call.method).toBe('POST');
    expect(call.url).toBe(`${API_URL}/v1/memories/reset-source`);
    expect(call.body).toEqual({
      user_id: USER_ID,
      source_site: 'chatgpt',
    });
    expect(result.success).toBe(true);
    expect(result.deletedMemories).toBe(12);
    expect(result.deletedEpisodes).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// reconcile / reconcileStatus
// ---------------------------------------------------------------------------

describe('atomicmemory.lifecycle.reconcile', () => {
  it('POSTs to /memories/reconcile with user_id in the body (per-user mode)', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        processed: 5,
        resolved: 3,
        noops: 1,
        updates: 1,
        supersedes: 1,
        deletes: 0,
        adds: 0,
        errors: 0,
        duration_ms: 125,
      }),
    );

    const handle = createHandle();
    const result = await handle.lifecycle.reconcile(USER_ID);

    const call = capturedCall(mockFetch);
    expect(call.method).toBe('POST');
    expect(call.url).toBe(`${API_URL}/v1/memories/reconcile`);
    expect(call.body).toEqual({ user_id: USER_ID });
    expect(result).toEqual({
      processed: 5,
      resolved: 3,
      noops: 1,
      updates: 1,
      supersedes: 1,
      deletes: 0,
      adds: 0,
      errors: 0,
      durationMs: 125,
    });
  });
});

describe('atomicmemory.lifecycle.reconcileAll', () => {
  it('POSTs to /memories/reconcile with NO user_id (all-users batch mode)', async () => {
    // Core routes the no-user_id case to reconcileDeferredAll() at
    // memories.ts:397-400. Separated from reconcile() so a missing
    // argument can't silently trigger the privileged all-users pass.
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        processed: 120,
        resolved: 90,
        noops: 10,
        updates: 30,
        supersedes: 15,
        deletes: 5,
        adds: 0,
        errors: 0,
        duration_ms: 4500,
      }),
    );

    const handle = createHandle();
    const result = await handle.lifecycle.reconcileAll();

    const call = capturedCall(mockFetch);
    expect(call.method).toBe('POST');
    expect(call.url).toBe(`${API_URL}/v1/memories/reconcile`);
    expect(call.body).toEqual({});
    expect(call.body?.user_id).toBeUndefined();
    expect(result.processed).toBe(120);
    expect(result.durationMs).toBe(4500);
  });
});

describe('atomicmemory.lifecycle.reconcileStatus', () => {
  it('GETs /memories/reconcile/status with user_id query param', async () => {
    // ReconcileStatus is an open shape — pass through without field translation.
    const status = { pending: 3, enabled: true };
    mockFetch.mockResolvedValueOnce(jsonResponse(status));

    const handle = createHandle();
    const result = await handle.lifecycle.reconcileStatus(USER_ID);

    const call = capturedCall(mockFetch);
    expect(call.url).toBe(
      `${API_URL}/v1/memories/reconcile/status?user_id=${USER_ID}`,
    );
    expect(result).toEqual(status);
  });
});

// ---------------------------------------------------------------------------
// No workspace contamination — lifecycle routes never accept workspace scope
// ---------------------------------------------------------------------------

describe('lifecycle methods never emit workspace fields on the wire', () => {
  it('consolidate body has no workspace_id / agent_id / agent_scope', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        memories_scanned: 0,
        clusters_found: 0,
        memories_in_clusters: 0,
        clusters: [],
      }),
    );
    const handle = createHandle();
    await handle.lifecycle.consolidate(USER_ID);
    const body = capturedCall(mockFetch).body!;
    expect(body.workspace_id).toBeUndefined();
    expect(body.agent_id).toBeUndefined();
    expect(body.agent_scope).toBeUndefined();
  });

  it('cap query has no workspace_id / agent_id / agent_scope', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        active_memories: 0,
        max_memories: 100,
        status: 'ok',
        usage_ratio: 0,
        recommendation: 'none',
      }),
    );
    const handle = createHandle();
    await handle.lifecycle.cap(USER_ID);
    const url = capturedCall(mockFetch).url;
    expect(url).not.toContain('workspace_id');
    expect(url).not.toContain('agent_id');
    expect(url).not.toContain('agent_scope');
  });
});
