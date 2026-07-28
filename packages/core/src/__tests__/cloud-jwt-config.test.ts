/**
 * Cloud JWT env parsing — all-or-nothing validation.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const trackedEnvNames = [
  'CLOUD_JWKS_URL',
  'CLOUD_JWT_ISSUER',
  'CLOUD_JWT_AUDIENCE',
  'CLOUD_PROJECT_ID',
  'CLOUD_JWT_STATIC_KEY_FALLBACK',
  'RAW_STORAGE_DEPLOYMENT_ENV',
  'DATABASE_URL',
  'CORE_API_KEY',
  'STORAGE_KEY_HMAC_SECRET',
  'EMBEDDING_DIMENSIONS',
  'EMBEDDING_PROVIDER',
  'OPENAI_API_KEY',
] as const;

const originalEnv = Object.fromEntries(
  trackedEnvNames.map((name) => [name, process.env[name]]),
) as Record<(typeof trackedEnvNames)[number], string | undefined>;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  process.env.DATABASE_URL =
    'postgresql://atomicmemory:atomicmemory@localhost:5433/atomicmemory_test';
  process.env.CORE_API_KEY = 'test-core-api-key';
  process.env.STORAGE_KEY_HMAC_SECRET =
    '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
  process.env.EMBEDDING_DIMENSIONS = '384';
  process.env.EMBEDDING_PROVIDER = 'openai';
  process.env.OPENAI_API_KEY = 'test-openai-key';
  process.env.RAW_STORAGE_DEPLOYMENT_ENV = 'local';
  delete process.env.CLOUD_JWKS_URL;
  delete process.env.CLOUD_JWT_ISSUER;
  delete process.env.CLOUD_JWT_AUDIENCE;
  delete process.env.CLOUD_PROJECT_ID;
  delete process.env.CLOUD_JWT_STATIC_KEY_FALLBACK;
});

afterEach(() => {
  for (const name of trackedEnvNames) restoreEnv(name, originalEnv[name]);
  vi.resetModules();
});

async function loadConfig() {
  vi.resetModules();
  return (await import('../config.js')).config;
}

describe('parseCloudJwtConfig via config module', () => {
  it('returns null when all CLOUD JWT vars are unset', async () => {
    expect((await loadConfig()).cloudJwt).toBeNull();
  });

  it('loads profile when all required Cloud JWT vars are set', async () => {
    process.env.CLOUD_JWKS_URL = 'https://api.test/.well-known/atomic-core/jwks.json';
    process.env.CLOUD_JWT_ISSUER = 'https://api.test';
    process.env.CLOUD_JWT_AUDIENCE = 'atomicmemory-core';
    process.env.CLOUD_PROJECT_ID = 'proj_test';
    const cfg = await loadConfig();
    expect(cfg.cloudJwt).toEqual({
      jwksUrl: 'https://api.test/.well-known/atomic-core/jwks.json',
      issuer: 'https://api.test',
      audience: 'atomicmemory-core',
      projectId: 'proj_test',
      staticKeyFallbackEnabled: false,
      legacyDefaultMemoryUserId: null,
    });
  });

  it('leaves projectId null when CLOUD_PROJECT_ID is unset (single-key local)', async () => {
    process.env.CLOUD_JWKS_URL = 'https://api.test/.well-known/atomic-core/jwks.json';
    process.env.CLOUD_JWT_ISSUER = 'https://api.test';
    process.env.CLOUD_JWT_AUDIENCE = 'atomicmemory-core';
    const cfg = await loadConfig();
    expect(cfg.cloudJwt).toEqual({
      jwksUrl: 'https://api.test/.well-known/atomic-core/jwks.json',
      issuer: 'https://api.test',
      audience: 'atomicmemory-core',
      projectId: null,
      staticKeyFallbackEnabled: false,
      legacyDefaultMemoryUserId: null,
    });
  });

  it('parses explicit static-key fallback boolean', async () => {
    process.env.CLOUD_JWKS_URL = 'https://api.test/.well-known/atomic-core/jwks.json';
    process.env.CLOUD_JWT_ISSUER = 'https://api.test';
    process.env.CLOUD_JWT_AUDIENCE = 'atomicmemory-core';
    process.env.CLOUD_PROJECT_ID = 'proj_test';
    process.env.CLOUD_JWT_STATIC_KEY_FALLBACK = 'true';
    const cfg = await loadConfig();
    expect(cfg.cloudJwt?.staticKeyFallbackEnabled).toBe(true);
  });

  it('fails startup when only some Cloud JWT vars are set', async () => {
    process.env.CLOUD_JWKS_URL = 'https://api.test/jwks.json';
    vi.resetModules();
    await expect(import('../config.js')).rejects.toThrow(/must all be set together/);
  });
});
