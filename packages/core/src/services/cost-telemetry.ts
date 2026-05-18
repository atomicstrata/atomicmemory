/**
 * Lightweight per-call cost telemetry.
 * Writes JSONL events for LLM and embedding calls when enabled.
 */

import { mkdirSync, appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export type CostStage = 'extract' | 'answer' | 'judge' | 'embedding' | 'other';

export interface CostUsage {
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
}

export interface CostEvent {
  ts: string;
  runId: string;
  stage: CostStage;
  provider: string;
  model: string;
  requestKind: 'chat' | 'embedding';
  durationMs: number;
  cacheHit: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  estimatedCostUsd: number | null;
  meta?: Record<string, unknown>;
}

let currentStage: CostStage = 'other';

const PRICE_PER_MILLION: Record<string, { input: number; output: number }> = {
  'openai:gpt-4.1-mini': { input: 0.4, output: 1.6 },
};

function setCostStage(stage: CostStage): void {
  currentStage = stage;
}

export function getCostStage(): CostStage {
  return currentStage;
}

export async function withCostStage<T>(stage: CostStage, fn: () => Promise<T>): Promise<T> {
  const prev = currentStage;
  currentStage = stage;
  try {
    return await fn();
  } finally {
    currentStage = prev;
  }
}

export function estimateCostUsd(provider: string, model: string, usage?: CostUsage): number | null {
  if (!usage) return null;
  const price = PRICE_PER_MILLION[`${provider}:${model}`];
  if (!price) return null;
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  return (input / 1_000_000) * price.input + (output / 1_000_000) * price.output;
}

/**
 * Config subset consumed by writeCostEvent. Narrow Pick<> of the supported
 * operator-config surface so callers only thread what the function reads.
 */
export interface WriteCostEventConfig {
  costLoggingEnabled: boolean;
  costRunId: string;
  costLogDir: string;
}

export function writeCostEvent(
  event: Omit<CostEvent, 'ts' | 'runId'>,
  config: WriteCostEventConfig,
): void {
  if (!config.costLoggingEnabled) return;
  const runId = config.costRunId || `adhoc-${new Date().toISOString().slice(0, 10)}`;
  const logPath = resolve(config.costLogDir, `${runId}.jsonl`);
  mkdirSync(dirname(logPath), { recursive: true });
  const fullEvent: CostEvent = {
    ts: new Date().toISOString(),
    runId,
    ...event,
  };
  appendFileSync(logPath, JSON.stringify(fullEvent) + '\n', 'utf-8');
}

export function summarizeUsage(inputTokens?: number | null, outputTokens?: number | null, totalTokens?: number | null): CostUsage {
  return {
    inputTokens: inputTokens ?? null,
    outputTokens: outputTokens ?? null,
    totalTokens: totalTokens ?? ((inputTokens ?? null) !== null || (outputTokens ?? null) !== null
      ? (inputTokens ?? 0) + (outputTokens ?? 0)
      : null),
  };
}
