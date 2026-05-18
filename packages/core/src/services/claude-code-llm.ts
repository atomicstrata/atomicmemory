/**
 * Claude Code Agent SDK-backed LLM provider.
 *
 * This provider is intended for local developer setups where the `claude`
 * CLI is already authenticated. It disables tools, MCP servers, settings,
 * project context, and session persistence so extraction stays close to a
 * one-turn chat completion instead of becoming an agent run.
 */

import { query, type Options, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ChatMessage, ChatOptions, LLMProvider } from './llm.js';
import {
  estimateCostUsd,
  getCostStage,
  summarizeUsage,
  writeCostEvent,
  type WriteCostEventConfig,
} from './cost-telemetry.js';

export interface ClaudeCodeLLMConfig extends WriteCostEventConfig {
  llmProvider: 'claude-code';
  llmModel: string;
}

export class ClaudeCodeLLM implements LLMProvider {
  constructor(private readonly config: ClaudeCodeLLMConfig) {}

  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
    const started = performance.now();
    const result = await runClaudeCodeQuery(
      buildPrompt(messages),
      buildClaudeCodeOptions(messages, this.config.llmModel, options),
    );

    if (result.subtype !== 'success') {
      throw new Error(`Claude Code LLM failed: ${result.errors.join('; ')}`);
    }

    recordClaudeCodeCost(this.config, result, started);
    return result.result.trim();
  }
}

function buildPrompt(messages: ChatMessage[]): string {
  return messages
    .filter((message) => message.role !== 'system')
    .map((message) => `${message.role.toUpperCase()}:\n${message.content}`)
    .join('\n\n')
    .trim();
}

function buildClaudeCodeOptions(
  messages: ChatMessage[],
  model: string,
  options: ChatOptions,
): Options {
  const systemPrompt = buildSystemPrompt(messages, options);
  return {
    ...(model ? { model } : {}),
    ...(systemPrompt ? { systemPrompt } : {}),
    tools: [],
    mcpServers: {},
    settingSources: [],
    persistSession: false,
    permissionMode: 'dontAsk',
    maxTurns: 1,
  };
}

function buildSystemPrompt(messages: ChatMessage[], options: ChatOptions): string {
  const system = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n')
    .trim();
  if (!options.jsonMode) return system;
  return [system, 'Return only valid JSON. Do not include markdown fences or commentary.']
    .filter(Boolean)
    .join('\n\n');
}

async function runClaudeCodeQuery(prompt: string, options: Options): Promise<SDKResultMessage> {
  let result: SDKResultMessage | null = null;
  try {
    for await (const message of query({ prompt, options })) {
      if (message.type === 'result') result = message;
    }
  } catch (error) {
    throw new Error(
      'Claude Code LLM failed to run. Confirm `claude` is installed and authenticated: ' +
      errorMessage(error),
    );
  }
  if (!result) throw new Error('Claude Code LLM ended without a result message');
  return result;
}

function recordClaudeCodeCost(
  config: ClaudeCodeLLMConfig,
  result: Extract<SDKResultMessage, { subtype: 'success' }>,
  started: number,
): void {
  const usage = summarizeUsage(
    sumModelUsage(result.modelUsage, 'inputTokens'),
    sumModelUsage(result.modelUsage, 'outputTokens'),
    null,
  );
  const model = config.llmModel || Object.keys(result.modelUsage)[0] || 'claude-code';
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
    estimatedCostUsd: result.total_cost_usd ?? estimateCostUsd(config.llmProvider, model, usage),
  }, config);
}

function sumModelUsage(
  usage: Extract<SDKResultMessage, { subtype: 'success' }>['modelUsage'],
  field: 'inputTokens' | 'outputTokens',
): number | null {
  const total = Object.values(usage).reduce((sum, item) => sum + (item[field] ?? 0), 0);
  return total > 0 ? total : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
