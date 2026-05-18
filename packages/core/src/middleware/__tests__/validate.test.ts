/**
 * @file Unit tests for the Zod-based Express validators.
 *
 * Pins the runtime contract preserved from the pre-Zod inline
 * validators in `src/routes/memories.ts:515-628`:
 *   - Failure → 400 with `{ error: string }` envelope.
 *   - Success → req.body/query/params replaced with parsed+transformed
 *     data.
 *   - ZodError issues flattened into a single readable string.
 */

import { describe, it, expect, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import {
  validateBody,
  validateQuery,
  validateParams,
  formatZodIssues,
  assertResponse,
} from '../validate';

function mockRes(): Response {
  const res: Partial<Response> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as Response;
}

describe('formatZodIssues', () => {
  it('joins multiple issues with semicolons and path prefixes', () => {
    const schema = z.object({ user_id: z.string(), n: z.number() });
    const result = schema.safeParse({ user_id: 123, n: 'x' });
    expect(result.success).toBe(false);
    if (result.success) return;
    const msg = formatZodIssues(result.error.issues);
    expect(msg).toMatch(/user_id:/);
    expect(msg).toMatch(/n:/);
    expect(msg).toContain('; ');
  });

  it('omits path prefix when the issue is at the root', () => {
    const schema = z.string();
    const result = schema.safeParse(42);
    if (result.success) return;
    const msg = formatZodIssues(result.error.issues);
    expect(msg).not.toMatch(/^:/);
  });
});

describe('validateBody', () => {
  const Schema = z.object({
    user_id: z.string().min(1),
  });

  it('replaces req.body with parsed data on success', () => {
    const handler = validateBody(Schema);
    const req = { body: { user_id: 'u1' } } as unknown as Request;
    const next = vi.fn() as unknown as NextFunction;
    handler(req, mockRes(), next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.body).toEqual({ user_id: 'u1' });
  });

  it('applies schema transform output to req.body', () => {
    const TransformSchema = z.object({ user_id: z.string() }).transform(b => ({
      userId: b.user_id,
    }));
    const handler = validateBody(TransformSchema);
    const req = { body: { user_id: 'u1' } } as unknown as Request;
    handler(req, mockRes(), vi.fn());
    expect(req.body).toEqual({ userId: 'u1' });
  });

  it('responds 400 with { error: string } on failure', () => {
    const handler = validateBody(Schema);
    const req = { body: {} } as unknown as Request;
    const res = mockRes();
    const next = vi.fn();
    handler(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    const payload = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(Object.keys(payload)).toEqual(['error']);
    expect(typeof payload.error).toBe('string');
    expect(payload.error.length).toBeGreaterThan(0);
  });
});

describe('validateQuery + validateParams', () => {
  it('validateQuery rewrites req.query on success', () => {
    const handler = validateQuery(z.object({ limit: z.coerce.number() }));
    const req = { query: { limit: '42' } } as unknown as Request;
    handler(req, mockRes(), vi.fn());
    expect(req.query).toEqual({ limit: 42 });
  });

  it('validateParams responds 400 on bad path params', () => {
    const handler = validateParams(z.object({ id: z.string().uuid() }));
    const req = { params: { id: 'not-a-uuid' } } as unknown as Request;
    const res = mockRes();
    handler(req, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe('assertResponse', () => {
  it('throws in non-production when payload fails schema', () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    try {
      expect(() =>
        assertResponse(z.object({ ok: z.literal(true) }), { ok: false }),
      ).toThrow(/assertResponse/);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  it('is a no-op in production', () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() =>
        assertResponse(z.object({ ok: z.literal(true) }), { ok: false }),
      ).not.toThrow();
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});
