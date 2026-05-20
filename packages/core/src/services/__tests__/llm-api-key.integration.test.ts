/**
 * Live integration smokes for API-key-backed LLM providers.
 *
 * These tests run only when real provider keys are present in the test
 * environment. Placeholder keys from .env.test are treated as unavailable.
 */

import { describe, expect, it } from 'vitest';
import { createLLMProvider, initLlm, type LLMConfig, type LLMProvider } from '../llm.js';

interface ApiKeyReadiness {
  runnable: boolean;
  reason: string;
}

const openaiReadiness = resolveApiKeyReadiness('OPENAI_API_KEY');
const anthropicReadiness = resolveApiKeyReadiness('ANTHROPIC_API_KEY');

describe.skipIf(!openaiReadiness.runnable)(`OpenAI LLM live integration (${openaiReadiness.reason})`, () => {
  it('runs through OpenAI API-key auth', async () => {
    const provider = providerFor({
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
      openaiApiKey: process.env.OPENAI_API_KEY ?? '',
    });

    const output = await provider.chat([
      { role: 'system', content: 'Return exactly: atomicmemory-openai-ok' },
      { role: 'user', content: 'Run the AtomicMemory OpenAI live smoke test.' },
    ], { maxTokens: 16 });

    expect(output).toContain('atomicmemory-openai-ok');
  }, 60_000);
});

describe.skipIf(!anthropicReadiness.runnable)(`Anthropic LLM live integration (${anthropicReadiness.reason})`, () => {
  it('runs through Anthropic API-key auth', async () => {
    const provider = providerFor({
      llmProvider: 'anthropic',
      llmModel: 'claude-sonnet-4-20250514',
      anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    });

    const output = await provider.chat([
      { role: 'system', content: 'Return exactly: atomicmemory-anthropic-ok' },
      { role: 'user', content: 'Run the AtomicMemory Anthropic live smoke test.' },
    ], { maxTokens: 16 });

    expect(output).toContain('atomicmemory-anthropic-ok');
  }, 60_000);
});

function providerFor(overrides: Partial<LLMConfig>): LLMProvider {
  initLlm({
    llmProvider: 'openai',
    llmModel: 'gpt-4o-mini',
    codexAuthPath: '/tmp/unused-codex-auth.json',
    openaiApiKey: '',
    ollamaBaseUrl: 'http://127.0.0.1:11434',
    costLoggingEnabled: false,
    costRunId: 'llm-api-key-live-test',
    costLogDir: '/tmp/atomicmemory-llm-api-key-live-test',
    ...overrides,
  });
  return createLLMProvider();
}

function resolveApiKeyReadiness(name: string): ApiKeyReadiness {
  const value = process.env[name];
  if (!value) return { runnable: false, reason: `${name} is not set` };
  if (isPlaceholderSecret(value)) return { runnable: false, reason: `${name} is a placeholder` };
  return { runnable: true, reason: `${name} is set` };
}

function isPlaceholderSecret(value: string): boolean {
  const lowered = value.toLowerCase();
  return lowered.includes('test') || lowered.includes('dummy') || value.includes('...') || value.includes('<');
}
