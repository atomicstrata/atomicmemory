/**
 * @file WASM Feature Flags (SDK Core Implementation)
 * Feature flag system for safe rollout of WASM functionality
 */

import { log } from '../utils/logger';

interface WasmFeatureFlags {
  // Core WASM features
  wasmProcessing: boolean;
  wasmCompilation: boolean;
  wasmStreaming: boolean;

  // Execution paths
  contentScriptExecution: boolean;
  backgroundExecution: boolean;
  offscreenExecution: boolean;

  // Fallback strategies
  javascriptFallback: boolean;
  remoteFallback: boolean;
  keywordFallback: boolean;

  // Performance features
  webgpuAcceleration: boolean;
  modelQuantization: boolean;
  batchProcessing: boolean;

  // Safety features
  cacheCorruptionDetection: boolean;
  automaticCachePurge: boolean;
  telemetryCollection: boolean;

  // Experimental features
  experimentalOptimizations: boolean;
  advancedCaching: boolean;
  predictiveLoading: boolean;
}

/**
 * WASM Feature Flag Manager
 */
export class WasmFeatureFlagManager {
  private flags: WasmFeatureFlags;
  private circuitBreakerState: {
    isOpen: boolean;
    errorCount: number;
    lastError: number;
    nextRetry: number;
  };

  constructor(initialFlags: Partial<WasmFeatureFlags> = {}) {
    this.flags = {
      // Default conservative settings
      wasmProcessing: true,
      wasmCompilation: true,
      wasmStreaming: true,
      contentScriptExecution: true,
      backgroundExecution: true,
      offscreenExecution: true,
      javascriptFallback: true,
      remoteFallback: false, // Disabled by default for privacy
      keywordFallback: true,
      webgpuAcceleration: false, // Disabled by default for stability
      modelQuantization: true, // Enable quantized models with fallback to non-quantized
      batchProcessing: false, // Disabled by default
      cacheCorruptionDetection: true,
      automaticCachePurge: true,
      telemetryCollection: true,
      experimentalOptimizations: false,
      advancedCaching: false,
      predictiveLoading: false,
      ...initialFlags,
    };

    this.circuitBreakerState = {
      isOpen: false,
      errorCount: 0,
      lastError: 0,
      nextRetry: 0,
    };
  }

  /**
   * Check if a feature is enabled
   */
  isEnabled(feature: keyof WasmFeatureFlags): boolean {
    // Check circuit breaker first
    if (this.isCircuitBreakerOpen()) {
      log(
        'FEATURE_FLAGS',
        'WasmFeatureFlagManager',
        `Circuit breaker open, disabling ${feature}`,
        'warn'
      );
      return false;
    }

    const enabled = this.flags[feature];
    log(
      'FEATURE_FLAGS',
      'WasmFeatureFlagManager',
      `Feature ${feature}: ${enabled ? 'enabled' : 'disabled'}`,
      'info'
    );
    return enabled;
  }

  /**
   * Enable a feature
   */
  enable(feature: keyof WasmFeatureFlags): void {
    this.flags[feature] = true;
    log(
      'FEATURE_FLAGS',
      'WasmFeatureFlagManager',
      `Feature enabled: ${feature}`,
      'info'
    );
  }

  /**
   * Disable a feature
   */
  disable(feature: keyof WasmFeatureFlags): void {
    this.flags[feature] = false;
    log(
      'FEATURE_FLAGS',
      'WasmFeatureFlagManager',
      `Feature disabled: ${feature}`,
      'warn'
    );
  }

  /**
   * Update multiple flags
   */
  updateFlags(newFlags: Partial<WasmFeatureFlags>): void {
    this.flags = { ...this.flags, ...newFlags };
    log(
      'FEATURE_FLAGS',
      'WasmFeatureFlagManager',
      'Feature flags updated',
      'info',
      newFlags
    );
  }

  /**
   * Check if circuit breaker is open
   */
  private isCircuitBreakerOpen(): boolean {
    const now = Date.now();

    // Check if we're in recovery period
    if (
      this.circuitBreakerState.isOpen &&
      now > this.circuitBreakerState.nextRetry
    ) {
      this.circuitBreakerState.isOpen = false;
      this.circuitBreakerState.errorCount = 0;
      log(
        'FEATURE_FLAGS',
        'WasmFeatureFlagManager',
        'Circuit breaker closed - attempting recovery',
        'info'
      );
    }

    return this.circuitBreakerState.isOpen;
  }

  /**
   * Record an error for circuit breaker
   */
  recordError(_error: Error): void {
    const now = Date.now();
    const TIME_WINDOW = 60000; // 1 minute
    const ERROR_THRESHOLD = 5;
    const RECOVERY_TIME = 300000; // 5 minutes

    // Reset error count if outside time window
    if (now - this.circuitBreakerState.lastError > TIME_WINDOW) {
      this.circuitBreakerState.errorCount = 0;
    }

    this.circuitBreakerState.errorCount++;
    this.circuitBreakerState.lastError = now;

    // Open circuit breaker if threshold exceeded
    if (this.circuitBreakerState.errorCount >= ERROR_THRESHOLD) {
      this.circuitBreakerState.isOpen = true;
      this.circuitBreakerState.nextRetry = now + RECOVERY_TIME;

      log(
        'FEATURE_FLAGS',
        'WasmFeatureFlagManager',
        'Circuit breaker opened due to errors',
        'error',
        {
          errorCount: this.circuitBreakerState.errorCount,
          threshold: ERROR_THRESHOLD,
          recoveryTime: RECOVERY_TIME,
        }
      );
    }
  }

  /**
   * Check performance guardrails
   */
  checkPerformanceGuardrails(metrics: {
    initTime?: number;
    searchTime?: number;
    memoryUsage?: number;
  }): boolean {
    const performanceGuardrails = {
      maxInitTime: 30000, // 30 seconds
      maxSearchTime: 5000, // 5 seconds
      maxMemoryUsage: 100 * 1024 * 1024, // 100MB
    };

    if (
      metrics.initTime &&
      metrics.initTime > performanceGuardrails.maxInitTime
    ) {
      log(
        'FEATURE_FLAGS',
        'WasmFeatureFlagManager',
        'Performance guardrail violated: init time',
        'warn',
        {
          actual: metrics.initTime,
          limit: performanceGuardrails.maxInitTime,
        }
      );
      return false;
    }

    if (
      metrics.searchTime &&
      metrics.searchTime > performanceGuardrails.maxSearchTime
    ) {
      log(
        'FEATURE_FLAGS',
        'WasmFeatureFlagManager',
        'Performance guardrail violated: search time',
        'warn',
        {
          actual: metrics.searchTime,
          limit: performanceGuardrails.maxSearchTime,
        }
      );
      return false;
    }

    if (
      metrics.memoryUsage &&
      metrics.memoryUsage > performanceGuardrails.maxMemoryUsage
    ) {
      log(
        'FEATURE_FLAGS',
        'WasmFeatureFlagManager',
        'Performance guardrail violated: memory usage',
        'warn',
        {
          actual: metrics.memoryUsage,
          limit: performanceGuardrails.maxMemoryUsage,
        }
      );
      return false;
    }

    return true;
  }

  /**
   * Get current feature flag status
   */
  getStatus() {
    return {
      flags: { ...this.flags },
      circuitBreaker: { ...this.circuitBreakerState },
      circuitBreakerOpen: this.isCircuitBreakerOpen(),
    };
  }

  /**
   * Reset circuit breaker
   */
  resetCircuitBreaker(): void {
    this.circuitBreakerState = {
      isOpen: false,
      errorCount: 0,
      lastError: 0,
      nextRetry: 0,
    };
    log(
      'FEATURE_FLAGS',
      'WasmFeatureFlagManager',
      'Circuit breaker reset',
      'info'
    );
  }
}

/**
 * Create default feature flag manager
 */
export function createDefaultFeatureFlagManager(): WasmFeatureFlagManager {
  return new WasmFeatureFlagManager();
}

/**
 * Create conservative feature flag manager for safe rollout
 */
export function createConservativeFeatureFlagManager(): WasmFeatureFlagManager {
  return new WasmFeatureFlagManager({
    wasmProcessing: true,
    wasmCompilation: true,
    wasmStreaming: false, // Disabled for compatibility
    contentScriptExecution: true,
    backgroundExecution: true,
    offscreenExecution: true,
    javascriptFallback: true,
    remoteFallback: false,
    keywordFallback: true,
    webgpuAcceleration: false, // Disabled for stability
    modelQuantization: true,
    batchProcessing: false, // Disabled for simplicity
    cacheCorruptionDetection: true,
    automaticCachePurge: true,
    telemetryCollection: true,
    experimentalOptimizations: false,
    advancedCaching: false,
    predictiveLoading: false,
  });
}
