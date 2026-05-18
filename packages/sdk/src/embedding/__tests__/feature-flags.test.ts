/**
 * @file Unit Tests for WASM Feature Flags
 * Tests feature flag management, circuit breaker, and rollout functionality
 */

import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import {
  WasmFeatureFlagManager,
  createDefaultFeatureFlagManager,
  createConservativeFeatureFlagManager
} from '../feature-flags';

// Mock logger
vi.mock('../../utils/logger', () => ({
  log: vi.fn()
}));

// Mock Math.random for predictable rollout testing
const mockMathRandom = vi.fn();
global.Math.random = mockMathRandom;

// Mock window.location for platform detection
Object.defineProperty(global, 'window', {
  value: {
    location: {
      hostname: 'test.example.com'
    }
  },
  writable: true
});

describe('WasmFeatureFlagManager', () => {
  let manager: WasmFeatureFlagManager;

  beforeEach(() => {
    vi.clearAllMocks();
    mockMathRandom.mockReturnValue(0.5); // 50% for predictable testing

    manager = new WasmFeatureFlagManager();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('feature flag management', () => {
    it('should initialize with default flags', () => {
      const status = manager.getStatus();

      expect(status.flags.wasmProcessing).toBe(true);
      expect(status.flags.wasmCompilation).toBe(true);
      expect(status.flags.javascriptFallback).toBe(true);
      expect(status.flags.remoteFallback).toBe(false); // Disabled by default
      expect(status.flags.telemetryCollection).toBe(true);
    });

    it('should allow enabling features', () => {
      manager.disable('wasmProcessing');
      expect(manager.isEnabled('wasmProcessing')).toBe(false);

      manager.enable('wasmProcessing');
      expect(manager.isEnabled('wasmProcessing')).toBe(true);
    });

    it('should allow disabling features', () => {
      expect(manager.isEnabled('wasmProcessing')).toBe(true);

      manager.disable('wasmProcessing');
      expect(manager.isEnabled('wasmProcessing')).toBe(false);
    });

    it('should update multiple flags at once', () => {
      manager.updateFlags({
        wasmProcessing: false,
        webgpuAcceleration: true,
        experimentalOptimizations: true
      });

      expect(manager.isEnabled('wasmProcessing')).toBe(false);
      expect(manager.isEnabled('webgpuAcceleration')).toBe(true);
      expect(manager.isEnabled('experimentalOptimizations')).toBe(true);
    });
  });



  describe('circuit breaker', () => {
    it('should open circuit breaker after error threshold', () => {
      const error = new Error('Test error');

      // Record errors up to threshold (default: 5)
      for (let i = 0; i < 4; i++) {
        manager.recordError(error);
        expect(manager.isEnabled('wasmProcessing')).toBe(true);
      }

      // Fifth error should open circuit breaker
      manager.recordError(error);
      expect(manager.isEnabled('wasmProcessing')).toBe(false);
    });

    it('should reset error count after time window', () => {
      const error = new Error('Test error');

      // Mock Date.now to control time
      const mockNow = vi.spyOn(Date, 'now');
      mockNow.mockReturnValue(1000);

      // Record some errors
      manager.recordError(error);
      manager.recordError(error);

      // Move time forward beyond time window (default: 60000ms)
      mockNow.mockReturnValue(70000);

      // Record another error - should reset count
      manager.recordError(error);
      expect(manager.isEnabled('wasmProcessing')).toBe(true);

      mockNow.mockRestore();
    });

    it('should close circuit breaker after recovery time', () => {
      const error = new Error('Test error');
      const mockNow = vi.spyOn(Date, 'now');

      // Open circuit breaker
      mockNow.mockReturnValue(1000);
      for (let i = 0; i < 5; i++) {
        manager.recordError(error);
      }
      expect(manager.isEnabled('wasmProcessing')).toBe(false);

      // Move time forward beyond recovery time (default: 300000ms)
      mockNow.mockReturnValue(400000);
      expect(manager.isEnabled('wasmProcessing')).toBe(true);

      mockNow.mockRestore();
    });

    it('should allow manual circuit breaker reset', () => {
      const error = new Error('Test error');

      // Open circuit breaker
      for (let i = 0; i < 5; i++) {
        manager.recordError(error);
      }
      expect(manager.isEnabled('wasmProcessing')).toBe(false);

      // Reset manually
      manager.resetCircuitBreaker();
      expect(manager.isEnabled('wasmProcessing')).toBe(true);
    });
  });

  describe('performance guardrails', () => {
    it('should pass when metrics are within limits', () => {
      const result = manager.checkPerformanceGuardrails({
        initTime: 5000,    // 5 seconds (limit: 30s)
        searchTime: 1000,  // 1 second (limit: 5s)
        memoryUsage: 50 * 1024 * 1024 // 50MB (limit: 100MB)
      });

      expect(result).toBe(true);
    });

    it('should fail when init time exceeds limit', () => {
      const result = manager.checkPerformanceGuardrails({
        initTime: 35000 // 35 seconds (limit: 30s)
      });

      expect(result).toBe(false);
    });

    it('should fail when search time exceeds limit', () => {
      const result = manager.checkPerformanceGuardrails({
        searchTime: 6000 // 6 seconds (limit: 5s)
      });

      expect(result).toBe(false);
    });

    it('should fail when memory usage exceeds limit', () => {
      const result = manager.checkPerformanceGuardrails({
        memoryUsage: 150 * 1024 * 1024 // 150MB (limit: 100MB)
      });

      expect(result).toBe(false);
    });

    it('should handle partial metrics', () => {
      const result = manager.checkPerformanceGuardrails({
        initTime: 5000 // Only init time provided
      });

      expect(result).toBe(true);
    });
  });

  describe('status reporting', () => {
    it('should provide comprehensive status', () => {
      const status = manager.getStatus();

      expect(status).toHaveProperty('flags');
      expect(status).toHaveProperty('circuitBreaker');
      expect(status).toHaveProperty('circuitBreakerOpen');

      expect(typeof status.circuitBreakerOpen).toBe('boolean');
    });

    it('should reflect current circuit breaker state', () => {
      const error = new Error('Test error');

      let status = manager.getStatus();
      expect(status.circuitBreakerOpen).toBe(false);

      // Open circuit breaker
      for (let i = 0; i < 5; i++) {
        manager.recordError(error);
      }

      status = manager.getStatus();
      expect(status.circuitBreakerOpen).toBe(true);
    });
  });


});

describe('factory functions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMathRandom.mockReturnValue(0.5);
  });

  describe('createDefaultFeatureFlagManager', () => {
    it('should create manager with default settings', () => {
      const manager = createDefaultFeatureFlagManager();
      const status = manager.getStatus();

      expect(status.flags.webgpuAcceleration).toBe(false); // Conservative default
      expect(status.flags.wasmProcessing).toBe(true); // Enabled by default
    });
  });

  describe('createConservativeFeatureFlagManager', () => {
    it('should create manager with conservative settings', () => {
      const manager = createConservativeFeatureFlagManager();
      const status = manager.getStatus();

      expect(status.flags.webgpuAcceleration).toBe(false); // Disabled for stability
      expect(status.flags.experimentalOptimizations).toBe(false); // Disabled
      expect(status.flags.wasmProcessing).toBe(true); // Still enabled even in conservative mode
    });
  });
});
