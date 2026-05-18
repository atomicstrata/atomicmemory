/**
 * @file Unit Tests for Cache Safety Manager
 * Tests cache corruption detection and recovery mechanisms
 */

import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import { CacheSafetyManager, createCacheSafetyManager } from '../cache-safety';

// Mock logger
vi.mock('../../utils/logger', () => ({
  log: vi.fn()
}));

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock caches API
const mockCache = {
  delete: vi.fn(),
  match: vi.fn(),
  put: vi.fn()
};

const mockCaches = {
  keys: vi.fn().mockResolvedValue(['cache1', 'cache2']),
  open: vi.fn().mockResolvedValue(mockCache)
};

global.caches = mockCaches as any;

describe('CacheSafetyManager', () => {
  let manager: CacheSafetyManager;
  let mockAssetUrlResolver: Mock;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    vi.clearAllMocks();

    // Store original fetch
    originalFetch = global.fetch;

    // Setup mock asset URL resolver
    mockAssetUrlResolver = vi.fn((path: string) => `chrome-extension://test/${path}`);

    // Create manager instance
    manager = new CacheSafetyManager({
      assetUrlResolver: mockAssetUrlResolver
    });
  });

  afterEach(() => {
    // Restore original fetch
    global.fetch = originalFetch;
    manager.uninstallInterceptor();
    vi.restoreAllMocks();
  });

  describe('fetch interceptor', () => {
    it('should install fetch interceptor', () => {
      expect(manager.getStatus().interceptorInstalled).toBe(false);

      manager.installInterceptor();

      expect(manager.getStatus().interceptorInstalled).toBe(true);
      expect(global.fetch).not.toBe(originalFetch);
    });

    it('should uninstall fetch interceptor', () => {
      manager.installInterceptor();
      expect(global.fetch).not.toBe(originalFetch);

      manager.uninstallInterceptor();

      expect(manager.getStatus().interceptorInstalled).toBe(false);
      expect(global.fetch).toBe(originalFetch);
    });

    it('should not reinstall if already installed', () => {
      manager.installInterceptor();
      const interceptedFetch = global.fetch;

      manager.installInterceptor();

      expect(global.fetch).toBe(interceptedFetch);
    });
  });

  describe('asset URL detection', () => {
    beforeEach(() => {
      manager.installInterceptor();
    });

    it('should detect chrome-extension URLs as asset URLs', async () => {
      mockFetch.mockResolvedValue(new Response('test content', {
        headers: { 'content-type': 'application/json' }
      }));

      await fetch('chrome-extension://test/models/config.json');

      expect(mockFetch).toHaveBeenCalledWith('chrome-extension://test/models/config.json', undefined);
    });

    it('should detect /models/ paths as asset URLs', async () => {
      mockFetch.mockResolvedValue(new Response('test content', {
        headers: { 'content-type': 'application/json' }
      }));

      await fetch('/models/tokenizer.json');

      // Should resolve the URL using asset resolver
      expect(mockAssetUrlResolver).toHaveBeenCalledWith('models/tokenizer.json');
    });

    it('should pass through non-asset URLs unchanged', async () => {
      mockFetch.mockResolvedValue(new Response('test content'));

      await fetch('https://example.com/api/data');

      expect(mockFetch).toHaveBeenCalledWith('https://example.com/api/data', undefined);
    });
  });

  describe('model file detection', () => {
    beforeEach(() => {
      manager.installInterceptor();
    });

    it('should detect model files', async () => {
      const modelFiles = [
        'tokenizer.json',
        'config.json',
        'model.onnx',
        'vocab.txt'
      ];

      mockFetch.mockResolvedValue(new Response('test content'));

      for (const file of modelFiles) {
        await fetch(`https://example.com/${file}`);
        expect(mockAssetUrlResolver).toHaveBeenCalledWith(`models/all-MiniLM-L6-v2/${file}`);
      }
    });

    it('should not redirect non-model files', async () => {
      mockFetch.mockResolvedValue(new Response('test content'));

      await fetch('https://example.com/other-file.txt');

      expect(mockAssetUrlResolver).not.toHaveBeenCalled();
      expect(mockFetch).toHaveBeenCalledWith('https://example.com/other-file.txt', undefined);
    });
  });

  describe('cache corruption detection', () => {
    beforeEach(() => {
      manager.installInterceptor();
    });

    it('should detect HTML content in JSON files', async () => {
      const htmlResponse = new Response('<!DOCTYPE html><html><body>Error</body></html>', {
        headers: { 'content-type': 'text/html' }
      });

      mockFetch.mockResolvedValueOnce(htmlResponse);

      const response = await fetch('chrome-extension://test/models/config.json');

      // Should have attempted to purge cache and retry
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should detect HTML content type for binary files', async () => {
      const htmlResponse = new Response('<!DOCTYPE html><html><body>Error</body></html>', {
        headers: { 'content-type': 'text/html' }
      });

      mockFetch.mockResolvedValueOnce(htmlResponse);

      const response = await fetch('chrome-extension://test/models/model.onnx');

      // Should have attempted to purge cache and retry
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should not flag valid responses as corrupted', async () => {
      const validResponse = new Response('{"valid": "json"}', {
        headers: { 'content-type': 'application/json' }
      });

      mockFetch.mockResolvedValue(validResponse);

      const response = await fetch('chrome-extension://test/models/config.json');

      // Should only call fetch once (no retry)
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('cache purging', () => {
    beforeEach(() => {
      manager.installInterceptor();
    });

    it('should purge corrupted cache entries', async () => {
      const corruptedResponse = new Response('<!DOCTYPE html>', {
        headers: { 'content-type': 'text/html' }
      });
      const validResponse = new Response('{"valid": "json"}', {
        headers: { 'content-type': 'application/json' }
      });

      mockFetch
        .mockResolvedValueOnce(corruptedResponse)
        .mockResolvedValueOnce(validResponse);

      await fetch('chrome-extension://test/models/config.json');

      // Should have attempted a cache purge and retried fetch
      expect(mockCaches.open).toHaveBeenCalled();
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should clear transformers cache if available', async () => {
      // Mock transformers cache
      (global as any).window = {
        transformersCache: {
          'chrome-extension://test/models/config.json': 'cached-data'
        }
      };

      const corruptedResponse = new Response('<!DOCTYPE html>', {
        headers: { 'content-type': 'text/html' }
      });
      const validResponse = new Response('{"valid": "json"}', {
        headers: { 'content-type': 'application/json' }
      });

      mockFetch
        .mockResolvedValueOnce(corruptedResponse)
        .mockResolvedValueOnce(validResponse);

      await fetch('chrome-extension://test/models/config.json');

      // Should have cleared transformers cache
      expect((global as any).window.transformersCache['chrome-extension://test/models/config.json']).toBeUndefined();
    });
  });

  describe('URL resolution', () => {
    beforeEach(() => {
      manager.installInterceptor();
    });

    it('should fix malformed URLs', async () => {
      mockFetch.mockResolvedValue(new Response('test'));

      await fetch('/models/chrome-extension://test/config.json');

      // Should have fixed the malformed URL
      expect(mockFetch).toHaveBeenCalledWith('chrome-extension://test/config.json', undefined);
    });

    it('should resolve relative model paths', async () => {
      mockFetch.mockResolvedValue(new Response('test'));

      await fetch('/models/all-MiniLM-L6-v2/config.json');

      // Should have resolved using asset resolver
      expect(mockAssetUrlResolver).toHaveBeenCalledWith('models/all-MiniLM-L6-v2/config.json');
    });
  });

  describe('cache safety testing', () => {
    it('should test cache safety functionality', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('config.json')) {
          return Promise.resolve(new Response('{"test": true}', {
            status: 200,
            headers: { 'content-type': 'application/json' }
          }));
        }
        return Promise.resolve(new Response('Not found', { status: 404 }));
      });

      const testResults = await manager.testCacheSafety();

      expect(testResults.interceptorInstalled).toBe(false); // Not installed by default
      expect(testResults.testResults).toHaveLength(3); // 3 test URLs

      // Check that at least one test passed
      const successfulTests = testResults.testResults.filter(r => r.status === 200);
      expect(successfulTests.length).toBeGreaterThan(0);
    });

    it('should handle test errors gracefully', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      const testResults = await manager.testCacheSafety();

      expect(testResults.testResults).toHaveLength(3);
      testResults.testResults.forEach(result => {
        expect(result.status).toBe(-1);
        expect(result.error).toBe('Network error');
      });
    });
  });

  describe('factory function', () => {
    it('should create cache safety manager with asset resolver', () => {
      const resolver = (path: string) => `test://${path}`;
      const manager = createCacheSafetyManager(resolver);

      expect(manager.getStatus().hasAssetUrlResolver).toBe(true);
    });

    it('should create cache safety manager without asset resolver', () => {
      const manager = createCacheSafetyManager();

      expect(manager.getStatus().hasAssetUrlResolver).toBe(false);
    });
  });
});
