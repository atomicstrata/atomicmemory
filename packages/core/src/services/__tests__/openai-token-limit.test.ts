/**
 * @file Request-path regressions for the OpenAI Chat Completions provider
 * — token-limit swap, sampling-param omission, visible-output guard, and
 * the retry classifier. Pure helper tests live in openai-chat-params.test.ts.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const { createMock } = vi.hoisted(() => ({
  createMock: vi.fn(),
}));

vi.mock('openai', () => ({
  default: class OpenAI {
    chat = { completions: { create: createMock } };
  },
}));

vi.mock('../api-retry.js', () => ({
  retryOnRateLimit: async <T>(fn: () => Promise<T>) => fn(),
}));

vi.mock('../cost-telemetry.js', () => ({
  estimateCostUsd: () => 0,
  getCostStage: () => 'test',
  summarizeUsage: () => ({ inputTokens: null, outputTokens: null, totalTokens: null }),
  writeCostEvent: () => undefined,
}));

import { createLLMProvider, initLlm, type LLMConfig } from '../llm.js';

function baseConfig(overrides: Partial<LLMConfig> = {}): LLMConfig {
  return {
    llmProvider: 'openai',
    llmModel: 'gpt-4o-mini',
    openaiApiKey: 'test-key',
    ollamaBaseUrl: 'http://127.0.0.1:11434',
    codexAuthPath: '/tmp/codex-auth.json',
    costLoggingEnabled: false,
    costRunId: 'test',
    costLogDir: '/tmp/test-cost',
    ...overrides,
  };
}

afterEach(() => {
  createMock.mockReset();
  vi.clearAllMocks();
});

function mockChatOk(content: string = '{}', finishReason: string = 'stop'): void {
  createMock.mockResolvedValueOnce({
    choices: [{ message: { content }, finish_reason: finishReason }],
    usage: {},
  });
}

describe('OpenAICompatibleLLM chat retry path', () => {
  it('retries once swapping max_tokens for max_completion_tokens', async () => {
    initLlm(baseConfig({ llmModel: 'gpt-4o-mini' }));
    const llm = createLLMProvider();
    createMock
      .mockRejectedValueOnce(
        new Error(
          "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
        ),
      )
      .mockResolvedValueOnce({
        choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });

    const text = await llm.chat(
      [{ role: 'user', content: 'hi' }],
      { maxTokens: 50 },
    );

    expect(text).toBe('{"ok":true}');
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(createMock.mock.calls[0]?.[0]).toMatchObject({
      model: 'gpt-4o-mini',
      max_tokens: 50,
    });
    expect(createMock.mock.calls[0]?.[0]).not.toHaveProperty('max_completion_tokens');
    expect(createMock.mock.calls[1]?.[0]).toMatchObject({
      model: 'gpt-4o-mini',
      max_completion_tokens: 50,
    });
    expect(createMock.mock.calls[1]?.[0]).not.toHaveProperty('max_tokens');
    expect(createMock.mock.calls[1]?.[0]).not.toHaveProperty('reasoning_effort');
  });

  it('does not retry an unrelated 400', async () => {
    initLlm(baseConfig({ llmModel: 'gpt-4o-mini' }));
    const llm = createLLMProvider();
    createMock.mockRejectedValueOnce(new Error('400 Bad Request: invalid_request_error'));

    await expect(
      llm.chat([{ role: 'user', content: 'hi' }], { maxTokens: 50 }),
    ).rejects.toThrow(/invalid_request_error/);
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it('sends max_completion_tokens and reasoning_effort none for gpt-5 mini', async () => {
    initLlm(baseConfig({ llmModel: 'gpt-5.4-mini' }));
    const llm = createLLMProvider();
    mockChatOk('{"ns":"ok"}');

    const text = await llm.chat(
      [{ role: 'user', content: 'classify' }],
      { maxTokens: 50 },
    );

    expect(text).toBe('{"ns":"ok"}');
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock.mock.calls[0]?.[0]).toMatchObject({
      max_completion_tokens: 50,
      reasoning_effort: 'none',
    });
  });

  it('fails closed for Responses-only gpt-5 pro on OpenAI provider creation', () => {
    initLlm(baseConfig({ llmModel: 'gpt-5.4-pro' }));
    expect(() => createLLMProvider()).toThrow(/Responses API only/);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('fails closed for Responses-only older Codex SKUs on OpenAI', () => {
    for (const model of ['gpt-5-codex', 'gpt-5.1-codex'] as const) {
      createMock.mockReset();
      initLlm(baseConfig({ llmModel: model }));
      expect(() => createLLMProvider()).toThrow(/Responses API only/);
      expect(createMock).not.toHaveBeenCalled();
    }
  });

  it('allows google-genai gemini-2.5-pro through the OpenAI transport', async () => {
    initLlm(baseConfig({
      llmProvider: 'google-genai',
      llmModel: 'gemini-2.5-pro',
    }));
    const llm = createLLMProvider();
    mockChatOk('{"ok":true}');

    const text = await llm.chat([{ role: 'user', content: 'hi' }], { maxTokens: 50 });
    expect(text).toBe('{"ok":true}');
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock.mock.calls[0]?.[0]).toMatchObject({
      model: 'gemini-2.5-pro',
      max_tokens: 50,
    });
  });

  it('omits reasoning_effort for gpt-5.1-chat-latest', async () => {
    initLlm(baseConfig({ llmModel: 'gpt-5.1-chat-latest' }));
    const llm = createLLMProvider();
    mockChatOk();

    await llm.chat([{ role: 'user', content: 'x' }], { maxTokens: 50 });
    expect(createMock.mock.calls[0]?.[0]).toMatchObject({
      max_completion_tokens: 50,
    });
    expect(createMock.mock.calls[0]?.[0]).not.toHaveProperty('reasoning_effort');
  });

  it('sends minimal for original gpt-5 and low for o3-mini (never none)', async () => {
    initLlm(baseConfig({ llmModel: 'gpt-5' }));
    let llm = createLLMProvider();
    mockChatOk();
    await llm.chat([{ role: 'user', content: 'x' }], { maxTokens: 50 });
    expect(createMock.mock.calls[0]?.[0]).toMatchObject({ reasoning_effort: 'minimal' });

    createMock.mockReset();
    initLlm(baseConfig({ llmModel: 'o3-mini' }));
    llm = createLLMProvider();
    mockChatOk();
    await llm.chat([{ role: 'user', content: 'x' }], { maxTokens: 50 });
    expect(createMock.mock.calls[0]?.[0]).toMatchObject({ reasoning_effort: 'low' });
  });

  it('sends low for gpt-5.3-codex and never none', async () => {
    initLlm(baseConfig({ llmModel: 'gpt-5.3-codex' }));
    const llm = createLLMProvider();
    mockChatOk();
    await llm.chat([{ role: 'user', content: 'x' }], { maxTokens: 50 });
    expect(createMock.mock.calls[0]?.[0]).toMatchObject({
      max_completion_tokens: 50,
      reasoning_effort: 'low',
    });
  });

  it('omits temperature and seed for actively-reasoning models (minimal/low)', async () => {
    // GPT-5 family and o-series at effort minimal/low reject non-default
    // sampling controls when reasoning is active.
    initLlm(baseConfig({ llmModel: 'gpt-5', llmSeed: 42 }));
    const llm = createLLMProvider();
    mockChatOk();

    await llm.chat([{ role: 'user', content: 'x' }], { maxTokens: 50 });
    const call = createMock.mock.calls[0]?.[0];
    expect(call).toMatchObject({ max_completion_tokens: 50, reasoning_effort: 'minimal' });
    expect(call).not.toHaveProperty('temperature');
    expect(call).not.toHaveProperty('seed');
  });

  it('keeps temperature and seed for reasoning_effort:none models', async () => {
    // 'none' disables reasoning, so gpt-5.1+ base/mini keep the caller's
    // determinism controls while still sending reasoning_effort:'none'.
    initLlm(baseConfig({ llmModel: 'gpt-5.4-mini', llmSeed: 42 }));
    const llm = createLLMProvider();
    mockChatOk();

    await llm.chat([{ role: 'user', content: 'x' }], { maxTokens: 50 });
    expect(createMock.mock.calls[0]?.[0]).toMatchObject({
      max_completion_tokens: 50,
      reasoning_effort: 'none',
      temperature: 0,
      seed: 42,
    });
  });

  it('surfaces an unsupported-parameter backend error instead of swallowing it', async () => {
    // If a concrete backend later rejects temperature/seed on a none model,
    // that capability mismatch must stay visible: we do not silently strip
    // sampling and retry, which would discard the caller's determinism.
    initLlm(baseConfig({ llmModel: 'gpt-5.4-mini', llmSeed: 42 }));
    const llm = createLLMProvider();
    createMock.mockRejectedValue(
      new Error("400 Unsupported value: 'temperature' does not support 0 with this model."),
    );
    await expect(
      llm.chat([{ role: 'user', content: 'x' }], { maxTokens: 50 }),
    ).rejects.toThrow(/temperature/);
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it('keeps temperature and seed for legacy chat models', async () => {
    initLlm(baseConfig({ llmModel: 'gpt-4o-mini', llmSeed: 7 }));
    const llm = createLLMProvider();
    mockChatOk('ok');
    await llm.chat([{ role: 'user', content: 'x' }], { maxTokens: 200 });
    expect(createMock.mock.calls[0]?.[0]).toMatchObject({
      max_tokens: 200,
      temperature: 0,
      seed: 7,
    });
  });

  it('fails closed on finish_reason=length with empty content', async () => {
    // Was silently returning '' before; would flow into classifyNamespace
    // and be persisted (P2 regression from the round-N review).
    initLlm(baseConfig({ llmModel: 'gpt-5.4-mini' }));
    const llm = createLLMProvider();
    mockChatOk('', 'length');
    await expect(
      llm.chat([{ role: 'user', content: 'classify' }], { maxTokens: 50 }),
    ).rejects.toThrow(/truncated output.*length.*empty/);
  });

  it('fails closed on finish_reason=length with a non-empty truncated prefix', async () => {
    // A partial `{"namespace":"proj/` prefix would previously slip through
    // and be persisted as-is by classifyNamespace(...).
    initLlm(baseConfig({ llmModel: 'gpt-5.4-mini' }));
    const llm = createLLMProvider();
    mockChatOk('{"namespace":"proj/', 'length');
    await expect(
      llm.chat([{ role: 'user', content: 'classify' }], { maxTokens: 50 }),
    ).rejects.toThrow(/truncated output.*length.*non-empty but incomplete/);
  });

  it('fails closed on whitespace-only content for reasoning models', async () => {
    // '   ' used to slip through the exact-empty check and become a blank
    // namespace/fact downstream. o3-mini runs reasoning (effort=low), so the
    // "reasoning tokens" cause is accurate.
    initLlm(baseConfig({ llmModel: 'o3-mini' }));
    const llm = createLLMProvider();
    mockChatOk('   ', 'stop');
    await expect(
      llm.chat([{ role: 'user', content: 'classify' }], { maxTokens: 50 }),
    ).rejects.toThrow(/reasoning tokens/);
  });

  it('fails closed on empty content for reasoning models on stop', async () => {
    initLlm(baseConfig({ llmModel: 'gpt-5' }));
    const llm = createLLMProvider();
    createMock.mockResolvedValueOnce({
      choices: [{ message: { content: null }, finish_reason: 'stop' }],
      usage: {},
    });
    await expect(
      llm.chat([{ role: 'user', content: 'classify' }], { maxTokens: 50 }),
    ).rejects.toThrow(/reasoning tokens/);
  });

  it('retries on a structured OpenAI APIError code/param (not just substring)', async () => {
    initLlm(baseConfig({ llmModel: 'gpt-4o-mini' }));
    const llm = createLLMProvider();
    const structuredErr = Object.assign(
      new Error('The parameter is not supported'),
      { code: 'unsupported_parameter', param: 'max_tokens' },
    );
    createMock
      .mockRejectedValueOnce(structuredErr)
      .mockResolvedValueOnce({
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        usage: {},
      });

    const text = await llm.chat([{ role: 'user', content: 'x' }], { maxTokens: 50 });
    expect(text).toBe('ok');
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(createMock.mock.calls[1]?.[0]).toMatchObject({ max_completion_tokens: 50 });
    expect(createMock.mock.calls[1]?.[0]).not.toHaveProperty('max_tokens');
  });
});

describe('OpenAICompatibleLLM composes both mitigations bounded by 3 attempts', () => {
  const parseErr = () => new Error('Could not parse the JSON body of your request');
  const tokenErr = () =>
    new Error(
      "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
    );

  it('recovers from parse-error then token-error in exactly three attempts', async () => {
    // The reviewer reproduced this against a mock server: parse then token
    // used to abort after the second call because the two mitigations were
    // modeled as mutually exclusive catch branches.
    initLlm(baseConfig({ llmModel: 'gpt-4o-mini' }));
    const llm = createLLMProvider();
    createMock
      .mockRejectedValueOnce(parseErr())
      .mockRejectedValueOnce(tokenErr())
      .mockResolvedValueOnce({
        choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
        usage: {},
      });

    const text = await llm.chat([{ role: 'user', content: 'hi' }], { maxTokens: 50 });
    expect(text).toBe('{"ok":true}');
    expect(createMock).toHaveBeenCalledTimes(3);
    expect(createMock.mock.calls[0]?.[0]).toMatchObject({ max_tokens: 50 });
    expect(createMock.mock.calls[2]?.[0]).toMatchObject({ max_completion_tokens: 50 });
    expect(createMock.mock.calls[2]?.[0]).not.toHaveProperty('max_tokens');
  });

  it('recovers from token-error then parse-error in exactly three attempts', async () => {
    // Opposite ordering used to abort with the parse error propagating.
    initLlm(baseConfig({ llmModel: 'gpt-4o-mini' }));
    const llm = createLLMProvider();
    createMock
      .mockRejectedValueOnce(tokenErr())
      .mockRejectedValueOnce(parseErr())
      .mockResolvedValueOnce({
        choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
        usage: {},
      });

    const text = await llm.chat([{ role: 'user', content: 'hi' }], { maxTokens: 50 });
    expect(text).toBe('{"ok":true}');
    expect(createMock).toHaveBeenCalledTimes(3);
    expect(createMock.mock.calls[0]?.[0]).toMatchObject({ max_tokens: 50 });
    expect(createMock.mock.calls[1]?.[0]).toMatchObject({ max_completion_tokens: 50 });
    expect(createMock.mock.calls[2]?.[0]).toMatchObject({ max_completion_tokens: 50 });
  });

  it('never exceeds three attempts when a recognized error keeps recurring', async () => {
    // Each mitigation is one-shot: once aggressiveSanitize is set, a second
    // parse error propagates rather than triggering a fourth request.
    initLlm(baseConfig({ llmModel: 'gpt-4o-mini' }));
    const llm = createLLMProvider();
    createMock
      .mockRejectedValueOnce(parseErr())
      .mockRejectedValueOnce(parseErr());

    await expect(
      llm.chat([{ role: 'user', content: 'hi' }], { maxTokens: 50 }),
    ).rejects.toThrow(/parse the JSON body/);
    expect(createMock).toHaveBeenCalledTimes(2);
  });
});
