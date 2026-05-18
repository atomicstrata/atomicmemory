/**
 * @file Embedding Generator Tests
 *
 * Tests for the embedding generation system including caching, batching,
 * error handling, and performance monitoring.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EmbeddingGenerator } from '../../../src/embedding/embedding-generator';
import { EventEmitter } from '../../../src/core/events';
import { EmbeddingError } from '../../../src/core/error-handling';

let mockAdapter: any;
const transformersAdapterCtor = vi.fn(function TransformersAdapterMock() {
  return mockAdapter;
});

vi.mock('../../../src/embedding/transformers-adapter', () => ({
  TransformersAdapter: transformersAdapterCtor,
}));

// Mock Transformers.js package with proper env export
vi.mock('@huggingface/transformers', () => ({
  pipeline: vi.fn(),
  env: {
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
  }
}));

describe('EmbeddingGenerator', () => {
  let generator: EmbeddingGenerator;
  let eventEmitter: EventEmitter;

  beforeEach(() => {
    eventEmitter = new EventEmitter();

    transformersAdapterCtor.mockReset();

    // Mock the TransformersAdapter
    mockAdapter = {
      generateEmbedding: vi.fn(),
      generateBatchEmbeddings: vi.fn(),
      preloadModel: vi.fn(),
      getModelInfo: vi.fn(),
      dispose: vi.fn()
    };

    transformersAdapterCtor.mockClear();

    generator = new EmbeddingGenerator({
      model: 'test-model',
      dimensions: 384,
      provider: 'transformers'
    }, eventEmitter, mockAdapter);
  });

  describe('Initialization', () => {
    it('should create generator with default config', () => {
      const gen = new EmbeddingGenerator({
        model: 'test-model',
        dimensions: 384,
        provider: 'transformers'
      });

      expect(gen).toBeInstanceOf(EmbeddingGenerator);
    });

    it('should throw error for unsupported provider', () => {
      expect(() => {
        new EmbeddingGenerator({
          model: 'test-model',
          dimensions: 384,
          provider: 'unsupported' as any
        });
      }).toThrow(EmbeddingError);
    });

    it('should use default values for optional config', () => {
      const gen = new EmbeddingGenerator({
        model: 'test-model',
        dimensions: 384,
        provider: 'transformers'
      });

      const stats = gen.getStats();
      expect(stats.totalRequests).toBe(0);
      expect(stats.cacheSize).toBe(0);
    });
  });

  describe('Single Embedding Generation', () => {
    it('should generate embedding for text', async () => {
      const mockResult = {
        embedding: Array(384).fill(0).map(() => Math.random()),
        dimensions: 384,
        model: 'test-model',
        processingTime: 100
      };

      mockAdapter.generateEmbedding.mockResolvedValue(mockResult);

      const result = await generator.generateEmbedding('test text');

      // Expect enhanced result with forward compatibility fields
      expect(result).toEqual({
        ...mockResult,
        version: '1.0',
        provider: 'transformers',
        metadata: {
          cacheHit: false
        }
      });
      expect(mockAdapter.generateEmbedding).toHaveBeenCalledWith('test text');
    });

    it('should validate input text', async () => {
      await expect(generator.generateEmbedding('')).rejects.toThrow(EmbeddingError);
      await expect(generator.generateEmbedding(null as any)).rejects.toThrow(EmbeddingError);
      await expect(generator.generateEmbedding(undefined as any)).rejects.toThrow(EmbeddingError);
    });

    it('should update statistics', async () => {
      const mockResult = {
        embedding: Array(384).fill(0),
        dimensions: 384,
        model: 'test-model',
        processingTime: 100
      };

      mockAdapter.generateEmbedding.mockResolvedValue(mockResult);

      await generator.generateEmbedding('test text');

      const stats = generator.getStats();
      expect(stats.totalRequests).toBe(1);
      expect(stats.totalProcessingTime).toBeGreaterThan(0);
      expect(stats.averageProcessingTime).toBeGreaterThan(0);
    });

    it('should emit events', async () => {
      const mockResult = {
        embedding: Array(384).fill(0),
        dimensions: 384,
        model: 'test-model',
        processingTime: 100
      };

      mockAdapter.generateEmbedding.mockResolvedValue(mockResult);

      const eventListener = vi.fn();
      eventEmitter.on('embeddingEvent', eventListener);

      await generator.generateEmbedding('test text');

      const call = (eventListener as any).mock.calls[0][0];
      expect(call.type).toBe('embeddingGenerated');
      expect(call.data.dimensions).toBe(384);
      expect(call.data.model).toBe('test-model');
      expect(call.data.cached).toBe(false);
    });
  });

  describe('Caching', () => {
    it('should cache embedding results', async () => {
      const mockResult = {
        embedding: Array(384).fill(0),
        dimensions: 384,
        model: 'test-model',
        processingTime: 100
      };

      mockAdapter.generateEmbedding.mockResolvedValue(mockResult);

      // First call should generate
      await generator.generateEmbedding('test text');
      expect(mockAdapter.generateEmbedding).toHaveBeenCalledTimes(1);

      // Second call should use cache
      await generator.generateEmbedding('test text');
      expect(mockAdapter.generateEmbedding).toHaveBeenCalledTimes(1);

      const stats = generator.getStats();
      expect(stats.cacheHits).toBe(1);
      expect(stats.cacheHitRate).toBe(0.5);
    });

    it('should emit cache hit events', async () => {
      const mockResult = {
        embedding: Array(384).fill(0),
        dimensions: 384,
        model: 'test-model',
        processingTime: 100
      };

      mockAdapter.generateEmbedding.mockResolvedValue(mockResult);

      const eventListener = vi.fn();
      eventEmitter.on('embeddingEvent', eventListener);

      // First call
      await generator.generateEmbedding('test text');

      // Second call (cached)
      await generator.generateEmbedding('test text');

      expect(eventListener).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'embeddingCacheHit',
          data: expect.objectContaining({
            text: 'test text',
            model: 'test-model'
          })
        })
      );
    });

    it('should clear cache', async () => {
      const mockResult = {
        embedding: Array(384).fill(0),
        dimensions: 384,
        model: 'test-model',
        processingTime: 100
      };

      mockAdapter.generateEmbedding.mockResolvedValue(mockResult);

      await generator.generateEmbedding('test text');
      expect(generator.getStats().cacheSize).toBe(1);

      generator.clearCache();
      expect(generator.getStats().cacheSize).toBe(0);
    });

    it('should work with caching disabled', async () => {
      const genNoCaching = new EmbeddingGenerator({
        model: 'test-model',
        dimensions: 384,
        provider: 'transformers',
        cacheResults: false
      });

      const mockResult = {
        embedding: Array(384).fill(0),
        dimensions: 384,
        model: 'test-model',
        processingTime: 100
      };

      mockAdapter.generateEmbedding.mockResolvedValue(mockResult);

      // Both calls should generate (no caching)
      await genNoCaching.generateEmbedding('test text');
      await genNoCaching.generateEmbedding('test text');

      expect(mockAdapter.generateEmbedding).toHaveBeenCalledTimes(2);
    });
  });

  describe('Batch Processing', () => {
    it('should generate batch embeddings', async () => {
      const mockResults = [
        {
          embedding: Array(384).fill(0),
          dimensions: 384,
          model: 'test-model',
          processingTime: 100
        },
        {
          embedding: Array(384).fill(1),
          dimensions: 384,
          model: 'test-model',
          processingTime: 100
        }
      ];

      mockAdapter.generateBatchEmbeddings.mockResolvedValue(mockResults);

      const results = await generator.generateBatchEmbeddings(['text1', 'text2']);

      // Expect enhanced results with forward compatibility fields
      expect(results).toEqual([
        {
          ...mockResults[0],
          version: '1.0',
          provider: 'transformers',
          metadata: {
            cacheHit: false,
            batchIndex: 0
          }
        },
        {
          ...mockResults[1],
          version: '1.0',
          provider: 'transformers',
          metadata: {
            cacheHit: false,
            batchIndex: 1
          }
        }
      ]);
      expect(mockAdapter.generateBatchEmbeddings).toHaveBeenCalledWith(['text1', 'text2']);
    });

    it('should validate batch input', async () => {
      await expect(generator.generateBatchEmbeddings([])).rejects.toThrow(EmbeddingError);
      await expect(generator.generateBatchEmbeddings(null as any)).rejects.toThrow(EmbeddingError);
      await expect(generator.generateBatchEmbeddings('not-array' as any)).rejects.toThrow(EmbeddingError);
    });

    it('should handle mixed cached and uncached texts', async () => {
      const mockResult1 = {
        embedding: Array(384).fill(0),
        dimensions: 384,
        model: 'test-model',
        processingTime: 100
      };

      const mockResult2 = {
        embedding: Array(384).fill(1),
        dimensions: 384,
        model: 'test-model',
        processingTime: 100
      };

      mockAdapter.generateEmbedding.mockResolvedValue(mockResult1);
      mockAdapter.generateBatchEmbeddings.mockResolvedValue([mockResult2]);

      // Cache first text
      await generator.generateEmbedding('text1');

      // Batch with cached and uncached
      const results = await generator.generateBatchEmbeddings(['text1', 'text2']);

      expect(results).toHaveLength(2);
      // First result should be from cache (enhanced when originally generated)
      expect(results[0].embedding).toEqual(mockResult1.embedding);
      expect(results[0].dimensions).toBe(384);
      expect(results[0].model).toBe('test-model');
      // Second result should be newly generated (enhanced)
      expect(results[1]).toEqual({
        ...mockResult2,
        version: '1.0',
        provider: 'transformers',
        metadata: {
          cacheHit: false,
          batchIndex: 0  // This is the first item in the batch processing
        }
      });
    });

    it('should emit batch events', async () => {
      const mockResults = [
        {
          embedding: Array(384).fill(0),
          dimensions: 384,
          model: 'test-model',
          processingTime: 100
        }
      ];

      mockAdapter.generateBatchEmbeddings.mockResolvedValue(mockResults);

      const eventListener = vi.fn();
      eventEmitter.on('embeddingEvent', eventListener);

      await generator.generateBatchEmbeddings(['text1']);

      const evt = (eventListener as any).mock.calls[0][0];
      expect(evt.type).toBe('batchEmbeddingGenerated');
      expect(evt.data.batchSize).toBe(1);
      expect(evt.data.cacheHits).toBe(0);
    });
  });

  describe('Model Management', () => {
    it('should preload model', async () => {
      mockAdapter.preloadModel.mockResolvedValue(undefined);

      await generator.preloadModel();

      expect(mockAdapter.preloadModel).toHaveBeenCalled();
    });

    it('should get model info', () => {
      const mockInfo = {
        dimensions: 384,
        maxLength: 512,
        isLoaded: true
      };

      mockAdapter.getModelInfo.mockReturnValue(mockInfo);

      const info = generator.getModelInfo();

      expect(info).toEqual(mockInfo);
      expect(mockAdapter.getModelInfo).toHaveBeenCalled();
    });

    it('should dispose resources', async () => {
      mockAdapter.dispose.mockResolvedValue(undefined);

      await generator.dispose();

      expect(mockAdapter.dispose).toHaveBeenCalled();
      expect(generator.getStats().cacheSize).toBe(0);
    });
  });

  describe('Error Handling', () => {
    it('should handle adapter errors', async () => {
      mockAdapter.generateEmbedding.mockRejectedValue(new Error('Adapter error'));

      await expect(generator.generateEmbedding('test text')).rejects.toThrow();
    });

    it('should handle preload errors', async () => {
      mockAdapter.preloadModel.mockRejectedValue(new Error('Preload error'));

      await expect(generator.preloadModel()).rejects.toThrow(EmbeddingError);
    });
  });
});
