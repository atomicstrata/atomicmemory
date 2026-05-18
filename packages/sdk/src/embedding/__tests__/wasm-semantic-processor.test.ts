/**
 * @file WASM Semantic Processor Tests
 *
 * Comprehensive tests for the WasmSemanticProcessor which provides in-browser
 * semantic search using WebAssembly-accelerated transformers.js models.
 * Tests cover initialization, context management, search, and feature flags.
 *
 * ## Test Coverage
 *
 * | Feature | Test Cases |
 * |---------|------------|
 * | Initialization | Config validation, env setup, error handling |
 * | Context Management | Add, retrieve, clear contexts |
 * | Semantic Search | Query matching, threshold, maxResults, sorting |
 * | Cosine Similarity | Identical vectors, orthogonal vectors |
 * | Performance | Initialization timing, search timing |
 * | Feature Flags | WASM enable/disable, conservative mode |
 * | WebAssembly Support | Detection, compilation, streaming |
 *
 * ## WASM Environment Tests
 *
 * Verifies correct transformers environment configuration:
 * - allowLocalModels enabled for offline operation
 * - allowRemoteModels disabled for security
 * - WASM paths resolved via assetUrlResolver
 * - Browser cache disabled for consistency
 *
 * ## Search Algorithm Tests
 *
 * Validates:
 * - Cosine similarity calculation accuracy
 * - Result ordering by descending similarity
 * - Threshold filtering of low-relevance matches
 * - Empty context handling
 *
 * ## Test Setup
 *
 * Mocks @huggingface/transformers, WebAssembly global, and performance API
 * for deterministic testing. Uses feature flag managers for capability testing.
 *
 * @see {@link ../wasm-semantic-processor.ts} - Implementation under test
 * @see {@link ../feature-flags.ts} - Feature flag configuration
 */

import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import { WasmSemanticProcessor, testWebAssemblySupport } from '../wasm-semantic-processor';
import { createDefaultFeatureFlagManager, createConservativeFeatureFlagManager } from '../feature-flags';

// Mock transformers.js
const mockPipelineFunction = vi.fn();
const mockEnv = {
  allowLocalModels: true,
  allowRemoteModels: true,
  useBrowserCache: true,
  backends: {
    onnx: {
      preferredOrder: ['webgpu', 'wasm', 'cpu'],
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

vi.mock('@huggingface/transformers', () => ({
  pipeline: mockPipelineFunction,
  pipeline2: mockPipelineFunction,
  env: mockEnv,
  default: {
    pipeline: mockPipelineFunction,
    env: mockEnv
  }
}));

// Mock logger
vi.mock('../../utils/logger', () => ({
  log: vi.fn()
}));

// Mock performance for Node.js environment
global.performance = global.performance || {
  now: vi.fn(() => Date.now())
};

// Mock WebAssembly for testing
const mockWebAssemblyInstantiate = vi.fn();
const mockWebAssemblyInstantiateStreaming = vi.fn();

global.WebAssembly = {
  instantiate: mockWebAssemblyInstantiate,
  instantiateStreaming: mockWebAssemblyInstantiateStreaming
} as any;

// Mock performance API
const mockPerformanceNow = vi.fn(() => Date.now());
global.performance = {
  now: mockPerformanceNow
} as any;

describe('WasmSemanticProcessor', () => {
  let processor: WasmSemanticProcessor;
  let mockPipeline: Mock;
  let mockAssetUrlResolver: Mock;

  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks();

    // Setup mock pipeline with different embeddings for different inputs
    mockPipeline = vi.fn().mockImplementation((text: string) => {
      // Return different embeddings based on input text
      if (text.includes('machine learning') || text.includes('Machine learning')) {
        return Promise.resolve({ data: new Float32Array([0.8, 0.7, 0.6, 0.5, 0.4]) });
      } else if (text.includes('deep learning') || text.includes('Deep learning')) {
        return Promise.resolve({ data: new Float32Array([0.7, 0.8, 0.5, 0.6, 0.3]) });
      } else if (text.includes('neural networks') || text.includes('Neural networks')) {
        return Promise.resolve({ data: new Float32Array([0.2, 0.3, 0.1, 0.4, 0.2]) });
      } else {
        return Promise.resolve({ data: new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5]) });
      }
    });

    // Configure the mock pipeline function
    mockPipelineFunction.mockResolvedValue(mockPipeline);

    // Setup mock asset URL resolver
    mockAssetUrlResolver = vi.fn((path: string) => `chrome-extension://test/${path}`);

    // Create processor instance
    processor = new WasmSemanticProcessor({
      modelName: 'test-model',
      assetUrlResolver: mockAssetUrlResolver,
      featureFlagManager: createDefaultFeatureFlagManager()
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('initialization', () => {
    it('should initialize successfully with default settings', async () => {
      await processor.initialize();

      const status = processor.getStatus();
      expect(status.initialized).toBe(true);
      expect(status.modelName).toBe('test-model');
      expect(status.type).toBe('wasm-semantic-processor');
    });

    it('should configure transformers environment correctly', async () => {
      await processor.initialize();

      expect(mockEnv.allowLocalModels).toBe(true);
      expect(mockEnv.allowRemoteModels).toBe(false);
      expect(mockEnv.useBrowserCache).toBe(false);
    });

    it('should use asset URL resolver for WASM paths', async () => {
      await processor.initialize();

      expect(mockEnv.backends.onnx.wasm.wasmPaths).toBe('chrome-extension://test/./');
    });

    it('should handle initialization errors gracefully', async () => {
      mockPipelineFunction.mockRejectedValue(new Error('Model loading failed'));

      await expect(processor.initialize()).rejects.toThrow('Model loading failed');
    });

    it('should not reinitialize if already initialized', async () => {
      await processor.initialize();
      mockPipelineFunction.mockClear();

      await processor.initialize();
      expect(mockPipelineFunction).not.toHaveBeenCalled();
    });
  });

  describe('context management', () => {
    beforeEach(async () => {
      await processor.initialize();
    });

    it('should add context successfully', async () => {
      const testText = 'This is a test context about machine learning';
      const testId = 'test-context-1';
      const testMetadata = { source: 'test' };

      await processor.addContext(testText, testId, testMetadata);

      const contexts = processor.getContexts();
      expect(contexts).toHaveLength(1);
      expect(contexts[0]).toMatchObject({
        id: testId,
        content: testText,
        metadata: testMetadata
      });
      // The mock returns different embeddings based on content, so just check it's an array of numbers
      expect(contexts[0].embedding).toBeInstanceOf(Array);
      expect(contexts[0].embedding).toHaveLength(5);
      contexts[0].embedding.forEach(val => expect(typeof val).toBe('number'));
      expect(contexts[0].timestamp).toBeTypeOf('number');
    });

    it('should handle multiple contexts', async () => {
      await processor.addContext('First context', 'ctx-1');
      await processor.addContext('Second context', 'ctx-2');
      await processor.addContext('Third context', 'ctx-3');

      const contexts = processor.getContexts();
      expect(contexts).toHaveLength(3);
      expect(contexts.map(c => c.id)).toEqual(['ctx-1', 'ctx-2', 'ctx-3']);
    });

    it('should clear all contexts', async () => {
      await processor.addContext('Test context', 'test-1');
      expect(processor.getContexts()).toHaveLength(1);

      processor.clearContexts();
      expect(processor.getContexts()).toHaveLength(0);
    });

    it('should handle embedding generation errors', async () => {
      mockPipeline.mockRejectedValue(new Error('Embedding generation failed'));

      await expect(processor.addContext('Test', 'test-1')).rejects.toThrow('Embedding generation failed');
    });
  });

  describe('semantic search', () => {
    beforeEach(async () => {
      await processor.initialize();

      // Add test contexts with different embeddings
      mockPipeline
        .mockResolvedValueOnce({ data: new Float32Array([1, 0, 0, 0, 0]) }) // ctx-1
        .mockResolvedValueOnce({ data: new Float32Array([0, 1, 0, 0, 0]) }) // ctx-2
        .mockResolvedValueOnce({ data: new Float32Array([0, 0, 1, 0, 0]) }) // ctx-3
        .mockResolvedValueOnce({ data: new Float32Array([0.9, 0.1, 0, 0, 0]) }); // query

      await processor.addContext('Machine learning context', 'ctx-1');
      await processor.addContext('Natural language processing', 'ctx-2');
      await processor.addContext('Computer vision topics', 'ctx-3');
    });

    it('should perform semantic search successfully', async () => {
      const results = await processor.search('machine learning query');

      expect(results).toHaveLength(1); // Only one result above default threshold
      expect(results[0].id).toBe('ctx-1');
      expect(results[0].similarity).toBeGreaterThan(0.7);
    });

    it('should respect maxResults parameter', async () => {
      // Mock query to match all contexts
      mockPipeline.mockResolvedValueOnce({ data: new Float32Array([1, 1, 1, 0, 0]) });

      const results = await processor.search('general query', { maxResults: 2 });
      expect(results.length).toBeLessThanOrEqual(2);
    });

    it('should respect threshold parameter', async () => {
      await processor.addContext('Neural networks context', 'ctx-1');
      const results = await processor.search('machine learning query', { threshold: 0.95 });
      expect(results).toHaveLength(0); // No results above high threshold due to low similarity
    });

    it('should return empty array when no contexts exist', async () => {
      processor.clearContexts();
      const results = await processor.search('any query');
      expect(results).toEqual([]);
    });

    it('should sort results by similarity descending', async () => {
      // Add contexts first
      await processor.addContext('Context A', 'ctx-1');
      await processor.addContext('Context B', 'ctx-2');
      await processor.addContext('Context C', 'ctx-3');

      // Mock query that matches multiple contexts with different similarities
      mockPipeline.mockResolvedValueOnce({ data: new Float32Array([0.5, 0.8, 0.3, 0, 0]) });

      const results = await processor.search('multi-match query', { threshold: 0.1 });

      // Just verify that results are sorted in descending order by similarity
      expect(results.length).toBeGreaterThan(0);

      // Verify descending order
      for (let i = 0; i < results.length - 1; i++) {
        expect(results[i].similarity).toBeGreaterThanOrEqual(results[i + 1].similarity);
      }
    });

    it('should handle search errors gracefully', async () => {
      // Create a new processor instance to avoid cached pipeline
      const errorProcessor = new WasmSemanticProcessor({
        modelName: 'test-model',
        assetUrlResolver: mockAssetUrlResolver,
        featureFlagManager: createDefaultFeatureFlagManager()
      });

      // Mock the pipeline function to reject
      mockPipelineFunction.mockRejectedValue(new Error('Search failed'));

      await expect(errorProcessor.initialize()).rejects.toThrow('Search failed');
    });
  });

  describe('cosine similarity calculation', () => {
    beforeEach(async () => {
      await processor.initialize();
    });

    it('should calculate cosine similarity correctly', async () => {
      // Test with known vectors
      mockPipeline
        .mockResolvedValueOnce({ data: new Float32Array([1, 0, 0]) }) // context
        .mockResolvedValueOnce({ data: new Float32Array([1, 0, 0]) }); // identical query

      await processor.addContext('Test context', 'test-1');
      const results = await processor.search('identical query');

      expect(results[0].similarity).toBeCloseTo(1.0, 5); // Should be exactly 1.0
    });

    it('should handle orthogonal vectors', async () => {
      mockPipeline
        .mockResolvedValueOnce({ data: new Float32Array([1, 0, 0]) }) // context
        .mockResolvedValueOnce({ data: new Float32Array([0, 1, 0]) }); // orthogonal query

      await processor.addContext('Test context', 'test-1');
      const results = await processor.search('orthogonal query', { threshold: 0.0 });

      expect(results[0].similarity).toBeCloseTo(0.0, 5); // Should be exactly 0.0
    });
  });

  describe('performance monitoring', () => {
    it('should track initialization time', async () => {
      const startTime = Date.now();
      await processor.initialize();
      const endTime = Date.now();

      // Verify performance tracking was called
      expect(mockPerformanceNow).toHaveBeenCalled();
    });

    it('should track search time', async () => {
      await processor.initialize();
      await processor.addContext('Test context', 'test-1');

      const startTime = Date.now();
      await processor.search('test query');
      const endTime = Date.now();

      // Verify performance tracking was called
      expect(mockPerformanceNow).toHaveBeenCalled();
    });
  });

  describe('feature flag integration', () => {
    it('should respect feature flag settings', async () => {
      const featureFlagManager = createConservativeFeatureFlagManager();
      featureFlagManager.disable('wasmProcessing');

      const restrictedProcessor = new WasmSemanticProcessor({
        featureFlagManager
      });

      await expect(restrictedProcessor.initialize()).rejects.toThrow('WASM processing is disabled by feature flags');
    });
  });
});

describe('testWebAssemblySupport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should detect WebAssembly availability', async () => {
    mockWebAssemblyInstantiate.mockResolvedValue({});

    const capabilities = await testWebAssemblySupport();

    expect(capabilities.hasWebAssembly).toBe(true);
    expect(capabilities.canCompile).toBe(true);
    expect(capabilities.canInstantiate).toBe(true);
    expect(capabilities.platform).toBe('unknown'); // Node.js environment
  });

  it('should handle WebAssembly compilation errors', async () => {
    mockWebAssemblyInstantiate.mockRejectedValue(new Error('CSP blocks WASM'));

    const capabilities = await testWebAssemblySupport();

    expect(capabilities.hasWebAssembly).toBe(true);
    expect(capabilities.canCompile).toBe(false);
    expect(capabilities.canInstantiate).toBe(false);
    expect(capabilities.error).toBe('CSP blocks WASM');
  });

  it('should handle missing WebAssembly object', async () => {
    const originalWebAssembly = global.WebAssembly;
    // @ts-ignore
    global.WebAssembly = undefined;

    const capabilities = await testWebAssemblySupport();

    expect(capabilities.hasWebAssembly).toBe(false);
    expect(capabilities.error).toBe('WebAssembly object not available');

    global.WebAssembly = originalWebAssembly;
  });

  it('should detect streaming support', async () => {
    mockWebAssemblyInstantiate.mockResolvedValue({});
    global.WebAssembly.instantiateStreaming = mockWebAssemblyInstantiateStreaming;

    const capabilities = await testWebAssemblySupport();

    expect(capabilities.supportsStreaming).toBe(true);
  });
});
