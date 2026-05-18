/**
 * @file Tests for the `apiVersion` config field on AtomicMemoryProvider.
 *
 * Core mounts its routers under `/v1/memories` and `/v1/agents`
 * (atomicmemory-core/src/app/create-app.ts:31-32). The SDK prepends
 * `/${apiVersion}` to every core-facing path. This suite verifies:
 *   - the default prefix is `/v1` (matching core)
 *   - overriding `apiVersion` changes every provider + namespace route
 *   - passing `apiVersion: ''` disables prefixing (legacy / test hook)
 *   - the prefix is applied consistently across the V3 provider surface
 *     AND the `sdk.atomicmemory.*` namespace handle
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AtomicMemoryProvider } from '../atomicmemory-provider';
import { normalizeApiVersion } from '../path';
import type { AtomicMemoryHandle } from '../handle';
import {
  jsonResponse,
  installFetchMock,
} from '../../__tests__/shared/http-mocks';

const API_URL = 'https://test.atomicmemory.dev';

let mockFetch: ReturnType<typeof vi.fn>;
beforeEach(() => {
  mockFetch = installFetchMock();
});

function capturedUrl(): string {
  return mockFetch.mock.calls[0][0] as string;
}

// ---------------------------------------------------------------------------
// normalizeApiVersion unit coverage
// ---------------------------------------------------------------------------

describe('normalizeApiVersion', () => {
  it('wraps a bare version segment with a leading slash', () => {
    expect(normalizeApiVersion('v1')).toBe('/v1');
    expect(normalizeApiVersion('v2')).toBe('/v2');
  });

  it('strips leading and trailing slashes', () => {
    expect(normalizeApiVersion('/v1')).toBe('/v1');
    expect(normalizeApiVersion('v1/')).toBe('/v1');
    expect(normalizeApiVersion('/v1/')).toBe('/v1');
    expect(normalizeApiVersion('//v1//')).toBe('/v1');
  });

  it('returns empty string for empty input (disables prefixing)', () => {
    expect(normalizeApiVersion('')).toBe('');
    expect(normalizeApiVersion('/')).toBe('');
    expect(normalizeApiVersion('//')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Default: /v1 prefix on every route
// ---------------------------------------------------------------------------

describe('default apiVersion = v1', () => {
  it('V3 provider.ingest hits /v1/memories/ingest', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        episode_id: 'e1',
        facts_extracted: 1,
        memories_stored: 1,
        memories_updated: 0,
        memories_deleted: 0,
        memories_skipped: 0,
        stored_memory_ids: ['m1'],
        updated_memory_ids: [],
        links_created: 0,
        composites_created: 0,
      }),
    );
    const provider = new AtomicMemoryProvider({ apiUrl: API_URL });
    await provider.ingest({
      mode: 'text',
      content: 'x',
      scope: { user: 'u1' },
    });
    expect(capturedUrl()).toBe(`${API_URL}/v1/memories/ingest`);
  });

  it('V3 provider.search hits /v1/memories/search/fast', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ memories: [], count: 0 }),
    );
    const provider = new AtomicMemoryProvider({ apiUrl: API_URL });
    await provider.search({ query: 'q', scope: { user: 'u1' } });
    expect(capturedUrl()).toBe(`${API_URL}/v1/memories/search/fast`);
  });

  it('V3 package extension hits /v1/memories/search', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ memories: [], injection_text: '', estimated_context_tokens: 0, budget_constrained: false }),
    );
    const provider = new AtomicMemoryProvider({ apiUrl: API_URL });
    await provider.package({
      query: 'q',
      scope: { user: 'u1' },
      limit: 5,
    });
    expect(capturedUrl()).toBe(`${API_URL}/v1/memories/search`);
  });

  it('V3 searchAsOf extension hits /v1/memories/search', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ memories: [] }));
    const provider = new AtomicMemoryProvider({ apiUrl: API_URL });
    await provider.searchAsOf({
      query: 'q',
      scope: { user: 'u1' },
      asOf: new Date('2026-01-01T00:00:00Z'),
    });
    expect(capturedUrl()).toBe(`${API_URL}/v1/memories/search`);
  });

  it('V3 history extension hits /v1/memories/:id/audit', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ trail: [] }));
    const provider = new AtomicMemoryProvider({ apiUrl: API_URL });
    await provider.history({ id: 'm1', scope: { user: 'u1' } });
    expect(capturedUrl()).toBe(
      `${API_URL}/v1/memories/m1/audit?user_id=u1`,
    );
  });

  it('V3 health extension hits /v1/memories/health', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ status: 'ok' }));
    const provider = new AtomicMemoryProvider({ apiUrl: API_URL });
    await provider.health();
    expect(capturedUrl()).toBe(`${API_URL}/v1/memories/health`);
  });

  it('namespace.list hits /v1/memories/list', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ memories: [], count: 0 }),
    );
    const handle = new AtomicMemoryProvider({
      apiUrl: API_URL,
    }).getExtension<AtomicMemoryHandle>('atomicmemory.base')!;
    await handle.list({ kind: 'user', userId: 'u1' });
    expect(capturedUrl()).toContain(`${API_URL}/v1/memories/list?`);
  });

  it('namespace.lifecycle.cap hits /v1/memories/cap', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        activeMemories: 0,
        maxMemories: 100,
        status: 'ok',
        usageRatio: 0,
        recommendation: 'none',
      }),
    );
    const handle = new AtomicMemoryProvider({
      apiUrl: API_URL,
    }).getExtension<AtomicMemoryHandle>('atomicmemory.base')!;
    await handle.lifecycle.cap('u1');
    expect(capturedUrl()).toBe(`${API_URL}/v1/memories/cap?user_id=u1`);
  });
});

// ---------------------------------------------------------------------------
// Custom apiVersion (forward-compat for /v2, etc.)
// ---------------------------------------------------------------------------

describe('custom apiVersion override', () => {
  it('forwards the overridden prefix across V3 provider routes', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ memories: [], count: 0 }),
    );
    const provider = new AtomicMemoryProvider({
      apiUrl: API_URL,
      apiVersion: 'v2',
    });
    await provider.search({ query: 'q', scope: { user: 'u1' } });
    expect(capturedUrl()).toBe(`${API_URL}/v2/memories/search/fast`);
  });

  it('forwards the overridden prefix across namespace handle routes', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ memories: [], count: 0 }),
    );
    const handle = new AtomicMemoryProvider({
      apiUrl: API_URL,
      apiVersion: 'v2',
    }).getExtension<AtomicMemoryHandle>('atomicmemory.base')!;
    await handle.list({ kind: 'user', userId: 'u1' });
    expect(capturedUrl()).toContain(`${API_URL}/v2/memories/list?`);
  });

  it('forwards the overridden prefix across V3 package/searchAsOf/history/health', async () => {
    const provider = new AtomicMemoryProvider({
      apiUrl: API_URL,
      apiVersion: 'v2',
    });

    mockFetch.mockResolvedValueOnce(
      jsonResponse({ memories: [], injection_text: '', estimated_context_tokens: 0, budget_constrained: false }),
    );
    await provider.package({ query: 'q', scope: { user: 'u1' } });
    expect(capturedUrl()).toBe(`${API_URL}/v2/memories/search`);
    mockFetch.mockClear();

    mockFetch.mockResolvedValueOnce(jsonResponse({ memories: [] }));
    await provider.searchAsOf({
      query: 'q',
      scope: { user: 'u1' },
      asOf: new Date('2026-01-01T00:00:00Z'),
    });
    expect(capturedUrl()).toBe(`${API_URL}/v2/memories/search`);
    mockFetch.mockClear();

    mockFetch.mockResolvedValueOnce(jsonResponse({ trail: [] }));
    await provider.history({ id: 'm1', scope: { user: 'u1' } });
    expect(capturedUrl()).toBe(`${API_URL}/v2/memories/m1/audit?user_id=u1`);
    mockFetch.mockClear();

    mockFetch.mockResolvedValueOnce(jsonResponse({ status: 'ok' }));
    await provider.health();
    expect(capturedUrl()).toBe(`${API_URL}/v2/memories/health`);
  });
});

// ---------------------------------------------------------------------------
// Disable prefixing (legacy deployments that never versioned their mount)
// ---------------------------------------------------------------------------

describe('apiVersion = "" disables prefixing', () => {
  it('V3 provider.ingest hits /memories/ingest (no prefix)', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        episode_id: 'e1',
        facts_extracted: 0,
        memories_stored: 0,
        memories_updated: 0,
        memories_deleted: 0,
        memories_skipped: 0,
        stored_memory_ids: [],
        updated_memory_ids: [],
        links_created: 0,
        composites_created: 0,
      }),
    );
    const provider = new AtomicMemoryProvider({
      apiUrl: API_URL,
      apiVersion: '',
    });
    await provider.ingest({
      mode: 'text',
      content: 'x',
      scope: { user: 'u1' },
    });
    expect(capturedUrl()).toBe(`${API_URL}/memories/ingest`);
  });

  it('namespace.get hits /memories/:id (no prefix)', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ id: 'm1', content: 'x' }),
    );
    const handle = new AtomicMemoryProvider({
      apiUrl: API_URL,
      apiVersion: '',
    }).getExtension<AtomicMemoryHandle>('atomicmemory.base')!;
    await handle.get('m1', { kind: 'user', userId: 'u1' });
    expect(capturedUrl()).toContain(`${API_URL}/memories/m1?`);
  });
});
