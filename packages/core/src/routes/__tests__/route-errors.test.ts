/**
 * Unit tests for shared route error envelopes.
 *
 * Exercises upstream-provider classification directly at the Express
 * response boundary. The provider clients are intentionally not mocked
 * here; route-errors.ts only sees the thrown error shape and must
 * sanitize it before sending JSON.
 */

import type { Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleRouteError } from '../route-errors.js';

interface CapturedResponse {
  statusCode: number | null;
  body: unknown;
}

function response(): Response & CapturedResponse {
  const captured: CapturedResponse = { statusCode: null, body: null };
  return {
    ...captured,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  } as Response & CapturedResponse;
}

function providerError(message: string, status: number): Error & { status: number; headers: Record<string, string> } {
  const err = new Error(message) as Error & { status: number; headers: Record<string, string> };
  err.status = status;
  err.headers = {};
  return err;
}

describe('handleRouteError', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns a quota-specific provider envelope for upstream 429 quota failures', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = response();
    const err = providerError('429 You exceeded your current quota. sk-plantedsecret123456', 429);

    handleRouteError(res, 'POST /v1/memories/ingest', err);

    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({
      error_code: 'upstream_provider_quota_exceeded',
      provider_status: 429,
      retryable: false,
    });
    expect(JSON.stringify(res.body)).not.toContain('sk-plantedsecret');
  });

  it('returns a retryable provider envelope for generic upstream rate limits', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = response();

    handleRouteError(res, 'POST /v1/memories/search', providerError('OpenAI rate limit reached', 429));

    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({
      error_code: 'upstream_provider_rate_limited',
      provider_status: 429,
      retryable: true,
    });
  });

  it('keeps unrelated service failures on the generic 500 envelope', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = response();
    const err = Object.assign(new Error('local repository conflict'), { status: 409 });

    handleRouteError(res, 'POST /v1/memories/ingest', err);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });
});
