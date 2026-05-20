/**
 * Unit tests for the Codex OAuth-backed LLM provider.
 */

import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CODEX_LLM_MODEL } from '../llm-defaults.js';

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));

const { CodexLLM } = await import('../codex-llm.js');
const readFileMock = vi.mocked(readFile);
const fetchMock = vi.fn<typeof fetch>();

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function provider(): InstanceType<typeof CodexLLM> {
  return new CodexLLM({
    llmProvider: 'codex',
    llmModel: DEFAULT_CODEX_LLM_MODEL,
    llmApiUrl: undefined,
    codexAuthPath: '/tmp/codex-auth.json',
    costLoggingEnabled: false,
    costRunId: 'test',
    costLogDir: '/tmp/test-cost',
  });
}

function mockAuth(): void {
  readFileMock.mockResolvedValue(JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: {
      access_token: 'codex-token',
      account_id: 'acct-123',
    },
  }));
}

function mockSseResponse(body: string): void {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => body,
  } as Response);
}

function sse(...parts: string[]): string {
  return parts.map((part) => `event: response.text.delta\ndata: ${JSON.stringify({ delta: part })}\n`).join('');
}

describe('CodexLLM', () => {
  it('calls the Codex backend directly with OAuth credentials from the Codex auth file', async () => {
    mockAuth();
    mockSseResponse(sse('{', '"memories": []', '}'));

    const text = await provider().chat([
      { role: 'system', content: 'Extract memory JSON.' },
      { role: 'user', content: 'User prefers concise answers.' },
    ], { jsonMode: true, maxTokens: 256 });

    const fetchCall = fetchMock.mock.calls[0];
    const requestBody = JSON.parse(String(fetchCall?.[1]?.body)) as Record<string, unknown>;
    expect(text).toBe('{"memories": []}');
    expect(fetchCall?.[0]).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(fetchCall?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer codex-token',
      'OpenAI-Account-ID': 'acct-123',
      Origin: 'https://chatgpt.com',
    });
    expect(requestBody.model).toBe(DEFAULT_CODEX_LLM_MODEL);
    expect(requestBody.instructions).toContain('Return only valid JSON');
    expect(requestBody.input).toEqual([
      { type: 'message', role: 'user', content: 'User prefers concise answers.' },
    ]);
    expect(requestBody.store).toBe(false);
    expect(requestBody.stream).toBe(true);
    expect(requestBody.max_output_tokens).toBe(256);
    expect(requestBody.prompt_cache_key).toMatch(/^atomicmemory:[a-f0-9]{32}$/);
  });

  it('uses a stable cache key for repeated extraction prompts', async () => {
    mockAuth();
    mockSseResponse(sse('ok'));

    const messages = [
      { role: 'system' as const, content: 'Extract memory JSON.' },
      { role: 'user' as const, content: 'First user content.' },
    ];

    await provider().chat(messages, { jsonMode: true });
    await provider().chat([
      messages[0],
      { role: 'user', content: 'Different user content.' },
    ], { jsonMode: true });

    const cacheKeys = fetchMock.mock.calls.map((call) => {
      const body = JSON.parse(String(call[1]?.body)) as Record<string, unknown>;
      return body.prompt_cache_key;
    });
    expect(cacheKeys[0]).toBe(cacheKeys[1]);
  });

  it('rejects missing Codex auth with setup guidance', async () => {
    readFileMock.mockRejectedValue(new Error('ENOENT'));

    await expect(provider().chat([{ role: 'user', content: 'hello' }]))
      .rejects.toThrow('Run `codex login`');
  });

  it('rejects non-ChatGPT Codex auth files', async () => {
    readFileMock.mockResolvedValue(JSON.stringify({ auth_mode: 'apikey' }));

    await expect(provider().chat([{ role: 'user', content: 'hello' }]))
      .rejects.toThrow('not a ChatGPT login');
  });

  it('surfaces Codex HTTP auth failures with re-login guidance', async () => {
    mockAuth();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'unauthorized',
    } as Response);

    await expect(provider().chat([{ role: 'user', content: 'hello' }]))
      .rejects.toThrow('Run `codex login` again');
  });
});
