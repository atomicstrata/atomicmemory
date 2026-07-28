/**
 * Unit tests for dual-auth middleware (static CORE_API_KEY + optional Cloud JWT).
 */

import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { Request, Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CloudJwtConfig } from '../../config.js';
import { ASSERTED_USER_HEADER } from '../asserted-user.js';
import { createAuthMiddleware } from '../dual-auth.js';

const CORE_KEY = 'test-shared-secret-do-not-leak';
const JWKS_URL = 'https://cloud.test/.well-known/atomic-core/jwks.json';
const ISSUER = 'https://api.test';
const AUDIENCE = 'atomicmemory-core';
const PROJECT_ID = 'proj_abc';
const MEMORY_USER_ID = 'tenant-user-1';

function cloudJwtConfig(overrides: Partial<CloudJwtConfig> = {}): CloudJwtConfig {
  return {
    jwksUrl: JWKS_URL,
    issuer: ISSUER,
    audience: AUDIENCE,
    projectId: PROJECT_ID,
    staticKeyFallbackEnabled: false,
    legacyDefaultMemoryUserId: null,
    ...overrides,
  };
}

function buildRes(): {
  res: Response;
  statusCode: number;
  body: unknown;
} {
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

async function signTestJwt(claims: Record<string, unknown>): Promise<string> {
  const { privateKey } = await keyPair();
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'test-kid' })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject('api_key:key_test')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}

let keyPairPromise: ReturnType<typeof generateKeyPair> | undefined;

async function keyPair() {
  keyPairPromise ??= generateKeyPair('RS256');
  return keyPairPromise;
}

async function stubJwksFetch(): Promise<void> {
  const { publicKey } = await keyPair();
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'test-kid';
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === JWKS_URL) {
        return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
}

async function runHandler(
  handler: ReturnType<typeof createAuthMiddleware>['middleware'],
  req: Request,
): Promise<{ stub: ReturnType<typeof buildRes>; next: ReturnType<typeof vi.fn> }> {
  const stub = buildRes();
  const next = vi.fn();
  handler(req, stub.res, next);
  await new Promise((resolve) => setTimeout(resolve, 50));
  return { stub, next };
}

afterEach(() => {
  vi.unstubAllGlobals();
  keyPairPromise = undefined;
});

describe('createAuthMiddleware', () => {
  it('delegates to static bearer when cloudJwt is disabled', () => {
    const { middleware: handler } = createAuthMiddleware({ coreApiKey: CORE_KEY, cloudJwt: null });
    const req = {
      headers: { authorization: `Bearer ${CORE_KEY}` },
    } as unknown as Request;
    const stub = buildRes();
    const next = vi.fn();
    handler(req, stub.res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('accepts a valid Cloud JWT and injects memory-user headers', async () => {
    await stubJwksFetch();
    const { middleware: handler } = createAuthMiddleware({
      coreApiKey: CORE_KEY,
      cloudJwt: cloudJwtConfig(),
    });
    const token = await signTestJwt({
      project_id: PROJECT_ID,
      memory_user_id: MEMORY_USER_ID,
    });
    const req = {
      headers: { authorization: `Bearer ${token}` },
      query: { user_id: MEMORY_USER_ID },
    } as unknown as Request;
    const { stub, next } = await runHandler(handler, req);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.headers[ASSERTED_USER_HEADER.toLowerCase()]).toBe(MEMORY_USER_ID);
    expect(stub.statusCode).toBe(0);
  });

  it('rejects request user_id different from memory_user_id with 403', async () => {
    await stubJwksFetch();
    const { middleware: handler } = createAuthMiddleware({
      coreApiKey: CORE_KEY,
      cloudJwt: cloudJwtConfig(),
    });
    const token = await signTestJwt({
      project_id: PROJECT_ID,
      memory_user_id: MEMORY_USER_ID,
    });
    const req = {
      headers: { authorization: `Bearer ${token}` },
      query: { user_id: 'other-user' },
    } as unknown as Request;
    const { stub, next } = await runHandler(handler, req);
    expect(stub.statusCode).toBe(403);
    expect((stub.body as { error_code: string }).error_code).toBe('forbidden');
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects token project_id different from configured project with 403', async () => {
    await stubJwksFetch();
    const { middleware: handler } = createAuthMiddleware({
      coreApiKey: CORE_KEY,
      cloudJwt: cloudJwtConfig(),
    });
    const token = await signTestJwt({
      project_id: 'proj_other',
      memory_user_id: MEMORY_USER_ID,
    });
    const req = {
      headers: { authorization: `Bearer ${token}` },
      query: { user_id: MEMORY_USER_ID },
    } as unknown as Request;
    const { stub, next } = await runHandler(handler, req);
    expect(stub.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('trusts the token project_id when no project is bound (single-key local)', async () => {
    await stubJwksFetch();
    const { middleware: handler } = createAuthMiddleware({
      coreApiKey: CORE_KEY,
      cloudJwt: cloudJwtConfig({ projectId: null }),
    });
    const token = await signTestJwt({
      project_id: 'proj_inferred_from_token',
      memory_user_id: MEMORY_USER_ID,
    });
    const req = {
      headers: { authorization: `Bearer ${token}` },
      query: { user_id: MEMORY_USER_ID },
    } as unknown as Request;
    const { stub, next } = await runHandler(handler, req);
    expect(next).toHaveBeenCalledTimes(1);
    expect(stub.statusCode).toBe(0);
  });

  it('rejects body user_id different from memory_user_id with 403', async () => {
    await stubJwksFetch();
    const { middleware: handler } = createAuthMiddleware({
      coreApiKey: CORE_KEY,
      cloudJwt: cloudJwtConfig(),
    });
    const token = await signTestJwt({
      project_id: PROJECT_ID,
      memory_user_id: MEMORY_USER_ID,
    });
    const req = {
      headers: { authorization: `Bearer ${token}` },
      body: { user_id: 'other-user' },
    } as unknown as Request;
    const { stub, next } = await runHandler(handler, req);
    expect(stub.statusCode).toBe(403);
    expect((stub.body as { error_code: string }).error_code).toBe('forbidden');
    expect(next).not.toHaveBeenCalled();
  });

  it('accepts legacy Cloud mint without memory_user_id when legacy default is configured', async () => {
    await stubJwksFetch();
    const { middleware: handler } = createAuthMiddleware({
      coreApiKey: CORE_KEY,
      cloudJwt: cloudJwtConfig({ legacyDefaultMemoryUserId: MEMORY_USER_ID }),
    });
    const token = await signTestJwt({ project_id: PROJECT_ID });
    const req = {
      headers: { authorization: `Bearer ${token}` },
      query: { user_id: MEMORY_USER_ID },
    } as unknown as Request;
    const { stub, next } = await runHandler(handler, req);
    expect(next).toHaveBeenCalledTimes(1);
    expect(stub.statusCode).toBe(0);
  });

  it('rejects JWT missing memory_user_id with 401', async () => {
    await stubJwksFetch();
    const { middleware: handler } = createAuthMiddleware({
      coreApiKey: CORE_KEY,
      cloudJwt: cloudJwtConfig(),
    });
    const token = await signTestJwt({ project_id: PROJECT_ID });
    const req = { headers: { authorization: `Bearer ${token}` } } as unknown as Request;
    const { stub, next } = await runHandler(handler, req);
    expect(stub.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects an expired Cloud JWT', async () => {
    await stubJwksFetch();
    const { privateKey } = await keyPair();
    const token = await new SignJWT({
      project_id: PROJECT_ID,
      memory_user_id: MEMORY_USER_ID,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-kid' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject('api_key:key_test')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 300)
      .sign(privateKey);

    const { middleware: handler } = createAuthMiddleware({
      coreApiKey: CORE_KEY,
      cloudJwt: cloudJwtConfig(),
    });
    const req = { headers: { authorization: `Bearer ${token}` } } as unknown as Request;
    const stub = buildRes();
    const next = vi.fn();
    handler(req, stub.res, next);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stub.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects non-JWT bearer when static fallback is disabled', async () => {
    await stubJwksFetch();
    const { middleware: handler } = createAuthMiddleware({
      coreApiKey: CORE_KEY,
      cloudJwt: cloudJwtConfig({ staticKeyFallbackEnabled: false }),
    });
    const req = {
      headers: { authorization: `Bearer ${CORE_KEY}` },
    } as unknown as Request;
    const stub = buildRes();
    const next = vi.fn();
    handler(req, stub.res, next);
    expect(stub.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('falls back to CORE_API_KEY only when static fallback is explicitly enabled', async () => {
    await stubJwksFetch();
    const { middleware: handler } = createAuthMiddleware({
      coreApiKey: CORE_KEY,
      cloudJwt: cloudJwtConfig({ staticKeyFallbackEnabled: true }),
    });
    const req = {
      headers: { authorization: `Bearer ${CORE_KEY}` },
    } as unknown as Request;
    const stub = buildRes();
    const next = vi.fn();
    handler(req, stub.res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(stub.statusCode).toBe(0);
  });

  it('prefetch marks JWKS ready and cached verify survives fetch outage', async () => {
    await stubJwksFetch();
    const bundle = createAuthMiddleware({
      coreApiKey: CORE_KEY,
      cloudJwt: cloudJwtConfig(),
    });
    expect(await bundle.prefetchJwks!()).toBe(true);
    expect(bundle.isJwksReady!()).toBe(true);

    const token = await signTestJwt({
      project_id: PROJECT_ID,
      memory_user_id: MEMORY_USER_ID,
    });
    const warmReq = {
      headers: { authorization: `Bearer ${token}` },
      query: { user_id: MEMORY_USER_ID },
    } as unknown as Request;
    await runHandler(bundle.middleware, warmReq);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('jwks unavailable');
      }),
    );

    const { stub, next } = await runHandler(bundle.middleware, warmReq);
    expect(next).toHaveBeenCalledTimes(1);
    expect(stub.statusCode).toBe(0);
  });
});
