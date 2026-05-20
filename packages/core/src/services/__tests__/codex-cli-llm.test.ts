/**
 * Unit tests for the Codex CLI-backed LLM provider.
 */

import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

const { CodexCliLLM } = await import('../codex-cli-llm.js');
const execFileMock = vi.mocked(execFile);

afterEach(() => {
  vi.clearAllMocks();
});

function provider(): InstanceType<typeof CodexCliLLM> {
  return new CodexCliLLM({
    llmProvider: 'codex',
    llmModel: 'gpt-5.5',
    costLoggingEnabled: false,
    costRunId: 'test',
    costLogDir: '/tmp/test-cost',
  });
}

function defaultModelProvider(): InstanceType<typeof CodexCliLLM> {
  return new CodexCliLLM({
    llmProvider: 'codex',
    llmModel: '',
    costLoggingEnabled: false,
    costRunId: 'test',
    costLogDir: '/tmp/test-cost',
  });
}

function mockLoggedIn(): void {
  execFileMock.mockImplementationOnce((...args: unknown[]) => {
    const callback = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void;
    callback(null, 'Logged in using ChatGPT', '');
    return null as never;
  });
}

function mockCodexExec(output: string): void {
  execFileMock.mockImplementationOnce((...args: unknown[]) => {
    const callback = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void;
    const outputPath = outputPathFromArgs(args[1] as string[]);
    writeFileSync(outputPath, output, 'utf8');
    callback(null, '', '');
    return null as never;
  });
}

function mockCodexExecFailure(error: Error): void {
  execFileMock.mockImplementationOnce((...args: unknown[]) => {
    const callback = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void;
    callback(error, '', '');
    return null as never;
  });
}

function outputPathFromArgs(args: string[]): string {
  const flagIndex = args.indexOf('--output-last-message');
  if (flagIndex < 0) throw new Error('missing --output-last-message');
  return args[flagIndex + 1] ?? '';
}

describe('CodexCliLLM', () => {
  it('runs an isolated Codex exec turn through account auth', async () => {
    mockLoggedIn();
    mockCodexExec('{"memories": []}');

    const text = await provider().chat([
      { role: 'system', content: 'Extract memory JSON.' },
      { role: 'user', content: 'User prefers concise answers.' },
    ], { jsonMode: true });

    const execCall = execFileMock.mock.calls[1];
    expect(text).toBe('{"memories": []}');
    expect(execCall?.[0]).toBe('codex');
    expect(execCall?.[1]).toEqual(expect.arrayContaining([
      'exec',
      '--ephemeral',
      '--ignore-rules',
      '--ignore-user-config',
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      '--model',
      'gpt-5.5',
    ]));
    expect((execCall?.[1] as string[]).at(-1)).toContain('Return only valid JSON');
    expect(execCall?.[2]).toHaveProperty('env');
    expect((execCall?.[2] as { env: NodeJS.ProcessEnv }).env.OPENAI_API_KEY).toBeUndefined();
    expect((execCall?.[2] as { env: NodeJS.ProcessEnv }).env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('omits model when core is configured to use Codex default', async () => {
    mockLoggedIn();
    mockCodexExec('ok');

    await defaultModelProvider().chat([{ role: 'user', content: 'hello' }]);

    const execArgs = execFileMock.mock.calls[1]?.[1] as string[];
    expect(execArgs).not.toContain('--model');
  });

  it('surfaces missing Codex auth with setup guidance', async () => {
    execFileMock.mockImplementationOnce((...args: unknown[]) => {
      const callback = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void;
      callback(new Error('not logged in'), '', '');
      return null as never;
    });

    await expect(provider().chat([{ role: 'user', content: 'hello' }]))
      .rejects.toThrow('Confirm `codex` is installed and authenticated');
  });

  it('rejects empty final output', async () => {
    mockLoggedIn();
    mockCodexExec('   ');

    await expect(provider().chat([{ role: 'user', content: 'hello' }]))
      .rejects.toThrow('empty final response');
  });

  it('surfaces Codex exec failures with setup guidance', async () => {
    mockLoggedIn();
    mockCodexExecFailure(new Error('codex crashed'));

    await expect(provider().chat([{ role: 'user', content: 'hello' }]))
      .rejects.toThrow('Codex CLI LLM failed to run');
  });
});
