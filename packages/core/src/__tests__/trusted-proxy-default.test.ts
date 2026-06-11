/**
 * Tests for the safe-by-default `trustedProxyMode` resolution (radar audit #14).
 *
 * The C4 cross-user-assertion guard is only active when `trustedProxyMode` is
 * true. In a hosted/multi-tenant deployment (RAW_STORAGE_DEPLOYMENT_ENV =
 * production | staging) the guard must default ON, and explicitly disabling it
 * must fail startup. Local deployments keep the historical `false` default and
 * honor an explicit value.
 *
 * These reload the config module under controlled env combinations, mirroring
 * the offline-mode config-load integration tests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const trackedEnvNames = [
  'TRUSTED_PROXY_MODE',
  'RAW_STORAGE_DEPLOYMENT_ENV',
  'DATABASE_URL',
  'CORE_API_KEY',
  'STORAGE_KEY_HMAC_SECRET',
  'EMBEDDING_DIMENSIONS',
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
  process.env.DATABASE_URL = 'postgresql://atomicmemory:atomicmemory@localhost:5433/atomicmemory_test';
  process.env.CORE_API_KEY = 'test-core-api-key';
  process.env.STORAGE_KEY_HMAC_SECRET =
    '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
  process.env.EMBEDDING_DIMENSIONS = '384';
  process.env.OPENAI_API_KEY = 'test-openai-key';
  delete process.env.TRUSTED_PROXY_MODE;
});

afterEach(() => {
  for (const name of trackedEnvNames) restoreEnv(name, originalEnv[name]);
  vi.resetModules();
});

async function loadConfig() {
  vi.resetModules();
  return (await import('../config.js')).config;
}

describe('trustedProxyMode safe-by-default', () => {
  it('defaults true in a hosted (production) env when TRUSTED_PROXY_MODE is unset', async () => {
    process.env.RAW_STORAGE_DEPLOYMENT_ENV = 'production';
    expect((await loadConfig()).trustedProxyMode).toBe(true);
  });

  it('defaults true in a hosted (staging) env when TRUSTED_PROXY_MODE is unset', async () => {
    process.env.RAW_STORAGE_DEPLOYMENT_ENV = 'staging';
    expect((await loadConfig()).trustedProxyMode).toBe(true);
  });

  it('fails startup when explicitly disabled in a hosted env', async () => {
    process.env.RAW_STORAGE_DEPLOYMENT_ENV = 'production';
    process.env.TRUSTED_PROXY_MODE = 'false';
    vi.resetModules();
    await expect(import('../config.js')).rejects.toThrow(/TRUSTED_PROXY_MODE=false is not allowed/);
  });

  it('honors an explicit true in a hosted env', async () => {
    process.env.RAW_STORAGE_DEPLOYMENT_ENV = 'staging';
    process.env.TRUSTED_PROXY_MODE = 'true';
    expect((await loadConfig()).trustedProxyMode).toBe(true);
  });

  it('defaults false in a local env when TRUSTED_PROXY_MODE is unset', async () => {
    process.env.RAW_STORAGE_DEPLOYMENT_ENV = 'local';
    expect((await loadConfig()).trustedProxyMode).toBe(false);
  });

  it('honors an explicit false in a local env', async () => {
    process.env.RAW_STORAGE_DEPLOYMENT_ENV = 'local';
    process.env.TRUSTED_PROXY_MODE = 'false';
    expect((await loadConfig()).trustedProxyMode).toBe(false);
  });
});
