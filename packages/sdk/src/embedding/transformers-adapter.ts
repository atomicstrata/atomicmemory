/**
 * @file Transformers.js Adapter
 *
 * Adapter for Transformers.js embedding models with caching, batching,
 * and error handling. Supports multiple model architectures and provides
 * efficient text-to-vector conversion.
 */

// Import environment configuration FIRST to ensure proper setup
import './transformers-env-config';
import { pipeline, FeatureExtractionPipeline } from '@huggingface/transformers';
import type { EmbeddingResult } from './embedding-generator';
import { isTestEnvironment } from '../utils/environment';
import { parseTransformersError } from '../utils/error-parsing';

// NOTE: We no longer install a global fetch interceptor at module load time.
// Some environments (Mem0-primary mode) never load local models, so intercepting
// all fetch calls is unnecessary and noisy. We now install on-demand only when
// a local Transformers.js model is actually being loaded.

const originalFetch = globalThis.fetch;

/** File patterns that indicate a model-related fetch request */
const MODEL_FILE_PATTERNS = [
  'all-MiniLM-L6-v2',
  'tokenizer.json',
  'config.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'vocab.txt',
  'modules.json',
  'sentence_bert_config.json',
  'config_sentence_transformers.json',
  'model.onnx',
  'model_quantized.onnx',
] as const;

/** Known model files that can be redirected to extension URLs */
const KNOWN_MODEL_FILES = [
  'tokenizer.json',
  'tokenizer_config.json',
  'config.json',
  'special_tokens_map.json',
  'vocab.txt',
  'modules.json',
  'sentence_bert_config.json',
  'config_sentence_transformers.json',
  'model.onnx',
  'model_quantized.onnx',
] as const;

/**
 * Dump a caught error in the multi-line DEBUG format used by the
 * transformers-adapter load paths. `prefix` becomes the bracketed tag
 * (`❌ [${prefix}]`); `labelExtra` is inserted between the closing
 * bracket and the field label so the local-model path can emit
 * "❌ [DEBUG] Local Error type:" without mangling the bracket pair.
 */
function logErrorDetails(
  prefix: string,
  error: unknown,
  labelExtra = '',
): void {
  const err = error as Error | undefined;
  const tag = `❌ [${prefix}] ${labelExtra}`;
  console.error(`${tag}Error type:`, typeof error);
  console.error(`${tag}Error name:`, err?.name);
  console.error(`${tag}Error message:`, err?.message);
  console.error(`${tag}Error stack:`, err?.stack?.split('\n').slice(0, 5));
}

function isModelRelatedUrl(url: string): boolean {
  return MODEL_FILE_PATTERNS.some(pattern => url.includes(pattern));
}

/** Extract the resolved URL string from a fetch RequestInfo input */
function extractUrlFromFetchInput(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** Check if the Chrome extension runtime API is available */
function hasChromeRuntime(): boolean {
  return typeof chrome !== 'undefined' && !!chrome.runtime;
}

/**
 * Handle malformed chrome-extension model paths that have a `/models/` prefix
 * prepended to the chrome-extension URL.
 */
function tryFixMalformedExtensionUrl(
  url: string,
  init: RequestInit | undefined,
): Response | null {
  if (!url.includes('chrome-extension://') || !url.includes('/models/')) {
    return null;
  }

  if (url.startsWith('/models/chrome-extension://')) {
    const fixedUrl = url.replace('/models/', '');
    console.log(`🔄 [MODEL FETCH] Fixing malformed URL: ${url} -> ${fixedUrl}`);
    // Return a sentinel — caller will await the fetch
    return originalFetch(fixedUrl, init) as unknown as Response;
  }

  if (url.includes('/models/all-MiniLM-L6-v2/') && hasChromeRuntime()) {
    const filename = url.split('/models/all-MiniLM-L6-v2/')[1];
    if (filename) {
      const extensionUrl = chrome.runtime.getURL(`models/all-MiniLM-L6-v2/${filename}`);
      console.log(`🔄 [MODEL FETCH] Redirecting relative path: ${url} -> ${extensionUrl}`);
      return originalFetch(extensionUrl, init) as unknown as Response;
    }
  }

  return null;
}

/**
 * Redirect a known model file request to the bundled chrome-extension URL.
 * Returns null if no redirect is applicable.
 */
function tryRedirectModelFile(
  url: string,
  init: RequestInit | undefined,
): Response | null {
  if (!isModelRelatedUrl(url) || !hasChromeRuntime()) {
    return null;
  }

  const urlParts = url.split('/');
  const filename = urlParts[urlParts.length - 1];

  if ((KNOWN_MODEL_FILES as readonly string[]).includes(filename)) {
    const isOnnxFile = filename.endsWith('.onnx');
    const modelPath = isOnnxFile
      ? `models/all-MiniLM-L6-v2/onnx/${filename}`
      : `models/all-MiniLM-L6-v2/${filename}`;
    const extensionUrl = chrome.runtime.getURL(modelPath);
    console.log(`🔄 [MODEL FETCH] Redirecting model file: ${url} -> ${extensionUrl}`);
    return originalFetch(extensionUrl, init) as unknown as Response;
  }

  if (filename === 'config.json' && (url.includes('1_Pooling') || url.includes('2_Normalize'))) {
    const subdir = url.includes('1_Pooling') ? '1_Pooling' : '2_Normalize';
    const extensionUrl = chrome.runtime.getURL(`models/all-MiniLM-L6-v2/${subdir}/config.json`);
    console.log(`🔄 [MODEL FETCH] Redirecting subdir file: ${url} -> ${extensionUrl}`);
    return originalFetch(extensionUrl, init) as unknown as Response;
  }

  return null;
}

// Create our interceptor function (exported for on-demand install)
const createFetchInterceptor =
  () => async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = extractUrlFromFetchInput(input);

    if (url && isModelRelatedUrl(url)) {
      console.log(`🔍 [MODEL FETCH] ${url}`);
    }

    const malformedRedirect = tryFixMalformedExtensionUrl(url, init);
    if (malformedRedirect) return malformedRedirect;

    const modelRedirect = tryRedirectModelFile(url, init);
    if (modelRedirect) return modelRedirect;

    return originalFetch(input, init);
  };

let __modelFetchInterceptorInstalled = false;
function installGlobalModelFetchInterceptorOnce(): void {
  if (__modelFetchInterceptorInstalled) return;
  const interceptorFunction = createFetchInterceptor();

  // Patch common fetch references conservatively
  globalThis.fetch = interceptorFunction;
  if (typeof window !== 'undefined') {
    window.fetch = interceptorFunction;
  }
  if (typeof self !== 'undefined') {
    (self as any).fetch = interceptorFunction as any;
  }
  try {
    Object.defineProperty(globalThis, 'fetch', {
      value: interceptorFunction,
      writable: true,
      configurable: true,
    });
  } catch (e) {
    console.warn('Could not redefine globalThis.fetch property:', e);
  }
  __modelFetchInterceptorInstalled = true;
  console.log(`🔧 [MODEL FETCH SETUP] Fetch interceptor installed on-demand`);
}

interface TransformersConfig {
  model: string;
  dimensions?: number;
  maxLength?: number;
  device?: 'cpu' | 'gpu';
  quantized?: boolean;
  cacheDir?: string;
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
    | string;
}

interface ModelInfo {
  pipeline?: FeatureExtractionPipeline;
  dimensions: number;
  maxLength: number;
  isLoading: boolean;
  loadPromise?: Promise<FeatureExtractionPipeline>;
}

// Global model cache - singleton across all TransformersAdapter instances
// This ensures models are loaded once and shared across all SDK instances
const globalModelCache = new Map<string, ModelInfo>();

/**
 * Global cleanup function to dispose all cached models
 * Should only be called at application shutdown
 */
export async function disposeAllModels(): Promise<void> {
  for (const [modelName, info] of globalModelCache.entries()) {
    if (info.pipeline) {
      try {
        await info.pipeline.dispose?.();
      } catch (error) {
        console.warn(`Failed to dispose model ${modelName}:`, error);
      }
    }
  }
  globalModelCache.clear();
  console.log('All global models disposed');
}

export class TransformersAdapter {
  // Use global model cache instead of instance-specific cache
  private config: TransformersConfig & {
    model: string;
    dimensions: number;
    maxLength: number;
    device: string;
    cacheDir: string;
    dtype:
      | 'auto'
      | 'fp32'
      | 'fp16'
      | 'q8'
      | 'int8'
      | 'uint8'
      | 'q4'
      | 'bnb4'
      | 'q4f16'
      | string;
  };

  constructor(config: TransformersConfig) {
    this.config = {
      model: config.model || 'Xenova/all-MiniLM-L6-v2',
      dimensions: config.dimensions || 384,
      maxLength: config.maxLength || 512,
      device: config.device || 'cpu',
      cacheDir: config.cacheDir || './.cache/transformers',
      dtype: config.dtype || 'q8', // Default to q8 to match our bundled quantized models
    };

    // In test environment, pre-populate global cache with mock models
    if (isTestEnvironment()) {
      console.log(
        'Test environment detected in TransformersAdapter constructor'
      );
      // Pre-populate global cache with mock model to avoid loading real models
      globalModelCache.set(this.config.model, {
        pipeline: this.createMockModel(),
        dimensions: this.config.dimensions,
        maxLength: this.config.maxLength,
        isLoading: false,
        loadPromise: undefined,
      });
    }
  }

  async generateEmbedding(text: string): Promise<EmbeddingResult> {
    if (!text || typeof text !== 'string') {
      throw new Error('Invalid text input');
    }

    const startTime = Date.now();

    try {
      const pipeline = await this.getOrLoadModel(this.config.model);
      const truncatedText = this.truncateText(text, this.config.maxLength);

      const result = await pipeline(truncatedText, {
        pooling: 'mean',
        normalize: true,
      });
      const embedding = Array.from(result.data as Float32Array).map(x =>
        Number(x)
      );

      return {
        embedding,
        dimensions: embedding.length,
        model: this.config.model,
        processingTime: Date.now() - startTime,
      };
    } catch (error) {
      throw new Error(
        `Failed to generate embedding: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async generateBatchEmbeddings(texts: string[]): Promise<EmbeddingResult[]> {
    if (!Array.isArray(texts) || texts.length === 0) {
      throw new Error('Invalid texts input');
    }

    const startTime = Date.now();

    try {
      const pipeline = await this.getOrLoadModel(this.config.model);
      const truncatedTexts = texts.map(text =>
        this.truncateText(text, this.config.maxLength)
      );

      const results = await pipeline(truncatedTexts, {
        pooling: 'mean',
        normalize: true,
      });

      // Handle both single and batch results
      const embeddings = Array.isArray(results) ? results : [results];

      const embeddingResults: EmbeddingResult[] = (embeddings as any[]).map(
        (result, _index) => {
          // Handle different result formats from the new API
          const data = (result as any).data || result;
          const embeddingArray = Array.isArray(data)
            ? data
            : Array.from(data as Float32Array);

          return {
            embedding: embeddingArray.map((x: any) => Number(x)),
            dimensions: embeddingArray.length,
            model: this.config.model,
            processingTime: Date.now() - startTime,
          };
        }
      );

      return embeddingResults;
    } catch (error) {
      throw new Error(
        `Failed to generate batch embeddings: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async preloadModel(modelName?: string): Promise<void> {
    const model = modelName || this.config.model;
    await this.getOrLoadModel(model);
  }

  getModelInfo(modelName?: string): {
    dimensions: number;
    maxLength: number;
    isLoaded: boolean;
  } {
    const model = modelName || this.config.model;
    const info = globalModelCache.get(model);

    return {
      dimensions: info?.dimensions || this.config.dimensions,
      maxLength: info?.maxLength || this.config.maxLength,
      isLoaded: !!info?.pipeline,
    };
  }

  // fallow-ignore-next-line unused-class-member
  async dispose(): Promise<void> {
    // Note: We don't dispose global models since they might be used by other instances
    // Global model cache cleanup should be handled at application shutdown
    console.log('TransformersAdapter disposed (global models remain cached)');
  }

  private async getOrLoadModel(
    modelName: string
  ): Promise<FeatureExtractionPipeline> {
    console.log(
      `🔍 [TransformersAdapter] getOrLoadModel called for ${modelName} with dtype: ${this.config.dtype}`
    );
    console.log(
      `🔍 [TransformersAdapter] Global cache size: ${globalModelCache.size}`
    );
    console.log(
      `🔍 [TransformersAdapter] Context: ${typeof window !== 'undefined' ? 'browser' : 'node'}`
    );

    let modelInfo = globalModelCache.get(modelName);

    if (!modelInfo) {
      console.log(
        `🔍 [TransformersAdapter] Creating new model info for ${modelName}`
      );
      modelInfo = {
        dimensions: this.config.dimensions,
        maxLength: this.config.maxLength,
        isLoading: false,
      };
      globalModelCache.set(modelName, modelInfo);
    } else {
      console.log(
        `🔍 [TransformersAdapter] Found existing model info for ${modelName}, isLoading: ${modelInfo.isLoading}, hasPipeline: ${!!modelInfo.pipeline}`
      );
    }

    if (modelInfo.pipeline) {
      console.log(
        `✅ [TransformersAdapter] Returning cached pipeline for ${modelName}`
      );
      return modelInfo.pipeline;
    }

    if (modelInfo.isLoading && modelInfo.loadPromise) {
      console.log(
        `⏳ [TransformersAdapter] Waiting for in-progress load of ${modelName}`
      );
      return await modelInfo.loadPromise;
    }

    console.log(
      `🚀 [TransformersAdapter] Starting model load for ${modelName} with dtype: ${this.config.dtype}`
    );
    modelInfo.isLoading = true;
    modelInfo.loadPromise = this.loadModel(modelName);

    try {
      const loadedPipeline = await modelInfo.loadPromise;
      modelInfo.pipeline = loadedPipeline;
      modelInfo.isLoading = false;
      console.log(
        `✅ [TransformersAdapter] Successfully loaded and cached ${modelName}`
      );
      return loadedPipeline;
    } catch (error) {
      modelInfo.isLoading = false;
      delete modelInfo.loadPromise;
      console.error(
        `❌ [TransformersAdapter] Failed to load ${modelName}:`,
        error
      );
      throw error;
    }
  }

  private async loadModel(
    modelName: string
  ): Promise<FeatureExtractionPipeline> {
    console.log(`🔄 [DEBUG] ===== STARTING MODEL LOAD: ${modelName} =====`);
    console.log(
      `🔄 [DEBUG] Current environment: ${isTestEnvironment() ? 'TEST' : 'PRODUCTION'}`
    );
    console.log(
      `🔄 [DEBUG] Chrome runtime available:`,
      typeof chrome !== 'undefined' && !!chrome.runtime
    );
    console.log(
      `🔄 [DEBUG] Extension ID:`,
      typeof chrome !== 'undefined' && chrome.runtime
        ? chrome.runtime.id
        : 'N/A'
    );

    // Check if we're in a test environment
    if (isTestEnvironment()) {
      console.log('Test environment detected, using mock model');
      return this.createMockModel();
    }

    // Ensure model fetch interceptor is installed only when needed
    installGlobalModelFetchInterceptorOnce();

    // Check if we're in a browser extension context
    const inExtension = typeof chrome !== 'undefined' && chrome.runtime;

    // In extension context, skip CDN and load from bundled models directly
    if (inExtension) {
      console.log(`📦 [DEBUG] Extension context detected - loading bundled model for ${modelName}`);
      return await this.loadLocalModel(modelName);
    }

    // Non-extension context: try CDN first, then local fallback
    try {
      console.log(`🌐 [DEBUG] Attempting CDN load for ${modelName}`);
      console.log(
        `🌐 [DEBUG] CDN Options: {cache_dir: '${this.config.cacheDir}'}`
      );

      const loadedPipeline: FeatureExtractionPipeline = (await pipeline(
        'feature-extraction',
        modelName,
        {
          cache_dir: this.config.cacheDir,
          dtype: this.config.dtype as 'q8', // Prevent ONNX dtype warnings
        }
      )) as any;

      console.log(`✅ Model loaded from CDN: ${modelName}`);
      return loadedPipeline;
    } catch (cdnError) {
      console.warn(
        `⚠️ [DEBUG] CDN loading failed for ${modelName}, trying local fallback`
      );
      console.warn(`⚠️ [DEBUG] CDN Error type:`, typeof cdnError);
      console.warn(`⚠️ [DEBUG] CDN Error name:`, (cdnError as Error)?.name);
      console.warn(
        `⚠️ [DEBUG] CDN Error message:`,
        (cdnError as Error)?.message
      );
      console.warn(
        `⚠️ CDN loading failed for ${modelName}, trying local fallback:`,
        cdnError
      );

      // Enhanced error parsing for CDN failures
      const enhancedCdnError = parseTransformersError(cdnError as Error, []);

      // No fallbacks - fail fast to maintain deterministic embeddings
      throw new Error(
        `Failed to load model ${modelName}: ${enhancedCdnError.message}`
      );
    }
  }

  private createMockModel(): FeatureExtractionPipeline {
    // Only used in test environments to ensure deterministic behavior
    const mockModel = (async (input: string | string[]) => {
      const texts = Array.isArray(input) ? input : [input];
      const embeddings = texts.map(text => {
        const hash = text.split('').reduce((a, b) => {
          a = (a << 5) - a + b.charCodeAt(0);
          return a & a;
        }, 0);

        return new Array(384).fill(0).map((_, i) => {
          return Math.sin((hash + i) * 0.01) * 0.5;
        });
      });

      const data = embeddings.length === 1 ? embeddings[0] : embeddings;
      return {
        data: Array.isArray(data) ? new Float32Array(data.flat()) : new Float32Array(data),
        dims: [embeddings.length, 384],
      };
    }) as unknown as FeatureExtractionPipeline;

    (mockModel as any).dispose = () => undefined;

    console.log('Mock embedding model created for testing');
    return mockModel;
  }

  private async loadLocalModel(
    modelName: string
  ): Promise<FeatureExtractionPipeline> {
    try {
      console.log(
        `🔄 [DEBUG] ===== STARTING LOCAL MODEL LOAD: ${modelName} =====`
      );
      console.log(`🔄 Attempting to load local model: ${modelName}`);
      console.log(`🔄 [DEBUG] Chrome object:`, typeof chrome);
      console.log(`🔄 [DEBUG] Chrome runtime:`, typeof chrome?.runtime);
      console.log(`🔄 [DEBUG] Chrome runtime ID:`, chrome?.runtime?.id);

      // Map model name to local path
      const localModelPath = this.getLocalModelPath(modelName);
      console.log(`🔄 [DEBUG] Local model path resolved to: ${localModelPath}`);

      // Diagnostic fetch to verify web_accessible_resources and URL resolution
      try {
        const files = [
          'tokenizer.json',
          'tokenizer_config.json',
          'special_tokens_map.json',
          'vocab.txt',
          'config.json',
          'config_sentence_transformers.json',
          'sentence_bert_config.json',
          'modules.json',
          '1_Pooling/config.json',
          '2_Normalize/config.json',
          'onnx/model.onnx',
        ];
        for (const f of files) {
          // Ensure proper URL construction - add slash if not present
          const url = localModelPath.endsWith('/')
            ? `${localModelPath}${f}`
            : `${localModelPath}/${f}`;
          const res = await fetch(url, { method: 'GET' });
          const preview = f.endsWith('.onnx')
            ? `<binary ${res.status}>`
            : (await res.text()).slice(0, 60);
          console.log(
            `[ModelDiagnostics] fetch(${url}) -> ${res.status} ${preview}`
          );
        }
      } catch (diagErr) {
        console.warn(
          '[ModelDiagnostics] Pre-fetch of model files failed:',
          diagErr
        );
      }

      console.log(
        `🚀 [ModelDiagnostics] Calling Transformers.js pipeline with:`
      );
      console.log(`   - Model path: ${localModelPath}`);
      console.log(
        `   - Options: {quantized: ${this.config.quantized}, cache_dir: ${this.config.cacheDir}, local_files_only: true}`
      );
      console.log(`🔍 [DEBUG] About to call pipeline() function`);
      console.log(`🔍 [DEBUG] pipeline function type:`, typeof pipeline);
      console.log(
        `🔍 [DEBUG] Current globalThis.fetch:`,
        typeof globalThis.fetch
      );
      console.log(
        `🔍 [DEBUG] Current window.fetch:`,
        typeof (typeof window !== 'undefined' ? window.fetch : 'undefined')
      );
      console.log(
        `🔍 [DEBUG] Current self.fetch:`,
        typeof (typeof self !== 'undefined' ? self.fetch : 'undefined')
      );

      // Ensure interceptor is in place for local model fetches (on-demand)
      installGlobalModelFetchInterceptorOnce();
      console.log(
        `🔧 [FETCH INTERCEPT] Using fetch interceptor (installed on-demand)`
      );
      console.log(
        `🔧 [FETCH INTERCEPT] This should now intercept Transformers.js fetch calls`
      );

      try {
        const loadedPipeline: FeatureExtractionPipeline = (await pipeline(
          'feature-extraction',
          localModelPath,
          {
            cache_dir: this.config.cacheDir,
            local_files_only: true, // Force local files only
            dtype: this.config.dtype as 'q8', // Prevent ONNX dtype warnings
          }
        )) as any;

        console.log(`✅ [DEBUG] Pipeline call completed successfully!`);
        console.log(`✅ Local model loaded successfully: ${modelName}`);
        console.log(`✅ [DEBUG] Model object type:`, typeof loadedPipeline);
        console.log(
          `✅ [DEBUG] Model object keys:`,
          loadedPipeline ? Object.keys(loadedPipeline) : 'null'
        );
        return loadedPipeline;
      } catch (error) {
        console.error(`❌ [DEBUG] Pipeline call FAILED with error:`, error);
        logErrorDetails('DEBUG', error);
        console.error(
          `❌ [FETCH INTERCEPT] Transformers.js failed with global interceptor active`
        );
        console.error(
          `❌ [DEBUG] If no fetch interceptions were logged above, the global interceptor may not be working`
        );

        // Enhanced error parsing for HTML responses
        const enhancedError = parseTransformersError(error as Error, []);
        console.error(
          `❌ [DEBUG] Enhanced error message:`,
          enhancedError.message
        );
        throw enhancedError;
      }
    } catch (error) {
      console.error(
        `❌ [DEBUG] ===== LOCAL MODEL LOAD FAILED: ${modelName} =====`
      );
      console.error(`❌ Local model loading failed for ${modelName}:`, error);
      logErrorDetails('DEBUG', error, 'Local ');
      console.error(`❌ [DEBUG] ===== END LOCAL MODEL LOAD FAILURE =====`);
      throw new Error(
        `Failed to load local model ${modelName}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private getLocalModelPath(modelName: string): string {
    // For browser extension context
    if (typeof chrome !== 'undefined' && chrome.runtime) {
      // Transformers.js is making relative fetches that resolve against the page origin
      // We need to provide the full chrome-extension URL so it fetches from the extension
      const fullUrl = chrome.runtime.getURL('models/all-MiniLM-L6-v2/');

      const modelMappings: Record<string, string> = {
        // Full chrome-extension URL - this should work with Transformers.js
        'Xenova/all-MiniLM-L6-v2': fullUrl,
        'all-MiniLM-L6-v2': fullUrl,
      };

      const localPath = modelMappings[modelName];
      if (!localPath) {
        throw new Error(`No local model mapping found for: ${modelName}`);
      }

      console.log(`📍 Extension model path: ${localPath}`);
      console.log(`📍 Extension base URL: ${chrome.runtime.getURL('')}`);
      console.log(`📍 Extension ID: ${chrome.runtime.id}`);
      return localPath;
    }

    // For Node.js or other contexts, use relative path from SDK
    const normalizedModelName = modelName.replace('/', '_');
    const localPath = `./models/${normalizedModelName}/`;

    console.log(`📍 SDK model path: ${localPath}`);
    return localPath;
  }

  private truncateText(text: string, maxLength: number): string {
    if (text.length <= maxLength) {
      return text;
    }

    // Truncate at word boundary when possible
    const truncated = text.substring(0, maxLength);
    const lastSpace = truncated.lastIndexOf(' ');

    return lastSpace > maxLength * 0.8
      ? truncated.substring(0, lastSpace)
      : truncated;
  }
}
