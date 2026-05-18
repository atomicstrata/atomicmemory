/**
 * @file Shared HTTP mocking helpers for provider unit tests.
 *
 * Provider test files (atomicmemory-provider.test.ts, mem0-provider.test.ts)
 * use these to build mocked fetch responses. Kept isolated to this directory
 * so it does not leak into production bundles.
 */

import { vi } from 'vitest';

/** Build a minimal successful Response with JSON body. */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Build an error Response with optional Retry-After header. */
export function errorResponse(
  status: number,
  body = '',
  retryAfter?: string,
): Response {
  const headers: Record<string, string> = { 'Content-Type': 'text/plain' };
  if (retryAfter) {
    headers['Retry-After'] = retryAfter;
  }
  return new Response(body, { status, headers });
}

/**
 * Install a fresh fetch mock on globalThis for the duration of a test.
 * Use inside a `beforeEach` block:
 *
 *   let mockFetch: ReturnType<typeof vi.fn>;
 *   beforeEach(() => { mockFetch = installFetchMock(); });
 */
export function installFetchMock(): ReturnType<typeof vi.fn> {
  const mockFetch = vi.fn();
  vi.stubGlobal('fetch', mockFetch);
  return mockFetch;
}
