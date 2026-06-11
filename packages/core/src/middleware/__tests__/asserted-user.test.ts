/**
 * Unit tests for the Radar C4 trusted-proxy identity guard
 * (`assertedUserGuard`).
 *
 * Pins the defense-in-depth contract:
 *   - trusted_proxy_mode OFF (default): no-op; requests proceed regardless
 *     of the asserted-user header (backward compatible).
 *   - trusted_proxy_mode ON: a request carrying a `user_id` (body or query)
 *     or `X-AtomicMemory-User-Id` header must carry a matching
 *     `X-AtomicMemory-Asserted-User` header; mismatch or missing → 403
 *     asserted_user_mismatch. A request with no user identity proceeds.
 *
 * The guard is exercised behind a real `express.json()` parser + a sentinel
 * downstream handler, so the test asserts the actual request path rather
 * than mocking the middleware internals.
 */

import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type BootedApp, bindEphemeral } from '../../app/bind-ephemeral.js';
import { ASSERTED_USER_HEADER, assertedUserGuard } from '../asserted-user.js';

const STORAGE_USER_HEADER = 'X-AtomicMemory-User-Id';
const reached = vi.fn();

function bootGuard(trustedProxyMode: boolean): Promise<BootedApp> {
  const app = express();
  app.use(express.json());
  app.use(assertedUserGuard(trustedProxyMode));
  app.post('/echo', (req, res) => {
    reached();
    res.json({ ok: true, userId: (req.body as { user_id?: string }).user_id });
  });
  app.get('/echo', (req, res) => {
    reached();
    res.json({ ok: true });
  });
  return bindEphemeral(app);
}

function postJson(
  booted: BootedApp,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${booted.baseUrl}/echo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('assertedUserGuard — trusted_proxy_mode OFF (default)', () => {
  let booted: BootedApp;
  beforeEach(async () => {
    reached.mockClear();
    booted = await bootGuard(false);
  });
  afterEach(async () => {
    await booted.close();
  });

  it('proceeds with a user_id and no asserted-user header (unchanged)', async () => {
    const res = await postJson(booted, { user_id: 'alice' });
    expect(res.status).toBe(200);
    expect(reached).toHaveBeenCalledTimes(1);
  });

  it('proceeds even when an asserted-user header mismatches (guard off)', async () => {
    const res = await postJson(booted, { user_id: 'alice' }, { [ASSERTED_USER_HEADER]: 'bob' });
    expect(res.status).toBe(200);
    expect(reached).toHaveBeenCalledTimes(1);
  });
});

describe('assertedUserGuard — trusted_proxy_mode ON', () => {
  let booted: BootedApp;
  beforeEach(async () => {
    reached.mockClear();
    booted = await bootGuard(true);
  });
  afterEach(async () => {
    await booted.close();
  });

  it('matching asserted-user header → proceeds', async () => {
    const res = await postJson(booted, { user_id: 'alice' }, { [ASSERTED_USER_HEADER]: 'alice' });
    expect(res.status).toBe(200);
    expect(reached).toHaveBeenCalledTimes(1);
  });

  it('mismatched asserted-user header → 403 asserted_user_mismatch', async () => {
    const res = await postJson(booted, { user_id: 'alice' }, { [ASSERTED_USER_HEADER]: 'bob' });
    expect(res.status).toBe(403);
    expect((await res.json()).error_code).toBe('asserted_user_mismatch');
    expect(reached).not.toHaveBeenCalled();
  });

  it('missing asserted-user header → 403 asserted_user_mismatch', async () => {
    const res = await postJson(booted, { user_id: 'alice' });
    expect(res.status).toBe(403);
    expect((await res.json()).error_code).toBe('asserted_user_mismatch');
    expect(reached).not.toHaveBeenCalled();
  });

  it('no user_id at all → proceeds (nothing to cross-check)', async () => {
    const res = await postJson(booted, { conversation: 'hi' });
    expect(res.status).toBe(200);
    expect(reached).toHaveBeenCalledTimes(1);
  });

  it('query-string user_id is cross-checked → mismatch 403', async () => {
    const res = await fetch(`${booted.baseUrl}/echo?user_id=alice`, {
      headers: { [ASSERTED_USER_HEADER]: 'bob' },
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error_code).toBe('asserted_user_mismatch');
    expect(reached).not.toHaveBeenCalled();
  });

  it('X-AtomicMemory-User-Id header is cross-checked → match proceeds', async () => {
    const res = await fetch(`${booted.baseUrl}/echo`, {
      headers: { [STORAGE_USER_HEADER]: 'alice', [ASSERTED_USER_HEADER]: 'alice' },
    });
    expect(res.status).toBe(200);
    expect(reached).toHaveBeenCalledTimes(1);
  });

  it('X-AtomicMemory-User-Id header mismatch → 403', async () => {
    const res = await fetch(`${booted.baseUrl}/echo`, {
      headers: { [STORAGE_USER_HEADER]: 'alice', [ASSERTED_USER_HEADER]: 'bob' },
    });
    expect(res.status).toBe(403);
    expect(reached).not.toHaveBeenCalled();
  });
});
