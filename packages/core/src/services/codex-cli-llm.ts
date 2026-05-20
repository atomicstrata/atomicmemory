/**
 * Codex CLI-backed LLM provider for local personal development.
 *
 * This provider delegates extraction turns to a locally authenticated Codex CLI
 * account session. It is intentionally isolated from project rules, MCP, and
 * writable workspace state so core extraction behaves like a one-turn chat
 * completion rather than a coding-agent task.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatMessage, ChatOptions, LLMProvider } from './llm.js';
import {
  estimateCostUsd,
  getCostStage,
  writeCostEvent,
  type WriteCostEventConfig,
} from './cost-telemetry.js';

const CODEX_EXEC_TIMEOUT_MS = 300_000;
const CODEX_STATUS_TIMEOUT_MS = 10_000;
const CODEX_MAX_BUFFER_BYTES = 64 * 1024;
const CODEX_CHILD_ENV_KEYS = [
  'PATH',
  'HOME',
  'CODEX_HOME',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'TMPDIR',
  'LANG',
  'LC_ALL',
] as const;

interface ExecResult {
  stdout: string;
  stderr: string;
}

export interface CodexCliLLMConfig extends WriteCostEventConfig {
  llmProvider: 'codex';
  llmModel: string;
}

export class CodexCliLLM implements LLMProvider {
  constructor(private readonly config: CodexCliLLMConfig) {}

  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
    const started = performance.now();
    await assertCodexLoggedIn();
    const result = await runCodexExec(buildPrompt(messages, options), this.config.llmModel);
    recordCodexCost(this.config, started);
    return result;
  }
}

function buildPrompt(messages: ChatMessage[], options: ChatOptions): string {
  const body = messages.map(formatMessage).join('\n\n').trim();
  if (!options.jsonMode) return body;
  return [
    'Return only valid JSON. Do not include markdown fences or commentary.',
    body,
  ].join('\n\n');
}

function formatMessage(message: ChatMessage): string {
  return `${message.role.toUpperCase()}:\n${message.content}`;
}

async function assertCodexLoggedIn(): Promise<void> {
  try {
    const { stdout, stderr } = await runCommand('codex', ['login', 'status'], {
      timeout: CODEX_STATUS_TIMEOUT_MS,
      maxBuffer: CODEX_MAX_BUFFER_BYTES,
      env: codexChildEnv(),
    });
    const statusText = `${stdout}\n${stderr}`.trim();
    if (!/\blogged in\b/i.test(statusText) || /\bnot logged in\b/i.test(statusText)) {
      throw new Error(statusText || 'Codex login status did not report logged in');
    }
  } catch (error) {
    throw new Error(
      'Codex CLI LLM failed before execution. Confirm `codex` is installed and authenticated: ' +
      errorMessage(error),
    );
  }
}

async function runCodexExec(prompt: string, model: string): Promise<string> {
  const workDir = await mkdtemp(join(tmpdir(), 'atomicmemory-codex-'));
  const outputPath = join(workDir, 'last-message.txt');
  try {
    await runCommand('codex', codexExecArgs(outputPath, model, prompt), {
      cwd: workDir,
      timeout: CODEX_EXEC_TIMEOUT_MS,
      maxBuffer: CODEX_MAX_BUFFER_BYTES,
      env: codexChildEnv(),
    });
    return await readCodexOutput(outputPath);
  } catch (error) {
    throw new Error(
      'Codex CLI LLM failed to run. Confirm `codex` is installed and authenticated: ' +
      errorMessage(error),
    );
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

function runCommand(
  file: string,
  args: string[],
  options: { cwd?: string; timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv },
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
    (child as { stdin?: { end?: () => void } } | null)?.stdin?.end?.();
  });
}

function codexExecArgs(outputPath: string, model: string, prompt: string): string[] {
  return [
    'exec',
    '--ephemeral',
    '--ignore-rules',
    '--ignore-user-config',
    '--skip-git-repo-check',
    '--sandbox',
    'read-only',
    '--color',
    'never',
    '--output-last-message',
    outputPath,
    ...(model ? ['--model', model] : []),
    prompt,
  ];
}

function codexChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of CODEX_CHILD_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

async function readCodexOutput(outputPath: string): Promise<string> {
  const output = (await readFile(outputPath, 'utf8')).trim();
  if (!output) throw new Error('Codex CLI wrote an empty final response');
  return output;
}

function recordCodexCost(config: CodexCliLLMConfig, started: number): void {
  const model = config.llmModel || 'codex-default';
  writeCostEvent({
    stage: getCostStage(),
    provider: config.llmProvider,
    model,
    requestKind: 'chat',
    durationMs: performance.now() - started,
    cacheHit: false,
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    estimatedCostUsd: estimateCostUsd(config.llmProvider, model),
  }, config);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
