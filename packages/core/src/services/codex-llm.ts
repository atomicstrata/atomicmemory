/**
 * Codex OAuth-backed LLM provider for local personal development.
 *
 * This provider reads the authentication file created by `codex login` and
 * calls the Codex backend directly. That keeps the local account-auth
 * quickstart while avoiding a per-call shell-out to the Codex agent CLI.
 */

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { ChatMessage, ChatOptions, LLMProvider } from './llm.js';
import {
  estimateCostUsd,
  getCostStage,
  summarizeUsage,
  writeCostEvent,
  type WriteCostEventConfig,
} from './cost-telemetry.js';
import { DEFAULT_CODEX_LLM_MODEL } from './llm-defaults.js';

const CODEX_DEFAULT_BASE_URL = 'https://chatgpt.com/backend-api';
const CODEX_REQUEST_TIMEOUT_MS = 120_000;
const CODEX_USER_AGENT = 'AtomicMemory Core Codex Provider';

export interface CodexLLMConfig extends WriteCostEventConfig {
  llmProvider: 'codex';
  llmModel: string;
  llmApiUrl?: string;
  codexAuthPath: string;
}

interface CodexAuthFile {
  auth_mode?: string;
  tokens?: {
    access_token?: string;
    account_id?: string;
  };
}

interface CodexPayloadMessage {
  type: 'message';
  role: ChatMessage['role'];
  content: string;
}

export class CodexLLM implements LLMProvider {
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(private readonly config: CodexLLMConfig) {
    this.model = config.llmModel || DEFAULT_CODEX_LLM_MODEL;
    this.baseUrl = config.llmApiUrl || CODEX_DEFAULT_BASE_URL;
  }

  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
    const started = performance.now();
    const auth = await loadCodexAuth(this.config.codexAuthPath);
    const response = await postCodexResponse(this.baseUrl, buildCodexPayload(this.model, messages, options), auth);
    recordCodexCost(this.config, this.model, messages, response, started);
    return response;
  }
}

async function loadCodexAuth(authPath: string): Promise<{ accessToken: string; accountId?: string }> {
  let parsed: CodexAuthFile;
  try {
    parsed = JSON.parse(await readFile(authPath, 'utf8')) as CodexAuthFile;
  } catch (error) {
    throw new Error(`Codex auth file could not be read at ${authPath}. Run \`codex login\`: ${errorMessage(error)}`);
  }
  if (parsed.auth_mode !== 'chatgpt') {
    throw new Error(`Codex auth file at ${authPath} is not a ChatGPT login. Run \`codex login\`.`);
  }
  const accessToken = parsed.tokens?.access_token;
  if (!accessToken) {
    throw new Error(`Codex auth file at ${authPath} has no access token. Run \`codex login\` again.`);
  }
  return { accessToken, accountId: parsed.tokens?.account_id };
}

function buildCodexPayload(model: string, messages: ChatMessage[], options: ChatOptions): Record<string, unknown> {
  const { instructions, input } = splitCodexMessages(messages, options.jsonMode === true);
  return {
    model,
    instructions,
    input,
    tools: [],
    tool_choice: 'auto',
    parallel_tool_calls: true,
    reasoning: { summary: 'concise' },
    store: false,
    stream: true,
    include: ['reasoning.encrypted_content'],
    prompt_cache_key: randomUUID(),
  };
}

function splitCodexMessages(
  messages: ChatMessage[],
  jsonMode: boolean,
): { instructions: string; input: CodexPayloadMessage[] } {
  const systemParts = jsonMode ? ['Return only valid JSON. Do not include markdown fences or commentary.'] : [];
  const input: CodexPayloadMessage[] = [];
  for (const message of messages) {
    if (message.role === 'system') {
      systemParts.push(message.content);
      continue;
    }
    input.push({ type: 'message', role: message.role, content: message.content });
  }
  return { instructions: systemParts.join('\n\n'), input };
}

async function postCodexResponse(
  baseUrl: string,
  payload: Record<string, unknown>,
  auth: { accessToken: string; accountId?: string },
): Promise<string> {
  const response = await fetch(`${baseUrl}/codex/responses`, {
    method: 'POST',
    headers: codexHeaders(auth),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(CODEX_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw await codexHttpError(response);
  const content = parseCodexSse(await response.text());
  if (!content.trim()) throw new Error('Codex returned an empty response');
  return content;
}

function codexHeaders(auth: { accessToken: string; accountId?: string }): Record<string, string> {
  return {
    Authorization: `Bearer ${auth.accessToken}`,
    'Content-Type': 'application/json',
    'User-Agent': CODEX_USER_AGENT,
    Origin: 'https://chatgpt.com',
    ...(auth.accountId ? { 'OpenAI-Account-ID': auth.accountId } : {}),
  };
}

async function codexHttpError(response: Response): Promise<Error> {
  const body = (await response.text()).slice(0, 300);
  if (response.status === 401 || response.status === 403) {
    return new Error(`Codex authentication failed with HTTP ${response.status}. Run \`codex login\` again.`);
  }
  return new Error(`Codex backend failed with HTTP ${response.status}: ${body}`);
}

function parseCodexSse(body: string): string {
  let eventType = '';
  let fullText = '';
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line.startsWith('event: ')) eventType = line.slice('event: '.length);
    if (line.startsWith('data: ')) fullText += parseCodexDataLine(eventType, line.slice('data: '.length));
  }
  return fullText;
}

function parseCodexDataLine(eventType: string, dataText: string): string {
  if (dataText === '[DONE]') return '';
  try {
    const data = JSON.parse(dataText) as Record<string, unknown>;
    if (eventType === 'response.text.delta' || eventType === 'response.content_part.delta') {
      return typeof data.delta === 'string' ? data.delta : '';
    }
    return textFromCodexItem(data.item);
  } catch {
    return '';
  }
}

function textFromCodexItem(item: unknown): string {
  if (!isRecord(item)) return '';
  const content = item.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(textFromContentPart).join('');
}

function textFromContentPart(part: unknown): string {
  return isRecord(part) && typeof part.text === 'string' ? part.text : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function recordCodexCost(
  config: CodexLLMConfig,
  model: string,
  messages: ChatMessage[],
  response: string,
  started: number,
): void {
  const inputTokens = estimateTokens(messages.map((m) => m.content).join('\n'));
  const outputTokens = estimateTokens(response);
  const usage = summarizeUsage(inputTokens, outputTokens);
  writeCostEvent({
    stage: getCostStage(),
    provider: config.llmProvider,
    model,
    requestKind: 'chat',
    durationMs: performance.now() - started,
    cacheHit: false,
    inputTokens: usage.inputTokens ?? null,
    outputTokens: usage.outputTokens ?? null,
    totalTokens: usage.totalTokens ?? null,
    estimatedCostUsd: estimateCostUsd(config.llmProvider, model, usage),
  }, config);
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
