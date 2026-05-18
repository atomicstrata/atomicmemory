/**
 * @file WASM Semantic Processor (SDK Core Implementation)
 * Core WASM-enabled semantic processing engine for the AtomicMemory SDK
 * This is the main implementation that extension and other consumers utilize
 */

import { log } from '../utils/logger';
import {
  WasmFeatureFlagManager,
  createConservativeFeatureFlagManager,
} from './feature-flags';

interface WasmCapabilities {
  hasWebAssembly: boolean;
  canCompile: boolean;
  canInstantiate: boolean;
  supportsStreaming: boolean;
  platform: string;
  error?: string;
}

interface SemanticContext {
  id: string;
  content: string;
  embedding: number[];
  metadata?: any;
  timestamp: number;
}

interface SemanticSearchOptions {
  maxResults?: number;
  threshold?: number;
}

interface SemanticSearchResult {
  id: string;
  content: string;
  similarity: number;
  metadata?: any;
}

/**
 * Core WASM Semantic Processor
 * This is the main implementation that handles WASM-based semantic processing
 */
export class WasmSemanticProcessor {
  private pipeline: any = null;
  private contexts: SemanticContext[] = [];
  private isInitialized = false;
  private modelName = 'Xenova/all-MiniLM-L6-v2';
  private assetUrlResolver?: (path: string) => string;
  private featureFlagManager: WasmFeatureFlagManager;
  private storageBackend?: any; // Storage backend for persisting contexts

  constructor(
    options: {
      modelName?: string;
      assetUrlResolver?: (path: string) => string;
      featureFlagManager?: WasmFeatureFlagManager;
      storageBackend?: any; // Storage manager or adapter
    } = {}
  ) {
    this.modelName = options.modelName || this.modelName;
    this.assetUrlResolver = options.assetUrlResolver;
    this.featureFlagManager =
      options.featureFlagManager || createConservativeFeatureFlagManager();
    this.storageBackend = options.storageBackend;
  }

  /**
   * Initialize the WASM semantic processor
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    // Check if WASM processing is enabled
    if (!this.featureFlagManager.isEnabled('wasmProcessing')) {
      throw new Error('WASM processing is disabled by feature flags');
    }

    log(
      'INIT',
      'WasmSemanticProcessor',
      'Initializing WASM-enabled semantic processor'
    );

    const startTime = performance.now();

    try {
      // Import environment configuration FIRST to ensure proper setup
      await import('./transformers-env-config');

      // Import Transformers.js with pre-configured environment
      const { pipeline, env } = await import('@huggingface/transformers');

      // Environment should already be configured by transformers-env-config
      // Just verify the configuration is correct

      // Configure ONNX Runtime backends with proper order based on feature flags
      if (env.backends?.onnx) {
        const preferredOrder = [];

        if (this.featureFlagManager.isEnabled('webgpuAcceleration')) {
          preferredOrder.push('webgpu');
        }
        if (this.featureFlagManager.isEnabled('wasmCompilation')) {
          preferredOrder.push('wasm');
        }
        preferredOrder.push('cpu'); // Always include CPU as final fallback

        env.backends.onnx.preferredOrder = preferredOrder;

        if (
          env.backends.onnx.wasm &&
          this.featureFlagManager.isEnabled('wasmCompilation')
        ) {
          // Use asset URL resolver if provided (for extension context)
          env.backends.onnx.wasm.wasmPaths = this.assetUrlResolver
            ? this.assetUrlResolver('./')
            : './';
          env.backends.onnx.wasm.simd = true;
          env.backends.onnx.wasm.numThreads = 1; // Conservative for stability
        }

        if (env.backends.onnx.cpu) {
          (env.backends.onnx.cpu as any).enabled = true; // Final fallback
        }
      }

      log(
        'CONFIG',
        'WasmSemanticProcessor',
        'Transformers.js environment configured',
        'info',
        {
          allowLocalModels: env.allowLocalModels,
          allowRemoteModels: env.allowRemoteModels,
          useBrowserCache: env.useBrowserCache,
          wasmPaths: env.backends?.onnx?.wasm?.wasmPaths,
          preferredOrder: env.backends?.onnx?.preferredOrder,
        }
      );

      // Initialize the pipeline with proper cache directory
      const cacheDir = this.assetUrlResolver
        ? this.assetUrlResolver('models/')
        : 'models/';

      // Try quantized model first, fall back to non-quantized if not available
      const pipeline_options: any = {
        cache_dir: cacheDir,
        dtype: 'q8', // Prevent ONNX dtype warnings by explicitly specifying quantized precision
      };

      if (this.featureFlagManager.isEnabled('modelQuantization')) {
        try {
          log(
            'CONFIG',
            'WasmSemanticProcessor',
            'Attempting to load quantized model'
          );
          pipeline_options.quantized = true;
          this.pipeline = await pipeline(
            'feature-extraction',
            this.modelName,
            pipeline_options
          );
          log(
            'CONFIG',
            'WasmSemanticProcessor',
            'Successfully loaded quantized model'
          );
        } catch (quantizedError) {
          log(
            'CONFIG',
            'WasmSemanticProcessor',
            'Quantized model not available, falling back to non-quantized'
          );
          pipeline_options.quantized = false;
          this.pipeline = await pipeline(
            'feature-extraction',
            this.modelName,
            pipeline_options
          );
          log(
            'CONFIG',
            'WasmSemanticProcessor',
            'Successfully loaded non-quantized model'
          );
        }
      } else {
        pipeline_options.quantized = false;
        this.pipeline = await pipeline(
          'feature-extraction',
          this.modelName,
          pipeline_options
        );
        log(
          'CONFIG',
          'WasmSemanticProcessor',
          'Loaded non-quantized model (quantization disabled)'
        );
      }

      // Load previously stored contexts if available
      await this.loadStoredContexts();

      const initTime = performance.now() - startTime;

      // Check performance guardrails
      if (!this.featureFlagManager.checkPerformanceGuardrails({ initTime })) {
        throw new Error(
          `Initialization time exceeded guardrails: ${initTime}ms`
        );
      }

      this.isInitialized = true;
      log(
        'INIT',
        'WasmSemanticProcessor',
        'WASM semantic processor initialized successfully',
        'success',
        {
          modelName: this.modelName,
          contextCount: this.contexts.length,
          initTime: `${initTime.toFixed(2)}ms`,
        }
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      // Record error for circuit breaker
      if (error instanceof Error) {
        this.featureFlagManager.recordError(error);
      }

      log(
        'INIT',
        'WasmSemanticProcessor',
        'Failed to initialize WASM semantic processor',
        'error',
        {
          error: errorMessage,
          stack: error instanceof Error ? error.stack : undefined,
        }
      );
      throw error;
    }
  }

  /**
   * Add context for semantic search
   */
  async addContext(text: string, id: string, metadata?: any): Promise<void> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    try {
      log(
        'SEMANTIC',
        'WasmSemanticProcessor',
        `Adding context: ${id}`,
        'info',
        { id, textLength: text.length }
      );

      // Generate embedding
      const embedding = await this.generateEmbedding(text);

      const context: SemanticContext = {
        id,
        content: text,
        embedding,
        metadata,
        timestamp: Date.now(),
      };

      // Add to memory
      this.contexts.push(context);

      // Persist to storage if available
      await this.saveContext(context);

      log(
        'SEMANTIC',
        'WasmSemanticProcessor',
        `Context added successfully: ${id}`,
        'success',
        {
          id,
          embeddingLength: embedding.length,
          totalContexts: this.contexts.length,
        }
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      log(
        'SEMANTIC',
        'WasmSemanticProcessor',
        `Failed to add context: ${id}`,
        'error',
        {
          id,
          error: errorMessage,
        }
      );
      throw error;
    }
  }

  /**
   * Search contexts using semantic similarity
   */
  async search(
    query: string,
    options: SemanticSearchOptions = {}
  ): Promise<SemanticSearchResult[]> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    const { maxResults = 5, threshold = 0.7 } = options;
    const startTime = performance.now();

    try {
      log(
        'SEMANTIC',
        'WasmSemanticProcessor',
        `Searching for: "${query}"`,
        'info',
        {
          query: query.substring(0, 100),
          contextCount: this.contexts.length,
          maxResults,
          threshold,
        }
      );

      if (this.contexts.length === 0) {
        return [];
      }

      // Generate query embedding
      const queryEmbedding = await this.generateEmbedding(query);

      // Calculate similarities
      const results = this.contexts
        .map(context => ({
          id: context.id,
          content: context.content,
          similarity: this.cosineSimilarity(queryEmbedding, context.embedding),
          metadata: context.metadata,
        }))
        .filter(result => result.similarity >= threshold)
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, maxResults);

      const searchTime = performance.now() - startTime;

      // Check performance guardrails
      if (!this.featureFlagManager.checkPerformanceGuardrails({ searchTime })) {
        log(
          'SEMANTIC',
          'WasmSemanticProcessor',
          'Search time exceeded guardrails',
          'warn',
          {
            searchTime: `${searchTime.toFixed(2)}ms`,
          }
        );
      }

      log('SEMANTIC', 'WasmSemanticProcessor', `Search completed`, 'success', {
        query: query.substring(0, 100),
        resultsFound: results.length,
        topSimilarity: results[0]?.similarity,
        searchTime: `${searchTime.toFixed(2)}ms`,
      });

      return results;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      // Record error for circuit breaker
      if (error instanceof Error) {
        this.featureFlagManager.recordError(error);
      }

      log('SEMANTIC', 'WasmSemanticProcessor', 'Search failed', 'error', {
        query: query.substring(0, 100),
        error: errorMessage,
      });
      throw error;
    }
  }

  /**
   * Search contexts using semantic similarity (ContextSearcher interface)
   * This is a wrapper around the search method for compatibility with knowledge base loader
   */
  // fallow-ignore-next-line unused-class-member
  async searchContext(
    query: string,
    options: { maxResults?: number; threshold?: number } = {}
  ): Promise<any[]> {
    return await this.search(query, options);
  }

  /**
   * Generate embedding for text
   */
  private async generateEmbedding(text: string): Promise<number[]> {
    if (!this.pipeline) {
      throw new Error('Pipeline not initialized');
    }

    const result = await this.pipeline(text, {
      pooling: 'mean',
      normalize: true,
    });
    return Array.from(result.data);
  }

  /**
   * Calculate cosine similarity between two vectors.
   *
   * Intentionally local rather than using search/similarity-calculator's
   * shared cosineSimilarity: this path runs inside the WASM worker and
   * must not throw SearchError (a search-layer type) or coerce
   * zero-magnitude vectors to 0 (the worker relies on NaN propagation
   * for upstream diagnostics). Structural duplication with the search
   * module is expected.
   */
  // fallow-ignore-next-line duplication
  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
      throw new Error('Vectors must have the same length');
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  /**
   * Load stored contexts (implementation depends on environment)
   */
  private async loadStoredContexts(): Promise<void> {
    // This is a placeholder in case we want to implement persistent local storage of contexts across browser sessions
    // The L1 will make this irrelevant
    // Extension could provide chrome.storage, web apps might use IndexedDB, etc.
    log(
      'STORAGE',
      'WasmSemanticProcessor',
      'Context loading not implemented - override in consumer',
      'debug'
    );
  }

  /**
   * Save context using configured storage backend
   */
  private async saveContext(context: SemanticContext): Promise<void> {
    if (!this.storageBackend) {
      log(
        'STORAGE',
        'WasmSemanticProcessor',
        'Context saving not implemented - no storage backend configured',
        'warn'
      );
      return;
    }

    try {
      // Convert SemanticContext to storage format
      const contextData = {
        id: context.id,
        content: context.content,
        embedding: context.embedding,
        metadata: {
          ...context.metadata,
          timestamp: Date.now(),
          source: 'wasm-processor',
        },
      };

      // Use storage backend to persist context
      if (typeof this.storageBackend.storeContext === 'function') {
        await this.storageBackend.storeContext(contextData);
        log('STORAGE', 'WasmSemanticProcessor', `Context saved: ${context.id}`);
      } else if (typeof this.storageBackend.set === 'function') {
        await this.storageBackend.set(`context:${context.id}`, contextData);
        log('STORAGE', 'WasmSemanticProcessor', `Context saved: ${context.id}`);
      } else {
        log(
          'STORAGE',
          'WasmSemanticProcessor',
          'Storage backend does not support context saving',
          'warn'
        );
      }
    } catch (error) {
      log(
        'STORAGE',
        'WasmSemanticProcessor',
        `Failed to save context ${context.id}: ${error}`,
        'error'
      );
    }
  }

  /**
   * Get processor status
   */
  getStatus() {
    return {
      initialized: this.isInitialized,
      contextCount: this.contexts.length,
      modelName: this.modelName,
      type: 'wasm-semantic-processor',
    };
  }

  /**
   * Clear all contexts
   */
  clearContexts(): void {
    this.contexts = [];
    log('SEMANTIC', 'WasmSemanticProcessor', 'All contexts cleared', 'info');
  }

  /**
   * Get all contexts
   */
  getContexts(): SemanticContext[] {
    return [...this.contexts];
  }
}

/**
 * Test WebAssembly support in current environment
 */
export async function testWebAssemblySupport(): Promise<WasmCapabilities> {
  const platform =
    typeof window !== 'undefined' ? window.location.hostname : 'unknown';
  const capabilities: WasmCapabilities = {
    hasWebAssembly: false,
    canCompile: false,
    canInstantiate: false,
    supportsStreaming: false,
    platform,
  };

  try {
    // Test 1: Basic WebAssembly object availability
    capabilities.hasWebAssembly = typeof WebAssembly !== 'undefined';
    if (!capabilities.hasWebAssembly) {
      capabilities.error = 'WebAssembly object not available';
      return capabilities;
    }

    // Test 2: Check if streaming is supported
    capabilities.supportsStreaming =
      typeof WebAssembly.instantiateStreaming === 'function';

    // Test 3: Try compiling a minimal WASM module
    const minimalWasm = new Uint8Array([
      0x00,
      0x61,
      0x73,
      0x6d, // WASM magic number
      0x01,
      0x00,
      0x00,
      0x00, // Version 1
    ]);

    try {
      const startTime = performance.now();
      await WebAssembly.instantiate(minimalWasm);
      const duration = performance.now() - startTime;

      capabilities.canCompile = true;
      capabilities.canInstantiate = true;

      log(
        'CONFIG',
        'WasmCapabilityTest',
        `✅ WebAssembly compilation successful on ${platform}`,
        'success',
        {
          platform,
          duration: `${duration.toFixed(2)}ms`,
          canCompile: true,
          canInstantiate: true,
        }
      );
    } catch (error) {
      capabilities.error =
        error instanceof Error ? error.message : String(error);

      // Check if it's a CSP-related error
      const isCSPError =
        capabilities.error.includes('unsafe-eval') ||
        capabilities.error.includes('Content Security Policy') ||
        capabilities.error.includes('wasm-unsafe-eval');

      log(
        'CONFIG',
        'WasmCapabilityTest',
        `❌ WebAssembly compilation failed on ${platform}`,
        'error',
        {
          platform,
          error: capabilities.error,
          isCSPError,
          errorType: isCSPError ? 'CSP_RESTRICTION' : 'COMPILATION_ERROR',
        }
      );
    }

    return capabilities;
  } catch (error) {
    capabilities.error = error instanceof Error ? error.message : String(error);
    log(
      'CONFIG',
      'WasmCapabilityTest',
      `Unexpected error during WASM detection on ${platform}`,
      'error',
      {
        platform,
        error: capabilities.error,
      }
    );
    return capabilities;
  }
}
