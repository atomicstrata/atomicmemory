/**
 * @file Embedding Generator
 *
 * High-level abstraction for generating vector embeddings with multiple backend support,
 * caching, retry logic, and performance monitoring. Provides a unified interface over
 * different embedding providers (Transformers.js, OpenAI, etc.).
 */

import { withRetry } from '../core/error-handling/retry';
import { EmbeddingError } from '../core/error-handling';
import { EventEmitter } from '../core/events';

// Common interface for embedding adapters
interface EmbeddingAdapter {
  generateEmbedding(text: string): Promise<EmbeddingResult>;
  generateBatchEmbeddings?(texts: string[]): Promise<EmbeddingResult[]>;
  preloadModel?(modelName?: string): Promise<void>;
  getModelInfo?(modelName?: string): {
    dimensions: number;
    maxLength?: number;
    isLoaded: boolean;
    model?: string;
    version?: string;
  };
  dispose?(): Promise<void>;
}

export interface EmbeddingResult {
  embedding: number[];
  dimensions: number;
  model: string;
  processingTime: number;
  version?: string; // API version tracking
  provider?: string; // Provider information
  metadata?: {
    // Extensible metadata
    cacheHit?: boolean;
    batchIndex?: number;
    [key: string]: any;
  };
  [key: string]: any; // Extensible for future properties
}

type EmbeddingsFactory = () => Promise<EmbeddingGenerator>;

interface EmbeddingConfig {
  model: string;
  dimensions: number;
  provider: 'transformers' | 'openai' | 'custom' | string; // Extensible providers
  maxRetries?: number;
  cacheResults?: boolean;
  batchSize?: number;
  maxLength?: number;
  device?: 'cpu' | 'gpu' | string; // Extensible devices
  quantized?: boolean;
  dtype?:
    | 'auto'
    | 'fp32'
    | 'fp16'
    | 'q8'
    | 'int8'
    | 'uint8'
    | 'q4'
    | 'bnb4'
    | 'q4f16'
    | string; // Data type for model precision
  version?: string; // Config version tracking
  [key: string]: any; // Extensible for future config options
}

interface CachedEmbedding {
  result: EmbeddingResult;
  timestamp: number;
  accessCount: number;
}

export class EmbeddingGenerator {
  private adapter: EmbeddingAdapter | null;
  private adapterPromise: Promise<EmbeddingAdapter> | null = null;
  private cache = new Map<string, CachedEmbedding>();
  private config: Required<EmbeddingConfig>;
  private eventEmitter?: EventEmitter;
  private stats = {
    totalRequests: 0,
    cacheHits: 0,
    totalProcessingTime: 0,
    averageProcessingTime: 0,
  };

  constructor(
    config: Partial<EmbeddingConfig>,
    eventEmitter?: EventEmitter,
    adapterOverride?: EmbeddingAdapter
  ) {
    // Default configuration for forward compatibility
    const defaultConfig: Required<EmbeddingConfig> = {
      model: 'Xenova/all-MiniLM-L6-v2',
      dimensions: 384,
      provider: 'transformers',
      maxRetries: 3,
      cacheResults: true,
      batchSize: 32,
      maxLength: 512,
      device: 'cpu',
      quantized: false, // Disable quantization - we only have non-quantized models
      dtype: 'q8', // Match our bundled quantized models to avoid ONNX warnings
      version: '1.0',
    };

    this.config = {
      ...defaultConfig,
      ...config,
      // Merge any additional configuration options
      ...Object.fromEntries(
        Object.entries(config).filter(
          ([key]) => !Object.keys(defaultConfig).includes(key)
        )
      ),
    } as Required<EmbeddingConfig>;

    this.eventEmitter = eventEmitter;

    // Initialize adapter lazily; allow explicit override for tests
    this.adapter = adapterOverride || null;

    if (!adapterOverride && this.config.provider !== 'transformers') {
      throw new EmbeddingError(
        `Unsupported provider: ${this.config.provider}`,
        'UNSUPPORTED_PROVIDER',
        { provider: this.config.provider },
        false
      );
    }
  }

  private async createAdapter(): Promise<EmbeddingAdapter> {
    switch (this.config.provider) {
      case 'transformers': {
        const { TransformersAdapter } = await import('./transformers-adapter');
        return new TransformersAdapter({
          model: this.config.model,
          dimensions: this.config.dimensions,
          maxLength: this.config.maxLength,
          device:
            this.config.device === 'cpu' || this.config.device === 'gpu'
              ? this.config.device
              : 'cpu',
          quantized: this.config.quantized,
          dtype: this.config.dtype,
        });
      }
      default:
        throw new EmbeddingError(
          `Unsupported provider: ${this.config.provider}`,
          'UNSUPPORTED_PROVIDER',
          { provider: this.config.provider },
          false
        );
    }
  }

  private async getAdapter(): Promise<EmbeddingAdapter> {
    if (this.adapter) {
      return this.adapter;
    }

    if (!this.adapterPromise) {
      this.adapterPromise = this.createAdapter()
        .then(adapter => {
          this.adapter = adapter;
          this.adapterPromise = null;
          return adapter;
        })
        .catch(error => {
          this.adapterPromise = null;
          throw error;
        });
    }

    return this.adapterPromise;
  }

  async generateEmbedding(text: string): Promise<EmbeddingResult> {
    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      throw new EmbeddingError('Invalid text input', 'INVALID_INPUT');
    }

    this.stats.totalRequests++;

    // Check cache first
    if (this.config.cacheResults) {
      const cached = this.getCachedEmbedding(text);
      if (cached) {
        this.stats.cacheHits++;
        this.emitEvent('embeddingCacheHit', {
          text: text.substring(0, 100),
          model: this.config.model,
        });
        return cached.result;
      }
    }

    const adapter = await this.getAdapter();

    // Generate embedding with retry logic
    const result = await withRetry(() => adapter.generateEmbedding(text), {
      maxAttempts: this.config.maxRetries,
      shouldRetry: (_error: Error, attempt: number) => {
        // Only retry on specific errors, not validation errors
        return attempt < this.config.maxRetries;
      },
    });

    // Enhance result with forward-compatible metadata
    const enhancedResult: EmbeddingResult = {
      ...result,
      version: this.config.version || '1.0',
      provider: this.config.provider,
      metadata: {
        cacheHit: false,
        ...result.metadata,
      },
    };

    // Update statistics
    this.updateStats(enhancedResult.processingTime);

    // Cache result
    if (this.config.cacheResults) {
      this.setCachedEmbedding(text, enhancedResult);
    }

    // Emit event
    this.emitEvent('embeddingGenerated', {
      textLength: text.length,
      dimensions: enhancedResult.dimensions,
      model: enhancedResult.model,
      processingTime: enhancedResult.processingTime,
      cached: false,
      version: enhancedResult.version,
    });

    return enhancedResult;
  }

  async generateBatchEmbeddings(texts: string[]): Promise<EmbeddingResult[]> {
    if (!Array.isArray(texts) || texts.length === 0) {
      throw new EmbeddingError('Invalid texts input', 'INVALID_INPUT');
    }

    const results: EmbeddingResult[] = [];
    const uncachedTexts: string[] = [];
    const uncachedIndices: number[] = [];

    // Check cache for each text
    if (this.config.cacheResults) {
      for (let i = 0; i < texts.length; i++) {
        const cached = this.getCachedEmbedding(texts[i]);
        if (cached) {
          results[i] = cached.result;
          this.stats.cacheHits++;
        } else {
          uncachedTexts.push(texts[i]);
          uncachedIndices.push(i);
        }
      }
    } else {
      uncachedTexts.push(...texts);
      uncachedIndices.push(...texts.map((_, i) => i));
    }

    // Process uncached texts in batches
    if (uncachedTexts.length > 0) {
      const batchResults = await this.processBatches(uncachedTexts);

      // Place results in correct positions
      for (let i = 0; i < batchResults.length; i++) {
        const resultIndex = uncachedIndices[i];
        results[resultIndex] = batchResults[i];

        // Cache individual results
        if (this.config.cacheResults) {
          this.setCachedEmbedding(uncachedTexts[i], batchResults[i]);
        }
      }
    }

    this.stats.totalRequests += texts.length;

    // Emit batch event
    this.emitEvent('batchEmbeddingGenerated', {
      batchSize: texts.length,
      cacheHits: texts.length - uncachedTexts.length,
      totalProcessingTime: results.reduce(
        (sum, r) => sum + r.processingTime,
        0
      ),
    });

    return results;
  }

  async preloadModel(): Promise<void> {
    try {
      const adapter = await this.getAdapter();
      if (adapter.preloadModel) {
        await adapter.preloadModel();
        this.emitEvent('modelPreloaded', { model: this.config.model });
      }
    } catch (error) {
      throw new EmbeddingError(
        `Failed to preload model: ${error instanceof Error ? error.message : String(error)}`,
        'PRELOAD_FAILED',
        { model: this.config.model, originalError: error },
        false
      );
    }
  }

  getModelInfo(): { dimensions: number; maxLength: number; isLoaded: boolean } {
    const adapter = this.adapter;

    if (adapter?.getModelInfo) {
      const info = adapter.getModelInfo();
      return {
        dimensions: info.dimensions,
        maxLength: info.maxLength || this.config.maxLength,
        isLoaded: info.isLoaded,
      };
    }

    // Fallback for adapters without getModelInfo
    return {
      dimensions: this.config.dimensions,
      maxLength: this.config.maxLength,
      isLoaded: false,
    };
  }

  getStats() {
    return {
      ...this.stats,
      cacheSize: this.cache.size,
      cacheHitRate:
        this.stats.totalRequests > 0
          ? this.stats.cacheHits / this.stats.totalRequests
          : 0,
    };
  }

  clearCache(): void {
    this.cache.clear();
    this.emitEvent('cacheCleared', { previousSize: this.cache.size });
  }

  async dispose(): Promise<void> {
    if (this.adapter?.dispose) {
      await this.adapter.dispose();
    }
    this.cache.clear();
    this.adapter = null;
    this.adapterPromise = null;
  }

  private async processBatches(texts: string[]): Promise<EmbeddingResult[]> {
    const results: EmbeddingResult[] = [];
    const adapter = await this.getAdapter();

    for (let i = 0; i < texts.length; i += this.config.batchSize) {
      const batch = texts.slice(i, i + this.config.batchSize);

      const batchResults = await withRetry(
        () => {
          if (adapter.generateBatchEmbeddings) {
            return adapter.generateBatchEmbeddings(batch);
          } else {
            // Fallback to individual embeddings
            return Promise.all(
              batch.map(text => adapter.generateEmbedding(text))
            );
          }
        },
        { maxAttempts: this.config.maxRetries }
      );

      // Enhance batch results with forward-compatible metadata
      const enhancedBatchResults = batchResults.map((result, index) => ({
        ...result,
        version: this.config.version || '1.0',
        provider: this.config.provider,
        metadata: {
          cacheHit: false,
          batchIndex: i + index,
          ...result.metadata,
        },
      }));

      results.push(...enhancedBatchResults);

      // Update stats for each result
      enhancedBatchResults.forEach(result =>
        this.updateStats(result.processingTime)
      );
    }

    return results;
  }

  private getCachedEmbedding(text: string): CachedEmbedding | null {
    const key = this.getCacheKey(text);
    const cached = this.cache.get(key);

    if (cached) {
      cached.accessCount++;
      return cached;
    }

    return null;
  }

  private setCachedEmbedding(text: string, result: EmbeddingResult): void {
    const key = this.getCacheKey(text);
    this.cache.set(key, {
      result,
      timestamp: Date.now(),
      accessCount: 1,
    });

    // Simple cache size management
    if (this.cache.size > 1000) {
      this.evictOldestCacheEntries();
    }
  }

  private getCacheKey(text: string): string {
    // Simple hash function for cache key
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return `${this.config.model}:${hash}`;
  }

  private evictOldestCacheEntries(): void {
    const entries = Array.from(this.cache.entries());
    entries.sort((a, b) => a[1].timestamp - b[1].timestamp);

    // Remove oldest 20% of entries
    const toRemove = Math.floor(entries.length * 0.2);
    for (let i = 0; i < toRemove; i++) {
      this.cache.delete(entries[i][0]);
    }
  }

  private updateStats(processingTime: number): void {
    this.stats.totalProcessingTime += processingTime;
    this.stats.averageProcessingTime =
      this.stats.totalProcessingTime / this.stats.totalRequests;
  }

  private emitEvent(eventType: string, data: any): void {
    if (this.eventEmitter) {
      this.eventEmitter.emit('embeddingEvent' as any, {
        type: eventType,
        data,
        timestamp: Date.now(),
      });
    }
  }
}
