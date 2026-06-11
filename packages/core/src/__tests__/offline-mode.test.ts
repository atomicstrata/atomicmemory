/**
 * Tests for the offline Personal profile guard (Radar C5).
 *
 * Two test groups:
 *   1. Pure unit tests against `validateOfflineMode` (no env, no module reload).
 *   2. Config-module integration: verify the guard fires at config load time
 *      when OFFLINE_MODE=true + a cloud embedding provider is configured via env.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateOfflineMode } from '../config.js';

describe('validateOfflineMode', () => {
  it('accepts a local embedding + local LLM provider when offline_mode is true', () => {
    expect(() => validateOfflineMode(true, 'transformers', 'claude-code')).not.toThrow();
    expect(() => validateOfflineMode(true, 'ollama', 'codex')).not.toThrow();
    expect(() => validateOfflineMode(true, 'transformers', 'ollama')).not.toThrow();
  });

  it('rejects a cloud embedding provider when offline_mode is true', () => {
    expect(() => validateOfflineMode(true, 'openai', 'claude-code')).toThrow(
      /OFFLINE_MODE=true requires a local-only EMBEDDING_PROVIDER/,
    );
    expect(() => validateOfflineMode(true, 'voyage', 'claude-code')).toThrow(
      /OFFLINE_MODE=true requires a local-only EMBEDDING_PROVIDER/,
    );
    expect(() => validateOfflineMode(true, 'openai-compatible', 'claude-code')).toThrow(
      /OFFLINE_MODE=true requires a local-only EMBEDDING_PROVIDER/,
    );
  });

  it('rejects a cloud LLM provider even when the embedding provider is local', () => {
    for (const cloudLlm of ['openai', 'anthropic', 'groq', 'google-genai', 'openai-compatible'] as const) {
      expect(() => validateOfflineMode(true, 'transformers', cloudLlm)).toThrow(
        /OFFLINE_MODE=true requires a local-only LLM_PROVIDER/,
      );
    }
  });

  it('imposes no constraint when offline_mode is false', () => {
    expect(() => validateOfflineMode(false, 'openai', 'openai')).not.toThrow();
    expect(() => validateOfflineMode(false, 'voyage', 'anthropic')).not.toThrow();
    expect(() => validateOfflineMode(false, 'openai-compatible', 'groq')).not.toThrow();
    expect(() => validateOfflineMode(false, 'transformers', 'claude-code')).not.toThrow();
    expect(() => validateOfflineMode(false, 'ollama', 'ollama')).not.toThrow();
  });
});

// --- Config module integration: guard fires at module load time ---

const trackedEnvNames = [
  'OFFLINE_MODE',
  'EMBEDDING_PROVIDER',
  'EMBEDDING_DIMENSIONS',
  'LLM_PROVIDER',
  'DATABASE_URL',
  'CORE_API_KEY',
  'STORAGE_KEY_HMAC_SECRET',
  'RAW_STORAGE_DEPLOYMENT_ENV',
  'OPENAI_API_KEY',
] as const;

const originalEnv = Object.fromEntries(
  trackedEnvNames.map((name) => [name, process.env[name]]),
) as Record<typeof trackedEnvNames[number], string | undefined>;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

beforeEach(() => {
  process.env.DATABASE_URL = 'postgresql://atomicmemory:atomicmemory@localhost:5433/atomicmemory_test';
  process.env.CORE_API_KEY = 'test-core-api-key';
  process.env.STORAGE_KEY_HMAC_SECRET =
    '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
  process.env.RAW_STORAGE_DEPLOYMENT_ENV = 'local';
  process.env.OPENAI_API_KEY = 'test-openai-key';
  process.env.EMBEDDING_DIMENSIONS = '384';
});

afterEach(() => {
  for (const name of trackedEnvNames) restoreEnv(name, originalEnv[name]);
  vi.resetModules();
});

describe('config module — OFFLINE_MODE env integration', () => {
  it('rejects OFFLINE_MODE=true with EMBEDDING_PROVIDER=openai at config load', async () => {
    process.env.OFFLINE_MODE = 'true';
    process.env.EMBEDDING_PROVIDER = 'openai';
    vi.resetModules();

    await expect(import('../config.js')).rejects.toThrow(
      /OFFLINE_MODE=true requires a local-only EMBEDDING_PROVIDER/,
    );
  });

  it('rejects OFFLINE_MODE=true with a cloud LLM_PROVIDER at config load', async () => {
    process.env.OFFLINE_MODE = 'true';
    process.env.EMBEDDING_PROVIDER = 'transformers';
    process.env.LLM_PROVIDER = 'anthropic';
    vi.resetModules();

    await expect(import('../config.js')).rejects.toThrow(
      /OFFLINE_MODE=true requires a local-only LLM_PROVIDER/,
    );
  });

  it('accepts OFFLINE_MODE=true with EMBEDDING_PROVIDER=transformers at config load', async () => {
    process.env.OFFLINE_MODE = 'true';
    process.env.EMBEDDING_PROVIDER = 'transformers';
    // Use a local LLM provider so no OPENAI_API_KEY is required
    process.env.LLM_PROVIDER = 'claude-code';
    delete process.env.OPENAI_API_KEY;
    vi.resetModules();

    const { config } = await import('../config.js');

    expect(config.offlineMode).toBe(true);
    expect(config.embeddingProvider).toBe('transformers');
  });

  it('imposes no constraint when OFFLINE_MODE is unset', async () => {
    delete process.env.OFFLINE_MODE;
    process.env.EMBEDDING_PROVIDER = 'openai';
    vi.resetModules();

    const { config } = await import('../config.js');

    expect(config.offlineMode).toBe(false);
    expect(config.embeddingProvider).toBe('openai');
  });
});
