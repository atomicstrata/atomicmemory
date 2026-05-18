/**
 * Voyage AI embedding provider for isolated benchmark lanes.
 *
 * Voyage 4 models share an embedding space across the family, allowing
 * document and query embeddings to use different compatible models while
 * remaining searchable in the same pgvector index.
 */

import {
  estimateCostUsd,
  summarizeUsage,
  writeCostEvent,
} from './cost-telemetry.js';
import type {
  EmbeddingConfig,
  EmbeddingProvider,
  EmbeddingTask,
} from './embedding.js';

export const VOYAGE_API_BASE = 'https://api.voyageai.com';

interface VoyageEmbeddingResponse {
  data: Array<{ embedding: number[]; index: number }>;
  usage?: { total_tokens?: number };
}

export class VoyageEmbedding implements EmbeddingProvider {
  constructor(
    private readonly config: EmbeddingConfig,
    private readonly apiKey: string,
    private readonly documentModel: string,
    private readonly queryModel: string,
    private readonly dimensions: number,
  ) {}

  async embed(text: string, task: EmbeddingTask): Promise<number[]> {
    const response = await this.requestAndTrack(text, task);
    return response.data[0].embedding;
  }

  async embedBatch(texts: string[], task: EmbeddingTask): Promise<number[][]> {
    if (texts.length === 0) return [];
    const response = await this.requestAndTrack(texts, task);
    return response.data
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding);
  }

  private modelFor(task: EmbeddingTask): string {
    return task === 'query' ? this.queryModel : this.documentModel;
  }

  private async requestAndTrack(
    input: string | string[],
    task: EmbeddingTask,
  ): Promise<VoyageEmbeddingResponse> {
    const model = this.modelFor(task);
    const started = performance.now();
    const response = await fetch(`${VOYAGE_API_BASE}/v1/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        input,
        model,
        input_type: task,
        output_dimension: this.dimensions,
      }),
      signal: AbortSignal.timeout(300_000),
    });

    if (!response.ok) {
      throw new Error(`Voyage embed failed (${response.status}): ${await response.text()}`);
    }

    const body = await response.json() as VoyageEmbeddingResponse;
    this.writeUsage(model, body.usage?.total_tokens ?? null, started);
    return body;
  }

  private writeUsage(model: string, totalTokens: number | null, started: number): void {
    const usage = summarizeUsage(totalTokens, null, totalTokens);
    writeCostEvent({
      stage: 'embedding',
      provider: this.config.embeddingProvider,
      model,
      requestKind: 'embedding',
      durationMs: performance.now() - started,
      cacheHit: false,
      inputTokens: usage.inputTokens ?? null,
      outputTokens: usage.outputTokens ?? null,
      totalTokens: usage.totalTokens ?? null,
      estimatedCostUsd: estimateCostUsd(this.config.embeddingProvider, model, usage),
    }, this.config);
  }
}
