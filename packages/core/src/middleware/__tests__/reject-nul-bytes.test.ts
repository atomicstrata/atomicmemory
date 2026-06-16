/**
 * @file Unit tests for the NUL-byte boundary guards. NUL is built via
 * fromCharCode so this source file carries no raw NUL byte.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { rejectNulInRequestTarget, rejectNulInBody } from '../reject-nul-bytes.js';

const NUL = String.fromCharCode(0);

function buildRes(): { res: Response; status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn>; code: number } {
  const out = { code: 0 } as { code: number; res: Response; status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
  const json = vi.fn(() => out.res);
  const status = vi.fn((c: number) => {
    out.code = c;
    return out.res;
  });
  out.res = { status, json } as unknown as Response;
  out.status = status;
  out.json = json;
  return out;
}

function reqTarget(originalUrl: string, query: unknown): Request {
  return { originalUrl, query } as unknown as Request;
}

describe('rejectNulInRequestTarget', () => {
  it('400s a NUL byte in a query value', () => {
    const { res, status } = buildRes();
    const next = vi.fn();
    rejectNulInRequestTarget(reqTarget('/v1/memories/stats', { user_id: `qa${NUL}x` }), res, next);
    expect(status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });

  it('400s a percent-encoded NUL (%00) in the path/request target', () => {
    const { res, status } = buildRes();
    const next = vi.fn();
    rejectNulInRequestTarget(reqTarget('/v1/entities/user/qa%00x/profile', {}), res, next);
    expect(status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });

  it('400s a NUL nested in an array/object query value', () => {
    const { res, status } = buildRes();
    const next = vi.fn();
    rejectNulInRequestTarget(reqTarget('/x', { entity_ids: ['ok', `bad${NUL}`] }), res, next);
    expect(status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });

  it('400s a NUL in a query object KEY (object keys reach JSONB columns)', () => {
    const { res, status } = buildRes();
    const next = vi.fn();
    rejectNulInRequestTarget(reqTarget('/x', { [`k${NUL}`]: 'v' }), res, next);
    expect(status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next() for a clean request', () => {
    const { res, status } = buildRes();
    const next = vi.fn();
    rejectNulInRequestTarget(reqTarget('/v1/memories/stats', { user_id: 'qa-user-1' }), res, next);
    expect(status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });
});

describe('rejectNulInBody', () => {
  const req = (body: unknown) => ({ body } as unknown as Request);

  it('400s a NUL byte in a nested body string', () => {
    const { res, status } = buildRes();
    const next = vi.fn();
    rejectNulInBody(req({ user_id: 'u', nested: { source_site: `s${NUL}` } }), res, next);
    expect(status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });

  it('400s a NUL in a body object KEY (config_override / metadata key sink)', () => {
    const { res, status } = buildRes();
    const next = vi.fn();
    rejectNulInBody(req({ config_override: { [`bad${NUL}`]: 'v' } }), res, next);
    expect(status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });

  it('400s a too-deeply-nested body instead of recursing unboundedly', () => {
    const { res, status } = buildRes();
    const next = vi.fn();
    let nested: unknown = 'leaf';
    for (let i = 0; i < 400; i += 1) nested = { next: nested };
    rejectNulInBody(req(nested), res, next);
    expect(status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next() for a clean JSON body', () => {
    const { res, status } = buildRes();
    const next = vi.fn();
    rejectNulInBody(req({ user_id: 'u', conversation: 'hello' }), res, next);
    expect(status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });

  it('skips a raw Buffer body (binary uploads are legitimate) and calls next()', () => {
    const { res, status } = buildRes();
    const next = vi.fn();
    // A Buffer that contains a 0x00 byte must NOT be rejected.
    rejectNulInBody(req(Buffer.from([0x01, 0x00, 0x02])), res, next);
    expect(status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });

  it('calls next() when there is no parsed body', () => {
    const { res, status } = buildRes();
    const next = vi.fn();
    rejectNulInBody(req(undefined), res, next);
    expect(status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });
});
