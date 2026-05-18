/**
 * Direct coverage for the `/v1` mount prefix on `createApp`.
 *
 * `composed-boot-parity.test.ts` and `research-consumption-seams.test.ts`
 * exercise a handful of memory routes under `/v1`, but neither touches
 * the agents router and neither asserts that the unversioned paths are
 * actually unmounted. This file fills those gaps with a minimal check
 * per route family: one representative memory route, one representative
 * agents route, and an explicit negative assertion that the bare
 * (pre-versioning) paths now return 404.
 *
 * The goal is to catch regressions in the mount prefix itself (typo,
 * accidental dual-mount, dropped `/v1` during a refactor) — not to
 * re-test route logic, which is covered by the router-level test files.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { pool } from '../../db/pool.js';
import { setupTestSchema } from '../../db/__tests__/test-fixtures.js';
import { createCoreRuntime } from '../runtime-container.js';
import { createApp } from '../create-app.js';
import { bindEphemeral, type BootedApp } from '../bind-ephemeral.js';
import { authHeader } from '../../__tests__/helpers/auth-headers.js';

const TEST_USER = 'versioned-mount-user';
const TEST_AGENT = 'versioned-mount-agent';

/**
 * Assert the response is HTTP 401 with `error_code: 'unauthenticated'`.
 * Shared by the missing-Authorization and wrong-Bearer assertions so the
 * three-line post-fetch check lives in one place.
 */
async function expectUnauthenticatedJson(res: Response): Promise<void> {
  expect(res.status).toBe(401);
  const body = (await res.json()) as { error_code: string };
  expect(body.error_code).toBe('unauthenticated');
}

describe('createApp /v1 mount coverage', () => {
  let booted: BootedApp;

  beforeAll(async () => {
    await setupTestSchema(pool);
    booted = await bindEphemeral(createApp(await createCoreRuntime({ pool })));
  });

  afterAll(async () => {
    await booted.close();
    await pool.end();
  });

  it('GET /v1/memories/list is reachable — memory router is mounted under /v1', async () => {
    const res = await fetch(
      `${booted.baseUrl}/v1/memories/list?user_id=${TEST_USER}`,
      { headers: authHeader() },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.memories)).toBe(true);
  });

  it('PUT + GET /v1/agents/trust round-trips — agents router is mounted under /v1', async () => {
    const putRes = await fetch(`${booted.baseUrl}/v1/agents/trust`, {
      method: 'PUT',
      headers: { ...authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: TEST_AGENT, user_id: TEST_USER, trust_level: 0.75 }),
    });
    expect(putRes.status).toBe(200);
    const putBody = await putRes.json();
    expect(putBody).toEqual({ agent_id: TEST_AGENT, trust_level: 0.75 });

    const getRes = await fetch(
      `${booted.baseUrl}/v1/agents/trust?agent_id=${TEST_AGENT}&user_id=${TEST_USER}`,
      { headers: authHeader() },
    );
    expect(getRes.status).toBe(200);
    const getBody = await getRes.json();
    expect(getBody).toEqual({ agent_id: TEST_AGENT, trust_level: 0.75 });
  });

  it('bare /memories/* and /agents/* return 404 — unversioned paths are NOT mounted', async () => {
    // No auth header — these paths fall outside the auth scope.
    const memRes = await fetch(`${booted.baseUrl}/memories/list?user_id=${TEST_USER}`);
    expect(memRes.status).toBe(404);

    const agentRes = await fetch(
      `${booted.baseUrl}/agents/trust?agent_id=${TEST_AGENT}&user_id=${TEST_USER}`,
    );
    expect(agentRes.status).toBe(404);
  });

  it('GET /v1/documents/limits is reachable and reports the runtime config snapshot', async () => {
    const res = await fetch(`${booted.baseUrl}/v1/documents/limits`, { headers: authHeader() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      raw_upload_max_bytes: number;
      index_max_text_bytes: number;
      raw_storage: { enabled: boolean; mode: string };
    };
    expect(body.raw_upload_max_bytes).toBeGreaterThan(0);
    expect(body.index_max_text_bytes).toBe(25 * 1024 * 1024);
    expect(['pointer_only', 'managed_blob']).toContain(body.raw_storage.mode);
    expect(typeof body.raw_storage.enabled).toBe('boolean');
  });

  it('non-document routers enforce a 1 MiB JSON body cap (route-scoped, not global)', async () => {
    const ONE_MIB_PLUS = 1024 * 1024 + 64;
    const oversizeText = 'y'.repeat(ONE_MIB_PLUS);
    const res = await fetch(`${booted.baseUrl}/v1/memories/ingest`, {
      method: 'POST',
      headers: { ...authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: TEST_USER, text: oversizeText }),
    });
    expect([400, 413]).toContain(res.status);
  }, 30_000);

  it('GET /v1/memories/list without Authorization returns 401 unauthenticated', async () => {
    // Truly omit Authorization — the route's `requireBearer` middleware
    // must reject. No interceptor injects auth here.
    const res = await fetch(`${booted.baseUrl}/v1/memories/list?user_id=${TEST_USER}`);
    await expectUnauthenticatedJson(res);
  });

  it('GET /v1/memories/list with wrong Bearer returns 401 unauthenticated', async () => {
    const res = await fetch(`${booted.baseUrl}/v1/memories/list?user_id=${TEST_USER}`, {
      headers: { Authorization: 'Bearer wrong-key-on-purpose' },
    });
    await expectUnauthenticatedJson(res);
  });

  it('PUT /v1/documents/:id/raw without Authorization returns 401 before route validation', async () => {
    await expectUnauthenticatedRawUpload(booted.baseUrl, {});
  });

  it('PUT /v1/documents/:id/raw with wrong Bearer returns 401 before route validation', async () => {
    await expectUnauthenticatedRawUpload(booted.baseUrl, {
      Authorization: 'Bearer wrong-key-on-purpose',
    });
  });

  it('OPTIONS preflight to an authenticated /v1 route succeeds with 204 + Allow-Headers', async () => {
    // Browser preflights never carry `Authorization` — the global
    // CORS middleware must short-circuit before `requireBearer` runs
    // or every SDK request would fail in a browser.
    const res = await fetch(`${booted.baseUrl}/v1/memories/list`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://atomicmem-webapp.example',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers':
          'Authorization, X-AtomicMemory-User-Id',
      },
    });
    expect(res.status).toBe(204);
    const allowHeaders = res.headers.get('access-control-allow-headers') ?? '';
    expect(allowHeaders).toContain('Authorization');
    expect(allowHeaders).toContain('X-AtomicMemory-User-Id');
    expect(allowHeaders).toContain('X-AtomicMemory-Metadata');
    expect(allowHeaders).toContain('X-AtomicMemory-Content-Encoding');
    expect(allowHeaders).toContain('Content-Type');
  });

  it('OPTIONS preflight to /v1/storage/artifacts also succeeds without Authorization', async () => {
    const res = await fetch(`${booted.baseUrl}/v1/storage/artifacts`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://atomicmem-webapp.example',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers':
          'Authorization, X-AtomicMemory-User-Id, Content-Type, X-AtomicMemory-Metadata',
      },
    });
    expect(res.status).toBe(204);
  });
});

async function expectUnauthenticatedRawUpload(
  baseUrl: string,
  extraHeaders: Record<string, string>,
): Promise<void> {
  const res = await fetch(`${baseUrl}/v1/documents/not-a-uuid/raw?user_id=${TEST_USER}`, {
    method: 'PUT',
    headers: { ...extraHeaders, 'Content-Type': 'application/octet-stream' },
    body: Buffer.from('raw bytes') as unknown as BodyInit,
  });
  expect(res.status).toBe(401);
  const body = (await res.json()) as { error_code: string };
  expect(body.error_code).toBe('unauthenticated');
}
