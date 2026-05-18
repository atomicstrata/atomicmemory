/**
 * Cross-encoder reranker using a configurable Transformers.js sequence classifier.
 *
 * Scores (query, document) pairs jointly for more accurate relevance ranking
 * than bi-encoder cosine similarity alone. Runs on CPU via ONNX Runtime.
 *
 * Enable via CROSS_ENCODER_ENABLED=true and choose the model with
 * CROSS_ENCODER_MODEL.
 */

import type { SearchResult } from '../db/memory-repository.js';
import { config, type CrossEncoderDtype } from '../config.js';

let tokenizer: Awaited<ReturnType<typeof loadTokenizer>> | null = null;
let model: Awaited<ReturnType<typeof loadModel>> | null = null;
let loadedModelKey: string | null = null;
let loadPromise: Promise<void> | null = null;
/** Serialize ONNX inference to prevent mutex corruption (see onnx-stability-issue.md). */
let inferenceQueue: Promise<void> = Promise.resolve();

export interface RerankerRuntimeConfig {
  crossEncoderModel: string;
  crossEncoderDtype: CrossEncoderDtype;
}

async function loadTokenizer(modelId: string) {
  const { AutoTokenizer } = await import('@huggingface/transformers');
  return AutoTokenizer.from_pretrained(modelId);
}

async function loadModel(modelId: string, runtimeConfig: RerankerRuntimeConfig) {
  const { AutoModelForSequenceClassification } = await import('@huggingface/transformers');
  return AutoModelForSequenceClassification.from_pretrained(modelId, {
    dtype: runtimeConfig.crossEncoderDtype,
  });
}

function buildRerankerConfigKey(runtimeConfig: RerankerRuntimeConfig): string {
  return `${runtimeConfig.crossEncoderModel}:${runtimeConfig.crossEncoderDtype}`;
}

async function ensureLoaded(runtimeConfig: RerankerRuntimeConfig = config): Promise<void> {
  const modelId = runtimeConfig.crossEncoderModel;
  const modelKey = buildRerankerConfigKey(runtimeConfig);
  if (tokenizer && model && loadedModelKey === modelKey) return;
  if (loadPromise) { await loadPromise; return; }
  loadPromise = (async () => {
    console.log(`[reranker] Loading ${modelId} (${runtimeConfig.crossEncoderDtype})...`);
    const start = Date.now();
    [tokenizer, model] = await Promise.all([loadTokenizer(modelId), loadModel(modelId, runtimeConfig)]);
    loadedModelKey = modelKey;
    console.log(`[reranker] Loaded ${modelId} (${runtimeConfig.crossEncoderDtype}) in ${Date.now() - start}ms`);
  })();
  try {
    await loadPromise;
  } finally {
    loadPromise = null;
  }
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/**
 * Rerank candidates using cross-encoder scoring.
 * Replaces .score on each SearchResult; preserves .similarity for MMR.
 */
export async function rerankCandidates(
  query: string,
  candidates: SearchResult[],
  runtimeConfig: RerankerRuntimeConfig = config,
): Promise<SearchResult[]> {
  if (candidates.length === 0) return candidates;

  await ensureLoaded(runtimeConfig);
  const start = Date.now();

  const queries = candidates.map(() => query);
  const documents = candidates.map((c) => c.content);

  const inputs = tokenizer!(queries, {
    text_pair: documents,
    padding: true,
    truncation: true,
  });

  const scores = await new Promise<number[]>((resolve, reject) => {
    inferenceQueue = inferenceQueue.then(async () => {
      try {
        const output = await model!(inputs);
        const logits = Array.from(output.logits.data as Float32Array);
        resolve(logits.map(sigmoid));
      } catch (err) {
        reject(err);
      }
    });
  });

  // Blend cross-encoder relevance with original temporal-aware score.
  // The cross-encoder scores pure textual relevance (0-1) but has no temporal
  // signal. Without blending, a semantically-closer old fact will always outrank
  // a newer superseding fact. We normalize both signals to [0,1] and combine:
  //   blended = crossEncoderWeight * ceScore + (1 - crossEncoderWeight) * normalizedOriginal
  const crossEncoderWeight = 0.7;
  const maxOriginal = Math.max(...candidates.map((c) => c.score), 1e-9);
  const reranked = candidates.map((candidate, i) => ({
    ...candidate,
    score: crossEncoderWeight * scores[i] + (1 - crossEncoderWeight) * (candidate.score / maxOriginal),
  }));

  reranked.sort((a, b) => b.score - a.score);

  const ms = Date.now() - start;
  console.log(
    `[reranker] Scored ${candidates.length} candidates with ${runtimeConfig.crossEncoderModel} (${runtimeConfig.crossEncoderDtype}) in ${ms}ms (top: ${reranked[0]?.score.toFixed(3)})`,
  );

  return reranked;
}
