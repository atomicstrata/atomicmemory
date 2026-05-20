/**
 * Unit tests for LLM provider construction and multi-provider support.
 * Tests provider instantiation logic without making real API calls.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createLLMProvider, initLlm, type LLMConfig } from '../llm.js';

// Module-local config (Phase 7 Step 3d). Each test re-inits with a narrow
// config for the provider it wants to exercise.
const baseConfig: LLMConfig = {
  llmProvider: 'openai',
  llmModel: 'gpt-4o-mini',
  openaiApiKey: 'test-openai-key',
  anthropicApiKey: 'test-anthropic-key',
  googleApiKey: 'test-google-key',
  groqApiKey: 'test-groq-key',
  llmApiUrl: undefined,
  llmApiKey: undefined,
  codexAuthPath: '/tmp/codex-auth.json',
  ollamaBaseUrl: 'http://localhost:11434',
  llmSeed: undefined,
  costLoggingEnabled: false,
  costRunId: 'test',
  costLogDir: '/tmp/test-cost',
};

describe('createLLMProvider', () => {
  beforeEach(() => {
    initLlm({ ...baseConfig });
  });

  it('creates OpenAI provider', () => {
    const provider = createLLMProvider();
    expect(provider).toBeDefined();
    expect(typeof provider.chat).toBe('function');
  });

  it('creates Anthropic provider', () => {
    initLlm({ ...baseConfig, llmProvider: 'anthropic', llmModel: 'claude-sonnet-4-20250514' });
    const provider = createLLMProvider();
    expect(provider).toBeDefined();
    expect(typeof provider.chat).toBe('function');
  });

  it('creates Google GenAI provider via OpenAI-compatible', () => {
    initLlm({ ...baseConfig, llmProvider: 'google-genai', llmModel: 'gemini-2.0-flash' });
    const provider = createLLMProvider();
    expect(provider).toBeDefined();
    expect(typeof provider.chat).toBe('function');
  });

  it('creates Groq provider', () => {
    initLlm({ ...baseConfig, llmProvider: 'groq', llmModel: 'llama-3.3-70b-versatile' });
    const provider = createLLMProvider();
    expect(provider).toBeDefined();
    expect(typeof provider.chat).toBe('function');
  });

  it('creates Ollama provider', () => {
    initLlm({ ...baseConfig, llmProvider: 'ollama', llmModel: 'llama3' });
    const provider = createLLMProvider();
    expect(provider).toBeDefined();
    expect(typeof provider.chat).toBe('function');
  });

  it('creates Claude Code provider', () => {
    initLlm({ ...baseConfig, llmProvider: 'claude-code', llmModel: '' });
    const provider = createLLMProvider();
    expect(provider).toBeDefined();
    expect(typeof provider.chat).toBe('function');
  });

  it('creates Codex OAuth provider', () => {
    initLlm({ ...baseConfig, llmProvider: 'codex', llmModel: '' });
    const provider = createLLMProvider();
    expect(provider).toBeDefined();
    expect(typeof provider.chat).toBe('function');
  });

  it('throws for unknown provider', () => {
    initLlm({ ...baseConfig, llmProvider: 'unknown-provider' as never });
    expect(() => createLLMProvider()).toThrow('Unknown LLM provider');
  });
});
