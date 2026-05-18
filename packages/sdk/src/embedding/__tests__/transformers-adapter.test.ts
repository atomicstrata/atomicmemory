/**
 * @file Transformers.js Adapter Tests
 *
 * Comprehensive tests for the TransformersAdapter which provides embedding
 * generation using Hugging Face's transformers.js library. Covers model
 * loading, single and batch embedding generation, resource management.
 *
 * ## Test Coverage
 *
 * | Feature | Test Cases |
 * |---------|------------|
 * | Initialization | Default config, full config, custom options |
 * | Single Embeddings | Text validation, generation, truncation |
 * | Batch Embeddings | Array validation, parallel generation |
 * | Model Management | Preload, reuse, concurrent loading |
 * | Resource Cleanup | Dispose models, cache clearing |
 * | Error Handling | Invalid input, pipeline errors, load failures |
 *
 * ## Model Lifecycle Tests
 *
 * Verifies:
 * - Models are loaded once and reused across calls
 * - Concurrent embedding requests share the same model instance
 * - Model info accurately reflects loaded state
 * - Dispose properly cleans up model resources
 *
 * ## Text Processing Tests
 *
 * Validates:
 * - Empty/null input rejection
 * - Long text truncation to maxLength
 * - Word boundary preservation during truncation
 * - Batch input array validation
 *
 * ## Test Setup
 *
 * Mocks @huggingface/transformers pipeline with configurable responses.
 * Uses RuntimeConfig for environment configuration.
 *
 * @see {@link ../transformers-adapter.ts} - Implementation under test
 * @see {@link ../embedding-generator.ts} - Higher-level embedding interface
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  TransformersAdapter,
  disposeAllModels,
} from '../../../src/embedding/transformers-adapter';
import { RuntimeConfig } from '../../../src/core/runtime-config';

// Mock Transformers.js with proper env export
vi.mock('@huggingface/transformers', () => {
  const mockPipeline = vi.fn();
  const mockEnv = {
    allowLocalModels: true,
    allowRemoteModels: true,
    useBrowserCache: false,
    backends: {
      onnx: {
        preferredOrder: [],
        wasm: {
          wasmPaths: './',
          simd: true,
          numThreads: 1
        },
        cpu: {
          enabled: true
        }
      }
    }
  };

  return {
    pipeline: mockPipeline,
    pipeline2: mockPipeline,
    env: mockEnv,
    default: {
      pipeline: mockPipeline,
      env: mockEnv
    }
  };
});

describe('TransformersAdapter', () => {
  let adapter: TransformersAdapter;
  let mockPipelineInstance: any;
  let mockPipeline: any;
  let originalChrome: unknown;

  // ...

  beforeEach(async () => {
    await disposeAllModels();
    RuntimeConfig.getInstance().initialize({ environment: 'development' });

    originalChrome = (globalThis as any).chrome;
    (globalThis as any).chrome = undefined;

    const transformersModule = await import('@huggingface/transformers');
    mockPipeline = transformersModule.pipeline;

    mockPipelineInstance = vi.fn().mockResolvedValue({ data: Array(384).fill(0) });
    (mockPipelineInstance as any).dispose = vi.fn();
    mockPipeline.mockResolvedValue(mockPipelineInstance);

    adapter = new TransformersAdapter({
      model: 'test-model',
      dimensions: 384
    });
  });

  afterEach(async () => {
    await disposeAllModels();
    RuntimeConfig.getInstance().reset();
    vi.clearAllMocks();
    (globalThis as any).chrome = originalChrome;
  });

  describe('Initialization', () => {
    it('should create adapter with default config', () => {
      const adapter = new TransformersAdapter({
        model: 'test-model'
      });

      expect(adapter).toBeInstanceOf(TransformersAdapter);
    });

    it('should create adapter with full config', () => {
      const adapter = new TransformersAdapter({
        model: 'custom-model',
        dimensions: 768,
        maxLength: 1024,
        device: 'gpu',
        quantized: false,
        cacheDir: './custom-cache'
      });

      expect(adapter).toBeInstanceOf(TransformersAdapter);
    });
  });

  describe('Single Embedding Generation', () => {
    it('should generate embedding for text', async () => {
      const mockEmbedding = Array(384).fill(0).map(() => Math.random());
      (mockPipelineInstance as any).mockResolvedValue({ data: mockEmbedding });

      const result = await adapter.generateEmbedding('test text');

      expect(result.embedding).toEqual(mockEmbedding);
      expect(result.dimensions).toBe(384);
      expect(result.model).toBe('test-model');
      expect(result.processingTime).toBeGreaterThanOrEqual(0);
      expect(mockPipeline).toHaveBeenCalledWith('feature-extraction', 'test-model', {
        cache_dir: './.cache/transformers',
        dtype: 'q8'
      });
      expect(mockPipelineInstance).toHaveBeenCalledWith('test text', { pooling: 'mean', normalize: true });
    });

    it('should validate input text', async () => {
      await expect(adapter.generateEmbedding('')).rejects.toThrow('Invalid text input');
      await expect(adapter.generateEmbedding(null as any)).rejects.toThrow('Invalid text input');
      await expect(adapter.generateEmbedding(undefined as any)).rejects.toThrow('Invalid text input');
      await expect(adapter.generateEmbedding(123 as any)).rejects.toThrow('Invalid text input');
    });

    it('should handle pipeline errors', async () => {
      (mockPipelineInstance as any).mockRejectedValue(new Error('Pipeline error'));

      await expect(adapter.generateEmbedding('test text')).rejects.toThrow('Pipeline error');
    });

    it('should truncate long text', async () => {
      const longText = 'word '.repeat(200); // 1000 characters
      const mockEmbedding = Array(384).fill(0);
      (mockPipelineInstance as any).mockResolvedValue({ data: mockEmbedding });

      await adapter.generateEmbedding(longText);

      // Should be called with truncated text
      const calledText = mockPipelineInstance.mock.calls[0][0];
      expect(calledText.length).toBeLessThan(longText.length);
    });

    it('should truncate at word boundaries when possible', async () => {
      const adapter = new TransformersAdapter({
        model: 'test-model',
        maxLength: 20
      });

      const text = 'This is a long sentence that should be truncated';
      const mockEmbedding = Array(384).fill(0);
      (mockPipelineInstance as any).mockResolvedValue({ data: mockEmbedding });

      await adapter.generateEmbedding(text);

      const calledText = mockPipelineInstance.mock.calls[0][0];
      expect(calledText.length).toBeLessThanOrEqual(20);
      expect(calledText.startsWith('This is a long')).toBe(true);
    });
  });

  describe('Batch Embedding Generation', () => {
    it('should generate batch embeddings', async () => {
      const mockEmbeddings = [
        { data: Array(384).fill(0) },
        { data: Array(384).fill(1) }
      ];
      (mockPipelineInstance as any).mockResolvedValue(mockEmbeddings);

      const results = await adapter.generateBatchEmbeddings(['text1', 'text2']);

      expect(results).toHaveLength(2);
      expect(results[0].embedding).toEqual(Array(384).fill(0));
      expect(results[1].embedding).toEqual(Array(384).fill(1));
      expect(mockPipelineInstance).toHaveBeenCalledWith(['text1', 'text2'], { pooling: 'mean', normalize: true });
    });

    it('should handle single result from batch', async () => {
      const mockEmbedding = { data: Array(384).fill(0) };
      (mockPipelineInstance as any).mockResolvedValue(mockEmbedding);

      const results = await adapter.generateBatchEmbeddings(['text1']);

      expect(results).toHaveLength(1);
      expect(results[0].embedding).toEqual(Array(384).fill(0));
    });

    it('should validate batch input', async () => {
      await expect(adapter.generateBatchEmbeddings([])).rejects.toThrow('Invalid texts input');
      await expect(adapter.generateBatchEmbeddings(null as any)).rejects.toThrow('Invalid texts input');
      await expect(adapter.generateBatchEmbeddings('not-array' as any)).rejects.toThrow('Invalid texts input');
    });

    it('should truncate all texts in batch', async () => {
      const longTexts = ['word '.repeat(200), 'another '.repeat(200)];
      const mockEmbeddings = [
        { data: Array(384).fill(0) },
        { data: Array(384).fill(1) }
      ];
      (mockPipelineInstance as any).mockResolvedValue(mockEmbeddings);

      await adapter.generateBatchEmbeddings(longTexts);

      const calledTexts = mockPipelineInstance.mock.calls[0][0];
      expect(calledTexts[0].length).toBeLessThan(longTexts[0].length);
      expect(calledTexts[1].length).toBeLessThan(longTexts[1].length);
    });

    it('should handle batch pipeline errors', async () => {
      (mockPipelineInstance as any).mockRejectedValue(new Error('Batch pipeline error'));

      await expect(adapter.generateBatchEmbeddings(['text1', 'text2'])).rejects.toThrow('Batch pipeline error');
    });
  });

  describe('Model Management', () => {
    it('should preload model', async () => {
      await adapter.preloadModel();

      expect(mockPipeline).toHaveBeenCalledWith('feature-extraction', 'test-model', {
        cache_dir: './.cache/transformers',
        dtype: 'q8'
      });
    });

    it('should preload specific model', async () => {
      await adapter.preloadModel('custom-model');

      expect(mockPipeline).toHaveBeenCalledWith('feature-extraction', 'custom-model', {
        cache_dir: './.cache/transformers',
        dtype: 'q8'
      });
    });

    it('should handle model loading errors', async () => {
      mockPipeline.mockRejectedValue(new Error('Model load error'));

      await expect(adapter.preloadModel()).rejects.toThrow('Model load error');
    });

    it('should reuse loaded models', async () => {
      const mockEmbedding = Array(384).fill(0);
      (mockPipelineInstance as any).mockResolvedValue({ data: mockEmbedding });

      // First call should load model
      await adapter.generateEmbedding('text1');
      expect(mockPipeline).toHaveBeenCalledTimes(1);

      // Second call should reuse model
      await adapter.generateEmbedding('text2');
      expect(mockPipeline).toHaveBeenCalledTimes(1);
    });

    it('should handle concurrent model loading', async () => {
      const mockEmbedding = Array(384).fill(0);
      (mockPipelineInstance as any).mockResolvedValue({ data: mockEmbedding });

      // Concurrent calls should only load model once
      const promises = [
        adapter.generateEmbedding('text1'),
        adapter.generateEmbedding('text2'),
        adapter.generateEmbedding('text3')
      ];

      await Promise.all(promises);
      expect(mockPipeline).toHaveBeenCalledTimes(1);
    });

    it('should get model info', () => {
      const info = adapter.getModelInfo();

      expect(info.dimensions).toBe(384);
      expect(info.maxLength).toBe(512);
      expect(info.isLoaded).toBe(false);
    });

    it('should get model info for specific model', () => {
      const info = adapter.getModelInfo('custom-model');

      expect(info.dimensions).toBe(384);
      expect(info.maxLength).toBe(512);
      expect(info.isLoaded).toBe(false);
    });

    it('should update model info after loading', async () => {
      const mockEmbedding = Array(384).fill(0);
      (mockPipelineInstance as any).mockResolvedValue({ data: mockEmbedding });

      await adapter.generateEmbedding('test text');

      const info = adapter.getModelInfo();
      expect(info.isLoaded).toBe(true);
    });
  });

  describe('Resource Management', () => {
    it('should dispose models', async () => {
      const mockEmbedding = Array(384).fill(0);
      (mockPipelineInstance as any).mockResolvedValue({ data: mockEmbedding });

      // Load a model
      await adapter.generateEmbedding('test text');

      await disposeAllModels();

      expect(mockPipelineInstance.dispose).toHaveBeenCalled();
    });

    it('should handle dispose errors gracefully', async () => {
      const mockEmbedding = Array(384).fill(0);
      mockPipelineInstance.mockResolvedValue({ data: mockEmbedding });
      mockPipelineInstance.dispose.mockRejectedValue(new Error('Dispose error'));

      // Load a model
      await adapter.generateEmbedding('test text');

      await expect(disposeAllModels()).resolves.not.toThrow();
    });

    it('should clear model cache on dispose', async () => {
      const mockEmbedding = Array(384).fill(0);
      mockPipelineInstance.mockResolvedValue({ data: mockEmbedding });

      // Load a model
      await adapter.generateEmbedding('test text');
      expect(adapter.getModelInfo().isLoaded).toBe(true);

      // Dispose
      await disposeAllModels();

      // Model should no longer be loaded
      expect(adapter.getModelInfo().isLoaded).toBe(false);
    });
  });

  describe('Configuration', () => {
    it('should use custom configuration', async () => {
      const customAdapter = new TransformersAdapter({
        model: 'custom-model',
        dimensions: 768,
        maxLength: 1024,
        device: 'gpu',
        quantized: false,
        cacheDir: './custom-cache',
        dtype: 'fp32'
      });

      await customAdapter.preloadModel();

      expect(mockPipeline).toHaveBeenCalledWith('feature-extraction', 'custom-model', {
        cache_dir: './custom-cache',
        dtype: 'fp32'
      });
    });

    it('should handle different model architectures', async () => {
      const models = [
        'Xenova/all-MiniLM-L6-v2',
        'Xenova/all-mpnet-base-v2',
        'sentence-transformers/all-MiniLM-L6-v2'
      ];

      for (const model of models) {
        const adapter = new TransformersAdapter({ model });
        await adapter.preloadModel();

        expect(mockPipeline).toHaveBeenCalledWith('feature-extraction', model, expect.any(Object));
      }
    });
  });
});
