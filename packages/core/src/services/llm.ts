/**
 * LLM provider abstraction for chat completions.
 * Supports OpenAI, Ollama, and any OpenAI-compatible API (LM Studio, etc).
 * Provider is selected via PROVIDER_LLM env var.
 */

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { Agent as UndiciAgent } from 'undici';
import { retryOnRateLimit } from './api-retry.js';
import { CodexCliLLM } from './codex-cli-llm.js';
import {
  estimateCostUsd,
  getCostStage,
  summarizeUsage,
  writeCostEvent,
  type CostUsage,
  type WriteCostEventConfig,
} from './cost-telemetry.js';
import { ClaudeCodeLLM } from './claude-code-llm.js';
import type { LLMProviderName } from '../config.js';

/**
 * Config subset consumed by the LLM module. Same module-local-state
 * pattern as embedding.ts: provider/model selection is startup-only
 * (Phase 7 Step 3c), so holding the config as module state after init
 * matches the effective contract.
 */
export interface LLMConfig extends WriteCostEventConfig {
  llmProvider: LLMProviderName;
  llmModel: string;
  llmApiUrl?: string;
  llmApiKey?: string;
  openaiApiKey: string;
  groqApiKey?: string;
  anthropicApiKey?: string;
  googleApiKey?: string;
  ollamaBaseUrl: string;
  llmSeed?: number;
}

let llmConfig: LLMConfig | null = null;

/** Bind the LLM module's config. Called once by the composition root. */
export function initLlm(config: LLMConfig): void {
  llmConfig = config;
  provider = null;
  providerKey = '';
}

function requireConfig(): LLMConfig {
  if (!llmConfig) {
    throw new Error(
      'llm.ts: initLlm(config) must be called at composition-root time before chat. See runtime-container.ts.',
    );
  }
  return llmConfig;
}

/** Extended-timeout dispatcher for slow local models (e.g. qwen3 thinking mode). */
const ollamaDispatcher = new UndiciAgent({ headersTimeout: 300_000, bodyTimeout: 300_000 });

const OLLAMA_REQUEST_TIMEOUT_MS = 300_000;
const ANTHROPIC_DEFAULT_MAX_TOKENS = 1024;
const THINK_TAG_REGEX = /<think>[\s\S]*?<\/think>\s*/g;
const ANTHROPIC_THINKING_TAG_REGEX = /<thinking>[\s\S]*?<\/thinking>\s*/g;
const COLLAPSE_HORIZONTAL_WS = /[ \t]+/g;
const COLLAPSE_VERTICAL_WS = /\n{3,}/g;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
  seed?: number;
}

export interface LLMProvider {
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<string>;
}

const PRINTABLE_ASCII_MIN = 0x20;
const PRINTABLE_ASCII_MAX = 0x7e;
const DELETE_CHAR_CODE = 0x7f;
const LETTER_OR_NUMBER_REGEX = /\p{Letter}|\p{Number}/u;

/** True for ASCII control characters and DEL, excluding tab / CR / LF. */
function isStrippableControlChar(char: string): boolean {
  const codePoint = char.codePointAt(0) ?? 0;
  if (codePoint === DELETE_CHAR_CODE) return true;
  if (codePoint >= PRINTABLE_ASCII_MIN) return false;
  return char !== '\n' && char !== '\r' && char !== '\t';
}

/**
 * True when `char` is safe to preserve under aggressive-sanitize mode:
 * printable ASCII, or any Unicode letter / number. Everything else is
 * replaced with a space when aggressive sanitization is active.
 */
function isAggressiveSafeChar(char: string): boolean {
  const codePoint = char.codePointAt(0) ?? 0;
  if (codePoint >= PRINTABLE_ASCII_MIN && codePoint <= PRINTABLE_ASCII_MAX) return true;
  return LETTER_OR_NUMBER_REGEX.test(char);
}

/**
 * Per-character cleanup used by `sanitizeTransportContent`. Pulled out so the
 * outer map() callback stays trivial and the decision is composed from two
 * single-purpose predicates rather than one long if-ladder.
 */
function sanitizeTransportChar(char: string, aggressive: boolean): string {
  if (isStrippableControlChar(char)) return ' ';
  if (!aggressive) return char;
  return isAggressiveSafeChar(char) ? char : ' ';
}

function sanitizeTransportContent(content: string, aggressive: boolean = false): string {
  const normalized = content.normalize('NFKC');
  const cleaned = Array.from(normalized)
    .map((char) => sanitizeTransportChar(char, aggressive))
    .join('');
  return cleaned.replace(COLLAPSE_HORIZONTAL_WS, ' ').replace(COLLAPSE_VERTICAL_WS, '\n\n').trim();
}

function sanitizeMessages(messages: ChatMessage[], aggressive: boolean = false): ChatMessage[] {
  return messages.map((message) => ({
    ...message,
    content: sanitizeTransportContent(message.content, aggressive),
  }));
}

function isJsonBodyParseError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.includes('parse the JSON body of your request');
}

/**
 * Emit a `chat` cost event for the configured provider. Shared by every
 * provider class so the `writeCostEvent` payload shape lives in one place
 * (was previously duplicated three times with subtly different `??` ladders).
 */
function recordChatCost(model: string, usage: CostUsage, started: number): void {
  const config = requireConfig();
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

/** OpenAI-shaped `response.usage` we read off the SDK and (compatible) servers. */
interface OpenAIResponseUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

/** OpenAI and any OpenAI-compatible API (LM Studio at localhost:1234/v1, etc). */
class OpenAICompatibleLLM implements LLMProvider {
  private client: OpenAI;
  private model: string;

  constructor(apiKey: string, model: string, baseURL?: string) {
    this.client = new OpenAI({ apiKey, baseURL });
    this.model = model;
  }

  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
    try {
      return await this.executeOpenAIRequest(messages, options, false);
    } catch (error) {
      if (!isJsonBodyParseError(error)) throw error;
      return this.executeOpenAIRequest(messages, options, true);
    }
  }

  /** Execute a single OpenAI-compatible request with optional aggressive sanitization. */
  private async executeOpenAIRequest(
    messages: ChatMessage[],
    options: ChatOptions,
    aggressiveSanitize: boolean,
  ): Promise<string> {
    const effectiveSeed = options.seed ?? requireConfig().llmSeed;
    const request = () => this.client.chat.completions.create({
      model: this.model,
      messages: sanitizeMessages(messages, aggressiveSanitize),
      temperature: options.temperature ?? 0,
      max_tokens: options.maxTokens,
      ...(options.jsonMode ? { response_format: { type: 'json_object' as const } } : {}),
      ...(effectiveSeed !== undefined ? { seed: effectiveSeed } : {}),
    });

    const started = performance.now();
    const response = await retryOnRateLimit(request);
    recordOpenAICost(this.model, response.usage, started);
    return response.choices[0].message.content ?? '';
  }
}

/**
 * Record cost telemetry for an OpenAI-compatible response. Thin shim over
 * the shared `recordChatCost` that converts the OpenAI usage field names
 * into a normalized `CostUsage` once.
 */
function recordOpenAICost(
  model: string,
  responseUsage: OpenAIResponseUsage | undefined,
  started: number,
): void {
  const usage = summarizeUsage(
    responseUsage?.prompt_tokens ?? null,
    responseUsage?.completion_tokens ?? null,
    responseUsage?.total_tokens ?? null,
  );
  recordChatCost(model, usage, started);
}

interface OllamaChatRequestBody {
  model: string;
  messages: ChatMessage[];
  stream: false;
  think: false;
  options: { temperature: number; num_predict?: number; seed?: number };
  format?: 'json';
}

interface OllamaChatResponse {
  message: { content: string; thinking?: string };
  prompt_eval_count?: number;
  eval_count?: number;
}

function buildOllamaRequestBody(
  model: string,
  messages: ChatMessage[],
  options: ChatOptions,
  configuredSeed: number | undefined,
): OllamaChatRequestBody {
  const effectiveSeed = options.seed ?? configuredSeed;
  return {
    model,
    messages,
    stream: false,
    think: false,
    options: {
      temperature: options.temperature ?? 0,
      ...(options.maxTokens ? { num_predict: options.maxTokens } : {}),
      ...(effectiveSeed !== undefined ? { seed: effectiveSeed } : {}),
    },
    ...(options.jsonMode ? { format: 'json' } : {}),
  };
}

/**
 * Reasoning models (qwen3) put their output in `thinking` when `content` is
 * empty. Treat that as the primary content rather than a "fallback mode" —
 * the response shape simply varies by model family.
 */
function extractOllamaContent(data: OllamaChatResponse): string {
  const content = stripThinkingTags(data.message.content);
  if (content) return content;
  if (data.message.thinking) return stripThinkingTags(data.message.thinking);
  return content;
}

/** Ollama via its native HTTP API at localhost:11434. */
class OllamaLLM implements LLMProvider {
  private baseUrl: string;
  private model: string;

  constructor(model: string, baseUrl: string = 'http://localhost:11434') {
    this.baseUrl = baseUrl;
    this.model = model;
  }

  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
    const body = buildOllamaRequestBody(this.model, messages, options, requireConfig().llmSeed);
    const started = performance.now();
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(OLLAMA_REQUEST_TIMEOUT_MS),
      // @ts-expect-error -- Node.js fetch supports undici dispatcher option
      dispatcher: ollamaDispatcher,
    });
    if (!response.ok) {
      throw new Error(`Ollama chat failed (${response.status}): ${await response.text()}`);
    }
    const data = await response.json() as OllamaChatResponse;
    const usage = summarizeUsage(data.prompt_eval_count ?? null, data.eval_count ?? null, null);
    recordChatCost(this.model, usage, started);
    return extractOllamaContent(data);
  }
}

/** Strip <think>...</think> tags that reasoning models (e.g. qwen3) emit. */
function stripThinkingTags(text: string): string {
  return text.replace(THINK_TAG_REGEX, '').trim();
}

interface AnthropicConversation {
  system?: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
}

/**
 * Split a mixed chat history into Anthropic's `(system, messages[])` shape.
 * Anthropic's API takes the system prompt at the request level rather than
 * as a role inside `messages`, so the two surfaces must be separated.
 */
function splitAnthropicMessages(messages: ChatMessage[]): AnthropicConversation {
  const systemMsg = messages.find((m) => m.role === 'system');
  const conversation = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
  return systemMsg ? { system: systemMsg.content, messages: conversation } : { messages: conversation };
}

function extractAnthropicText(
  response: { content: { type: string; text?: string }[] },
): string {
  const textBlock = response.content.find((b) => b.type === 'text');
  return (textBlock?.text ?? '').replace(ANTHROPIC_THINKING_TAG_REGEX, '').trim();
}

/** Anthropic Claude API. */
class AnthropicLLM implements LLMProvider {
  private client: Anthropic;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
    const split = splitAnthropicMessages(messages);
    const request = () => this.client.messages.create({
      model: this.model,
      max_tokens: options.maxTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS,
      temperature: options.temperature ?? 0,
      ...(split.system !== undefined ? { system: split.system } : {}),
      messages: split.messages,
    });
    const started = performance.now();
    const response = await retryOnRateLimit(request);
    const usage = summarizeUsage(
      response.usage?.input_tokens ?? null,
      response.usage?.output_tokens ?? null,
      null,
    );
    recordChatCost(this.model, usage, started);
    return extractAnthropicText(response);
  }
}

/** Create LLM provider from config. */
export function createLLMProvider(): LLMProvider {
  const config = requireConfig();
  switch (config.llmProvider) {
    case 'openai':
      return new OpenAICompatibleLLM(config.openaiApiKey, config.llmModel);
    case 'ollama':
      return new OllamaLLM(config.llmModel, config.ollamaBaseUrl);
    case 'groq':
      return new OpenAICompatibleLLM(
        config.groqApiKey ?? '',
        config.llmModel,
        'https://api.groq.com/openai/v1',
      );
    case 'anthropic':
      return new AnthropicLLM(config.anthropicApiKey ?? '', config.llmModel);
    case 'google-genai':
      return new OpenAICompatibleLLM(
        config.googleApiKey ?? '',
        config.llmModel,
        'https://generativelanguage.googleapis.com/v1beta/openai/',
      );
    case 'claude-code':
      return new ClaudeCodeLLM({
        llmProvider: config.llmProvider,
        llmModel: config.llmModel,
        costLoggingEnabled: config.costLoggingEnabled,
        costRunId: config.costRunId,
        costLogDir: config.costLogDir,
      });
    case 'codex':
      return new CodexCliLLM({
        llmProvider: config.llmProvider,
        llmModel: config.llmModel,
        costLoggingEnabled: config.costLoggingEnabled,
        costRunId: config.costRunId,
        costLogDir: config.costLogDir,
      });
    case 'openai-compatible':
      return new OpenAICompatibleLLM(
        config.llmApiKey ?? config.openaiApiKey,
        config.llmModel,
        config.llmApiUrl,
      );
    default:
      throw new Error(`Unknown LLM provider: ${config.llmProvider}`);
  }
}

let provider: LLMProvider | null = null;
let providerKey = '';

function getProviderKey(): string {
  const config = requireConfig();
  return [
    config.llmProvider,
    config.llmModel,
    config.llmApiUrl ?? '',
    config.ollamaBaseUrl,
  ].join('|');
}

function getProvider(): LLMProvider {
  const nextKey = getProviderKey();
  if (!provider || nextKey !== providerKey) {
    provider = createLLMProvider();
    providerKey = nextKey;
  }
  return provider;
}

/** Singleton-like LLM accessor that refreshes when runtime config changes. */
export const llm: LLMProvider = {
  chat(messages, options) {
    return getProvider().chat(messages, options);
  },
};

/** Schema shape expected by callAnthropicTool. */
export interface AnthropicToolSchema {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/**
 * Invoke an Anthropic model in forced tool-use mode and return the parsed
 * tool input. Uses the module-local config (set by initLlm) for the API key.
 *
 * @param model   - Anthropic model ID (e.g. 'claude-sonnet-4-5').
 * @param system  - System prompt.
 * @param user    - User message.
 * @param toolSchema - Tool definition; the model is forced to call this tool.
 * @returns Parsed tool input cast to T.
 */
export async function callAnthropicTool<T>(
  model: string,
  system: string,
  user: string,
  toolSchema: AnthropicToolSchema,
): Promise<T> {
  const cfg = requireConfig();
  const client = new Anthropic({ apiKey: cfg.anthropicApiKey ?? cfg.llmApiKey ?? '' });
  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    system,
    messages: [{ role: 'user', content: user }],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tools: [toolSchema as any],
    tool_choice: { type: 'tool', name: toolSchema.name },
  });
  for (const block of response.content) {
    if (block.type === 'tool_use' && block.name === toolSchema.name) {
      return block.input as T;
    }
  }
  throw new Error(`Anthropic tool-use returned no ${toolSchema.name} block`);
}
