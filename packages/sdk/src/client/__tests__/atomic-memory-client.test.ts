/**
 * @file Tests for the `AtomicMemoryClient` aggregator surface.
 */

import { describe, expect, it, vi } from 'vitest';
import { AtomicMemoryClient } from '../atomic-memory-client';
import { MemoryClient } from '../memory-client';
import {
  installFetchMock,
  jsonResponse,
} from '../../memory/__tests__/shared/http-mocks';

describe('AtomicMemoryClient', () => {
  it('exposes `memory` (MemoryClient) and `storage` (StorageClient) namespaces', () => {
    const client = new AtomicMemoryClient({
      apiUrl: 'http://core.test',
      apiKey: 'k-1',
      userId: 'u-1',
    });
    expect(client.memory).toBeInstanceOf(MemoryClient);
    expect(typeof client.storage.put).toBe('function');
    expect(typeof client.storage.capabilities).toBe('function');
  });

  it('throws when apiUrl/apiKey/userId are missing', () => {
    expect(() => new AtomicMemoryClient({ apiUrl: '', apiKey: 'k', userId: 'u' })).toThrow();
    expect(() => new AtomicMemoryClient({ apiUrl: 'u', apiKey: '', userId: 'u' })).toThrow();
    expect(() => new AtomicMemoryClient({ apiUrl: 'u', apiKey: 'k', userId: '' })).toThrow();
  });

  it('forwards apiKey to the DEFAULT memory provider so memory requests carry Authorization: Bearer', async () => {
    // Regression: the default memory-provider registration used to
    // be `{ atomicmemory: { apiUrl } }` only — `apiKey` was dropped
    // silently, so the memory namespace fired unauthenticated
    // requests even when the caller supplied the same key that the
    // storage namespace was using. Every core deployment since the
    // auth middleware landed would 401 those requests. Explicitly
    // assert the Authorization header survives the round-trip.
    const mockFetch = installFetchMock();
    mockFetch.mockResolvedValueOnce(jsonResponse({ memories: [], count: 0 }));
    const client = new AtomicMemoryClient({
      apiUrl: 'http://core.test',
      apiKey: 'auth-token-xyz',
      userId: 'u-1',
    });
    await client.memory.initialize();
    await client.memory.search({ query: 'hi', scope: { user: 'u-1' } });
    const init = mockFetch.mock.calls[0][1] as { headers: Record<string, string> };
    expect(init.headers.Authorization).toBe('Bearer auth-token-xyz');
    vi.unstubAllGlobals();
  });

  it('does NOT override an explicit `memory` config — caller-supplied providers win', async () => {
    // Defensive: if the caller passed `memory: { providers: { ... } }`
    // we MUST NOT inject our apiKey into their provider list. The
    // caller is asserting full control over the memory namespace's
    // auth posture.
    const mockFetch = installFetchMock();
    mockFetch.mockResolvedValueOnce(jsonResponse({ memories: [], count: 0 }));
    const client = new AtomicMemoryClient({
      apiUrl: 'http://core.test',
      apiKey: 'aggregator-key',
      userId: 'u-1',
      memory: {
        providers: { atomicmemory: { apiUrl: 'http://core.test' } },
      },
    });
    await client.memory.initialize();
    await client.memory.search({ query: 'hi', scope: { user: 'u-1' } });
    const init = mockFetch.mock.calls[0][1] as { headers: Record<string, string> };
    expect(init.headers.Authorization).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it('forwards the supplied fetch override to the storage namespace', async () => {
    let captured = 0;
    const fetchSpy: typeof fetch = async () => {
      captured += 1;
      return new Response('{"provider":"local_fs"}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const client = new AtomicMemoryClient({
      apiUrl: 'http://core.test',
      apiKey: 'k-1',
      userId: 'u-1',
      fetch: fetchSpy,
    });
    await client.storage.capabilities();
    expect(captured).toBe(1);
  });
});
