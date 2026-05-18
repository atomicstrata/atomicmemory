/**
 * Embedding provider abstraction.
 * Supports OpenAI, Ollama, OpenAI-compatible APIs, Voyage AI, and local
 * WASM (via @huggingface/transformers with ONNX Runtime). Provider/model
 * selection comes from the RuntimeConfig bound by createCoreRuntime().
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import OpenAI from 'openai';
import { retryOnRateLimit } from './api-retry.js';
import {
  estimateCostUsd,
  summarizeUsage,
  writeCostEvent,
  type CostUsage,
  type WriteCostEventConfig,
} from './cost-telemetry.js';
import type {
  EmbeddingProviderName,
} from '../config.js';
import { VOYAGE_API_BASE, VoyageEmbedding } from './voyage-embedding.js';

/**
 * Config subset consumed by the embedding module. After Phase 7 Step 3c,
 * provider/model selection is startup-only, so it's safe for embedding to
 * hold this as module-level state and rebind only on explicit reinit.
 *
 * Includes WriteCostEventConfig so cost-telemetry calls can be threaded
 * through without a second init.
 */
export interface EmbeddingConfig extends WriteCostEventConfig {
  embeddingProvider: EmbeddingProviderName;
  embeddingModel: string;
  embeddingDimensions: number;
  embeddingApiUrl?: string;
  embeddingApiKey?: string;
  voyageApiKey?: string;
  voyageDocumentModel: string;
  voyageQueryModel: string;
  openaiApiKey: string;
  ollamaBaseUrl: string;
  embeddingCacheEnabled: boolean;
  extractionCacheDir: string;
}

let embeddingConfig: EmbeddingConfig | null = null;

/**
 * Bind the embedding module's config. Called once by the composition
 * root (`createCoreRuntime`). Calling again rebinds and invalidates the
 * stateful provider cache — primarily for tests that need to swap
 * providers within a process.
 */
export function initEmbedding(config: EmbeddingConfig): void {
  embeddingConfig = config;
  provider = null;
  providerKey = '';
  embeddingCache.clear();
}

function requireConfig(): EmbeddingConfig {
  if (!embeddingConfig) {
    throw new Error(
      'embedding.ts: initEmbedding(config) must be called at composition-root time before embedText/embedTexts. See runtime-container.ts.',
    );
  }
  return embeddingConfig;
}

function writeEmbeddingUsageEvent(
  config: EmbeddingConfig,
  model: string,
  usage: CostUsage,
  started: number,
): void {
  writeCostEvent({
    stage: 'embedding',
    provider: config.embeddingProvider,
    model,
    requestKind: 'embedding',
    durationMs: performance.now() - started,
    cacheHit: false,
    inputTokens: usage.inputTokens ?? null,
    outputTokens: usage.outputTokens ?? null,
    totalTokens: usage.totalTokens ?? null,
    estimatedCostUsd: estimateCostUsd(config.embeddingProvider, model, usage),
  }, config);
}

export type EmbeddingTask = 'query' | 'document';

export interface EmbeddingProvider {
  embed(text: string, task: EmbeddingTask): Promise<number[]>;
  embedBatch(texts: string[], task: EmbeddingTask): Promise<number[][]>;
}

/** OpenAI and any OpenAI-compatible embedding API. */
class OpenAICompatibleEmbedding implements EmbeddingProvider {
  private client: OpenAI;
  private model: string;
  private dimensions: number | undefined;

  constructor(apiKey: string, model: string, baseURL?: string, dimensions?: number) {
    this.client = new OpenAI({ apiKey, baseURL });
    this.model = model;
    this.dimensions = dimensions;
  }

  async embed(text: string, _task: EmbeddingTask): Promise<number[]> {
    const response = await this.requestAndTrack(text);
    return response.data[0].embedding;
  }

  async embedBatch(texts: string[], _task: EmbeddingTask): Promise<number[][]> {
    if (texts.length === 0) return [];
    const response = await this.requestAndTrack(texts);
    return response.data
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding);
  }

  private embeddingRequest(input: string | string[]) {
    const request: { model: string; input: string | string[]; dimensions?: number } = {
      model: this.model,
      input,
    };
    if (this.dimensions !== undefined) request.dimensions = this.dimensions;
    return request;
  }

  private usageFromResponse(response: { usage?: { prompt_tokens?: number; total_tokens?: number } }): CostUsage {
    const totalTokens = response.usage?.total_tokens ?? null;
    const promptTokens = response.usage?.prompt_tokens ?? null;
    const inputTokens = promptTokens === null ? totalTokens : promptTokens;
    return summarizeUsage(inputTokens, null, totalTokens);
  }

  private async requestAndTrack(input: string | string[]) {
    const config = requireConfig();
    const request = () => this.client.embeddings.create(this.embeddingRequest(input));
    const started = performance.now();
    const response = await retryOnRateLimit(request);
    writeEmbeddingUsageEvent(config, this.model, this.usageFromResponse(response), started);
    return response;
  }
}

/** Ollama embedding via native HTTP API. */
class OllamaEmbedding implements EmbeddingProvider {
  private baseUrl: string;
  private model: string;

  constructor(model: string, baseUrl: string = 'http://localhost:11434') {
    this.baseUrl = baseUrl;
    this.model = model;
  }

  async embed(text: string, _task: EmbeddingTask): Promise<number[]> {
    const data = await this.ollamaFetch(text, 'Ollama embed failed');
    return data.embeddings[0];
  }

  async embedBatch(texts: string[], _task: EmbeddingTask): Promise<number[][]> {
    if (texts.length === 0) return [];
    const data = await this.ollamaFetch(texts, 'Ollama embed batch failed');
    return data.embeddings;
  }

  private async ollamaFetch(input: string | string[], errorLabel: string): Promise<{ embeddings: number[][] }> {
    const config = requireConfig();
    const started = performance.now();
    const response = await fetch(`${this.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, input }),
      signal: AbortSignal.timeout(300_000),
    });

    if (!response.ok) {
      throw new Error(`${errorLabel} (${response.status}): ${await response.text()}`);
    }

    const data = await response.json() as { embeddings: number[][]; prompt_eval_count?: number; eval_count?: number };
    const usage = summarizeUsage(data.prompt_eval_count ?? null, data.eval_count ?? null, null);
    writeEmbeddingUsageEvent(config, this.model, usage, started);
    return data;
  }
}

/**
 * Local WASM embedding via @huggingface/transformers (ONNX Runtime).
 * Eliminates network latency — target sub-15ms per embed at fp32.
 * Pipeline is lazily initialized on first use (downloads model on first run).
 */
/**
 * Local ONNX embedding with serialized inference.
 * ONNX Runtime's C++ mutex corrupts under concurrent async calls, causing
 * `mutex lock failed: Invalid argument` crashes in long-running processes.
 * All inference is serialized through a promise queue to prevent this.
 */
class TransformersEmbedding implements EmbeddingProvider {
  private model: string;
  private pipelinePromise: Promise<TransformersPipeline> | null = null;
  private inferenceQueue: Promise<void> = Promise.resolve();

  constructor(model: string) {
    this.model = model;
  }

  private getPipeline(): Promise<TransformersPipeline> {
    if (!this.pipelinePromise) {
      this.pipelinePromise = initTransformersPipeline(this.model);
    }
    return this.pipelinePromise;
  }

  private serialized<T>(fn: (extractor: TransformersPipeline) => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.inferenceQueue = this.inferenceQueue.then(async () => {
        try {
          const extractor = await this.getPipeline();
          resolve(await fn(extractor));
        } catch (err) {
          reject(err);
        }
      });
    });
  }

  async embed(text: string, _task: EmbeddingTask): Promise<number[]> {
    return this.serialized(async (extractor) => {
      const output = await extractor(text, { pooling: 'mean', normalize: true });
      return Array.from(output.data as Float32Array);
    });
  }

  async embedBatch(texts: string[], _task: EmbeddingTask): Promise<number[][]> {
    if (texts.length === 0) return [];
    return this.serialized(async (extractor) => {
      const output = await extractor(texts, { pooling: 'mean', normalize: true });
      const dims = output.dims;
      const embeddingSize = dims[dims.length - 1];
      const data = output.data as Float32Array;
      const results: number[][] = [];
      for (let i = 0; i < texts.length; i++) {
        results.push(Array.from(data.slice(i * embeddingSize, (i + 1) * embeddingSize)));
      }
      return results;
    });
  }
}

/** Dynamically import transformers.js and create the pipeline. */
type TransformersPipeline = (texts: string | string[], options: Record<string, unknown>) => Promise<{ data: Float32Array; dims: number[] }>;

async function initTransformersPipeline(model: string): Promise<TransformersPipeline> {
  const { pipeline } = await import('@huggingface/transformers');
  console.log(`[embedding] Loading local WASM model: ${model}`);
  const start = performance.now();
  const extractor = await pipeline('feature-extraction', model, { dtype: 'fp32' });
  console.log(`[embedding] Model loaded in ${(performance.now() - start).toFixed(0)}ms`);
  return extractor as unknown as TransformersPipeline;
}

/** Create embedding provider from config. */
function createEmbeddingProvider(): EmbeddingProvider {
  const config = requireConfig();
  switch (config.embeddingProvider) {
    case 'openai':
      return new OpenAICompatibleEmbedding(
        config.openaiApiKey, config.embeddingModel, undefined, config.embeddingDimensions,
      );
    case 'ollama':
      return new OllamaEmbedding(config.embeddingModel, config.ollamaBaseUrl);
    case 'openai-compatible':
      return new OpenAICompatibleEmbedding(
        config.embeddingApiKey ?? config.openaiApiKey,
        config.embeddingModel,
        config.embeddingApiUrl,
        config.embeddingDimensions,
      );
    case 'transformers':
      return new TransformersEmbedding(config.embeddingModel);
    case 'voyage':
      if (!config.voyageApiKey) {
        throw new Error('VOYAGE_API_KEY is required when EMBEDDING_PROVIDER=voyage');
      }
      return new VoyageEmbedding(
        config,
        config.voyageApiKey,
        config.voyageDocumentModel,
        config.voyageQueryModel,
        config.embeddingDimensions,
      );
    default:
      throw new Error(`Unknown embedding provider: ${config.embeddingProvider}`);
  }
}

let provider: EmbeddingProvider | null = null;
let providerKey = '';

function effectiveModel(task: EmbeddingTask): string {
  const config = requireConfig();
  if (config.embeddingProvider === 'voyage') {
    return task === 'query' ? config.voyageQueryModel : config.voyageDocumentModel;
  }
  return config.embeddingModel;
}

function endpointMarker(): string {
  const config = requireConfig();
  switch (config.embeddingProvider) {
    case 'openai':
      return 'openai:api.openai.com';
    case 'openai-compatible':
      return `compat:${config.embeddingApiUrl ?? ''}`;
    case 'ollama':
      return `ollama:${config.ollamaBaseUrl}`;
    case 'transformers':
      return 'transformers:local';
    case 'voyage':
      return `voyage:${VOYAGE_API_BASE}`;
  }
}

function getProviderKey(): string {
  const config = requireConfig();
  return [
    config.embeddingProvider,
    config.embeddingDimensions,
    endpointMarker(),
    config.embeddingModel,
    config.voyageDocumentModel,
    config.voyageQueryModel,
  ].join('|');
}

function getProvider(): EmbeddingProvider {
  const nextKey = getProviderKey();
  if (!provider || nextKey !== providerKey) {
    provider = createEmbeddingProvider();
    providerKey = nextKey;
    embeddingCache.clear();
  }
  return provider;
}

/**
 * Returns the instruction prefix required by certain embedding models.
 * snowflake-arctic-embed2 and mxbai-embed-large are sensitive to these.
 */
function getInstructionPrefix(model: string, task: EmbeddingTask): string {
  if (task === 'document') return '';

  if (model.includes('mxbai-embed-large')) {
    // 0.838 similarity with this prefix vs 0.831 without.
    return 'Represent this sentence for searching relevant passages: ';
  }

  if (model.includes('nomic-embed-text')) {
    return 'search_query: ';
  }

  // snowflake-arctic-embed2 (Ollama v0.5.x) diagnostic showed significant
  // regression with prefixes (0.80 -> 0.71). We use no prefix for this model.

  return '';
}

/**
 * LRU embedding cache — avoids redundant API calls for identical text within
 * and across requests. The key includes provider, endpoint, model, dimensions,
 * and task so query/document embeddings of the same text never collide.
 */
const EMBEDDING_CACHE_MAX = 512;
const embeddingCache = new Map<string, number[]>();

function embeddingCacheKey(text: string, task: EmbeddingTask): string {
  const config = requireConfig();
  const parts = [
    config.embeddingProvider,
    effectiveModel(task),
    String(config.embeddingDimensions),
    endpointMarker(),
    task,
    text,
  ].join('\0');
  return createHash('sha256').update(parts).digest('hex').slice(0, 16);
}

function getCachedEmbedding(key: string): number[] | undefined {
  const cached = embeddingCache.get(key);
  if (cached) {
    // Move to end (most recently used)
    embeddingCache.delete(key);
    embeddingCache.set(key, cached);
  }
  return cached;
}

function setCachedEmbedding(key: string, embedding: number[]): void {
  if (embeddingCache.size >= EMBEDDING_CACHE_MAX) {
    // Evict oldest (first entry)
    const oldest = embeddingCache.keys().next().value;
    if (oldest !== undefined) embeddingCache.delete(oldest);
  }
  embeddingCache.set(key, embedding);
}

/**
 * Disk-based embedding cache — persists embeddings across process restarts.
 * Eliminates API transport variance and saves API calls during eval runs.
 * Enabled via EMBEDDING_CACHE_ENABLED=true; reuses EXTRACTION_CACHE_DIR.
 */
function readDiskEmbedding(key: string): number[] | null {
  const config = requireConfig();
  if (!config.embeddingCacheEnabled) return null;
  const filePath = join(config.extractionCacheDir, `emb-${key}.json`);
  if (!existsSync(filePath)) return null;
  return JSON.parse(readFileSync(filePath, 'utf-8')) as number[];
}

function writeDiskEmbedding(key: string, embedding: number[]): void {
  const config = requireConfig();
  if (!config.embeddingCacheEnabled) return;
  mkdirSync(config.extractionCacheDir, { recursive: true });
  const filePath = join(config.extractionCacheDir, `emb-${key}.json`);
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(embedding), 'utf-8');
  renameSync(tmpPath, filePath);
}

/** Embed a single text — primary API used throughout the codebase. */
export async function embedText(text: string, task: EmbeddingTask = 'document'): Promise<number[]> {
  const prefix = getInstructionPrefix(effectiveModel(task), task);
  const finalInput = prefix + text;
  const key = embeddingCacheKey(finalInput, task);

  const cached = getCachedEmbedding(key);
  if (cached) return cached;

  // Check disk cache before hitting the API
  const diskCached = readDiskEmbedding(key);
  if (diskCached) {
    setCachedEmbedding(key, diskCached);
    return diskCached;
  }

  const embedding = await getProvider().embed(finalInput, task);
  setCachedEmbedding(key, embedding);
  writeDiskEmbedding(key, embedding);
  return embedding;
}

/** Embed multiple texts in one call, with per-text cache integration. */
export async function embedTexts(texts: string[], task: EmbeddingTask = 'document'): Promise<number[][]> {
  if (texts.length === 0) return [];

  const prefix = getInstructionPrefix(effectiveModel(task), task);
  const inputs = texts.map((t) => prefix + t);
  const keys = inputs.map((input) => embeddingCacheKey(input, task));

  const results: Array<number[] | null> = keys.map((key) => getCachedEmbedding(key) ?? null);
  const uncachedIndices = results.reduce<number[]>((acc, r, i) => {
    if (r === null) acc.push(i);
    return acc;
  }, []);

  if (uncachedIndices.length > 0) {
    const uncachedInputs = uncachedIndices.map((i) => inputs[i]);
    const freshEmbeddings = await getProvider().embedBatch(uncachedInputs, task);
    for (let j = 0; j < uncachedIndices.length; j++) {
      const idx = uncachedIndices[j];
      results[idx] = freshEmbeddings[j];
      setCachedEmbedding(keys[idx], freshEmbeddings[j]);
    }
  }

  return results as number[][];
}

/** Get current cache size (for testing/monitoring). */
export function getEmbeddingCacheSize(): number {
  return embeddingCache.size;
}

/** Clear the embedding cache (for testing). */
export function clearEmbeddingCache(): void {
  embeddingCache.clear();
}

export { cosineSimilarity } from '../vector-math.js';
