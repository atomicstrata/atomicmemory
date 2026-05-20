/**
 * Regression tests for env-backed runtime configuration.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const trackedEnvNames = [
  'SIMILARITY_THRESHOLD',
  'LLM_PROVIDER',
  'LLM_MODEL',
  'EMBEDDING_PROVIDER',
  'EMBEDDING_DIMENSIONS',
  'DATABASE_URL',
  'CORE_API_KEY',
  'CORE_ADMIN_API_KEY',
  'CORE_TEST_SCOPE_ALLOW_PATTERN',
  'STORAGE_KEY_HMAC_SECRET',
  'RAW_STORAGE_DEPLOYMENT_ENV',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'CODEX_AUTH_PATH',
  'CODEX_HOME',
] as const;
const originalEnv = Object.fromEntries(
  trackedEnvNames.map((name) => [name, process.env[name]]),
) as Record<typeof trackedEnvNames[number], string | undefined>;

beforeEach(() => {
  process.env.DATABASE_URL = 'postgresql://atomicmemory:atomicmemory@localhost:5433/atomicmemory_test';
  process.env.CORE_API_KEY = 'test-core-api-key';
  process.env.STORAGE_KEY_HMAC_SECRET =
    '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
  process.env.EMBEDDING_DIMENSIONS = '1024';
  process.env.RAW_STORAGE_DEPLOYMENT_ENV = 'local';
  process.env.OPENAI_API_KEY = 'test-openai-key';
});

afterEach(() => {
  for (const name of trackedEnvNames) restoreEnv(name, originalEnv[name]);
  vi.resetModules();
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

describe('config env loading', () => {
  it('loads SIMILARITY_THRESHOLD from the environment', async () => {
    process.env.SIMILARITY_THRESHOLD = '0.42';
    vi.resetModules();

    const { config } = await import('../config.js');

    expect(config.similarityThreshold).toBe(0.42);
  });

  it('rejects SIMILARITY_THRESHOLD outside the normalized range', async () => {
    process.env.SIMILARITY_THRESHOLD = '1.5';
    vi.resetModules();

    await expect(import('../config.js')).rejects.toThrow('SIMILARITY_THRESHOLD must be a finite number between 0 and 1');
  });

  it('accepts claude-code LLM provider without an Anthropic API key', async () => {
    process.env.LLM_PROVIDER = 'claude-code';
    process.env.EMBEDDING_PROVIDER = 'transformers';
    delete process.env.LLM_MODEL;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    vi.resetModules();

    const { config } = await import('../config.js');

    expect(config.llmProvider).toBe('claude-code');
    expect(config.llmModel).toBe('');
  });

  it('keeps an explicit Claude Code model override', async () => {
    process.env.LLM_PROVIDER = 'claude-code';
    process.env.LLM_MODEL = 'sonnet';
    process.env.EMBEDDING_PROVIDER = 'transformers';
    delete process.env.OPENAI_API_KEY;
    vi.resetModules();

    const { config } = await import('../config.js');

    expect(config.llmModel).toBe('sonnet');
  });

  it('accepts codex LLM provider without an OpenAI API key', async () => {
    process.env.LLM_PROVIDER = 'codex';
    process.env.EMBEDDING_PROVIDER = 'transformers';
    delete process.env.LLM_MODEL;
    delete process.env.OPENAI_API_KEY;
    vi.resetModules();

    const { config } = await import('../config.js');

    expect(config.llmProvider).toBe('codex');
    expect(config.llmModel).toBe('gpt-5.4-mini');
    expect(config.codexAuthPath).toContain('.codex/auth.json');
  });

  it('loads optional admin cleanup endpoint config', async () => {
    process.env.CORE_ADMIN_API_KEY = 'test-admin-key';
    process.env.CORE_TEST_SCOPE_ALLOW_PATTERN = '^(smoke-|docker-).+';
    vi.resetModules();

    const { config } = await import('../config.js');

    expect(config.coreAdminApiKey).toBe('test-admin-key');
    expect(config.coreTestScopeAllowPattern).toBe('^(smoke-|docker-).+');
  });

  it('rejects invalid admin cleanup scope regex', async () => {
    process.env.CORE_ADMIN_API_KEY = 'test-admin-key';
    process.env.CORE_TEST_SCOPE_ALLOW_PATTERN = '[';
    vi.resetModules();

    await expect(import('../config.js')).rejects.toThrow(
      'CORE_TEST_SCOPE_ALLOW_PATTERN must be a valid JavaScript regular expression',
    );
  });
});
