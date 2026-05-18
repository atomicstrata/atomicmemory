/**
 * Unit tests for the Claude Code Agent SDK-backed LLM provider.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: mocks.query,
}));

const { ClaudeCodeLLM } = await import('../claude-code-llm.js');

afterEach(() => {
  vi.clearAllMocks();
});

function provider(): InstanceType<typeof ClaudeCodeLLM> {
  return new ClaudeCodeLLM({
    llmProvider: 'claude-code',
    llmModel: 'sonnet',
    costLoggingEnabled: false,
    costRunId: 'test',
    costLogDir: '/tmp/test-cost',
  });
}

function defaultModelProvider(): InstanceType<typeof ClaudeCodeLLM> {
  return new ClaudeCodeLLM({
    llmProvider: 'claude-code',
    llmModel: '',
    costLoggingEnabled: false,
    costRunId: 'test',
    costLogDir: '/tmp/test-cost',
  });
}

function resultMessage(result: string): Record<string, unknown> {
  return {
    type: 'result',
    subtype: 'success',
    result,
    total_cost_usd: 0,
    modelUsage: { sonnet: { inputTokens: 12, outputTokens: 4 } },
  };
}

async function* messages(items: Record<string, unknown>[]): AsyncGenerator<Record<string, unknown>> {
  for (const item of items) yield item;
}

describe('ClaudeCodeLLM', () => {
  it('runs an isolated one-turn Claude Code query', async () => {
    mocks.query.mockReturnValueOnce(messages([resultMessage('{"memories": []}')]));

    const text = await provider().chat([
      { role: 'system', content: 'Extract memory JSON.' },
      { role: 'user', content: 'User prefers concise answers.' },
    ], { jsonMode: true });

    const call = mocks.query.mock.calls[0]?.[0];
    expect(text).toBe('{"memories": []}');
    expect(call.options).toMatchObject({
      model: 'sonnet',
      tools: [],
      mcpServers: {},
      settingSources: [],
      persistSession: false,
      permissionMode: 'dontAsk',
      maxTurns: 1,
    });
    expect(call.options.systemPrompt).toContain('Return only valid JSON');
  });

  it('omits model when core is configured to use Claude Code default', async () => {
    mocks.query.mockReturnValueOnce(messages([resultMessage('ok')]));

    await defaultModelProvider().chat([{ role: 'user', content: 'hello' }]);

    const call = mocks.query.mock.calls[0]?.[0];
    expect(call.options).not.toHaveProperty('model');
  });

  it('surfaces SDK execution failures with setup guidance', async () => {
    mocks.query.mockImplementationOnce(() => {
      throw new Error('not authenticated');
    });

    await expect(provider().chat([{ role: 'user', content: 'hello' }]))
      .rejects.toThrow('Confirm `claude` is installed and authenticated');
  });
});
