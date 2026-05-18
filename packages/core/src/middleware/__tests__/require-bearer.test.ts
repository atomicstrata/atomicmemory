/**
 * Unit tests for the `requireBearer` middleware. Exercise the four
 * branches: missing header, malformed header, wrong key, correct key.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { requireBearer } from '../require-bearer.js';

const EXPECTED_KEY = 'test-shared-secret-do-not-leak';

function buildRes(): { res: Response; status: (code: number) => Response; json: (body: unknown) => Response; statusCode: number; body: unknown } {
  const stub: {
    res: Response;
    status: (code: number) => Response;
    json: (body: unknown) => Response;
    statusCode: number;
    body: unknown;
  } = { statusCode: 0, body: undefined } as never;
  stub.status = vi.fn((code: number) => {
    stub.statusCode = code;
    return stub.res;
  });
  stub.json = vi.fn((body: unknown) => {
    stub.body = body;
    return stub.res;
  });
  stub.res = { status: stub.status, json: stub.json } as unknown as Response;
  return stub;
}

function runMiddleware(authHeader: string | undefined): { stub: ReturnType<typeof buildRes>; next: ReturnType<typeof vi.fn> } {
  const handler = requireBearer(EXPECTED_KEY);
  const req = { headers: authHeader === undefined ? {} : { authorization: authHeader } } as unknown as Request;
  const stub = buildRes();
  const next = vi.fn();
  handler(req, stub.res, next);
  return { stub, next };
}

describe('requireBearer', () => {
  it('rejects requests with no Authorization header (401 unauthenticated)', () => {
    const { stub, next } = runMiddleware(undefined);
    expect(stub.statusCode).toBe(401);
    expect(stub.body).toEqual({
      error_code: 'unauthenticated',
      error: 'missing or malformed Authorization header',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects an Authorization header without the Bearer prefix', () => {
    const { stub, next } = runMiddleware(EXPECTED_KEY);
    expect(stub.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a Bearer token whose value does not match the expected key', () => {
    const { stub, next } = runMiddleware('Bearer wrong-key-value-here');
    expect(stub.statusCode).toBe(401);
    expect(stub.body).toEqual({ error_code: 'unauthenticated', error: 'invalid api key' });
    expect(next).not.toHaveBeenCalled();
  });

  it('passes through to next() when the Bearer token matches exactly', () => {
    const { stub, next } = runMiddleware(`Bearer ${EXPECTED_KEY}`);
    expect(stub.statusCode).toBe(0);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('rejects an empty Bearer token', () => {
    const { stub, next } = runMiddleware('Bearer ');
    expect(stub.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('throws at construction when the expected key is empty', () => {
    expect(() => requireBearer('')).toThrow(/non-empty/);
  });
});
