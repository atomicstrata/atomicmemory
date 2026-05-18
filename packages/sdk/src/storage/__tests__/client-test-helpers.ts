/**
 * @file Shared mocked-fetch test helpers for the `StorageClient`.
 *
 * The client test surface is split across multiple `*.test.ts`
 * files (request-shape, response-mapping, error-mapping) so each
 * stays under the workspace 400-non-comment-LOC cap. Each file
 * imports the same `mockFetch` / `makeClient` / `coreResponseBody`
 * primitives from this module so the helper layer is shared and
 * doesn't drift between suites.
 *
 * This file is intentionally NOT a `*.test.ts` so vitest's default
 * collector doesn't pick it up as an empty test file.
 */

import { ConcreteStorageClient } from '../client.js';

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: BodyInit | undefined;
}

export function mockFetch(
  handler: (req: CapturedRequest) => { status?: number; body?: unknown; headers?: Record<string, string> },
): { impl: typeof fetch; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  const impl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    const headers = normalizeHeaders((init?.headers ?? {}) as Record<string, string>);
    const captured: CapturedRequest = {
      url,
      method: init?.method ?? 'GET',
      headers,
      body: init?.body ?? undefined,
    };
    calls.push(captured);
    const out = handler(captured);
    const responseInit: ResponseInit = {
      status: out.status ?? 200,
      headers: { 'content-type': 'application/json', ...(out.headers ?? {}) },
    };
    const body = out.body === undefined ? '' : typeof out.body === 'string' ? out.body : JSON.stringify(out.body);
    return new Response(body, responseInit);
  };
  return { impl, calls };
}

function normalizeHeaders(raw: Record<string, string> | Headers): Record<string, string> {
  if (raw instanceof Headers) {
    const out: Record<string, string> = {};
    raw.forEach((v, k) => { out[k.toLowerCase()] = v; });
    return out;
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) out[k.toLowerCase()] = v;
  return out;
}

/**
 * Build a realistic snake_case core response body. Tests that
 * exercise request shape / routing / typed errors only care about
 * the wire fields a few of them inspect; everything else is filled
 * with safe defaults so `mapStoredArtifact`'s required-field
 * validation passes. Tests that exercise mapper validation
 * directly override these fields explicitly.
 */
export function coreResponseBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    artifact_id: '11111111-2222-4333-8444-555555555555',
    provider: 'local_fs',
    mode: 'pointer',
    uri: 'https://e/a',
    status: 'stored',
    size_bytes: null,
    content_type: 'text/plain',
    content_encoding: 'identity',
    identifiers: {},
    lifecycle: { availability: 'immediate' },
    metadata: {},
    created_at: '2026-05-12T00:00:00.000Z',
    updated_at: '2026-05-12T00:00:00.000Z',
    ...overrides,
  };
}

export function makeClient(impl: typeof fetch): ConcreteStorageClient {
  return new ConcreteStorageClient({
    apiUrl: 'http://core.test',
    apiKey: 'k-secret',
    userId: 'u-1',
    fetch: impl,
  });
}
