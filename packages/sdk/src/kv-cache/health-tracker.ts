/**
 * @file Health Tracker
 *
 * This module handles health monitoring and status tracking for storage adapters.
 * It provides functionality for:
 * - Tracking adapter health status and metrics
 * - Recording operation successes and failures
 * - Managing health check intervals and deep checks
 * - Emitting health-related events
 *
 * @example
 * ```typescript
 * import { HealthTracker } from './health-tracker';
 *
 * const tracker = new HealthTracker(adapters, config, eventEmitter);
 * await tracker.initialize();
 * tracker.recordSuccess(adapter, responseTime);
 * ```
 */

import { StorageAdapter } from './storage-adapter';
import { StorageError } from '../core/error-handling/errors';
import { EventEmitter } from '../core/events';
import { getAdapterId } from './adapter-utils';
import { AdapterHealthStatus, HealthCheckConfig } from './types';

/**
 * Health tracker for monitoring storage adapter health
 */
export class HealthTracker {
  private healthStatus = new Map<string, AdapterHealthStatus>();
  private healthCheckInterval?: NodeJS.Timeout;
  private initialized = false;

  constructor(
    private adapters: StorageAdapter[],
    private config: HealthCheckConfig,
    private eventEmitter: EventEmitter
  ) {
    this.initializeHealthStatus();
  }

  /**
   * Initialize health tracking
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    this.startHealthMonitoring();
    this.initialized = true;
  }

  /**
   * Shutdown health tracking
   */
  async shutdown(): Promise<void> {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = undefined;
    }
    this.initialized = false;
  }

  /**
   * Get healthy adapters
   */
  getHealthyAdapters(): StorageAdapter[] {
    return this.adapters.filter(adapter => {
      const adapterId = getAdapterId(adapter);
      const health = this.healthStatus.get(adapterId);
      return health?.isHealthy && !health?.circuitBreakerOpen;
    });
  }

  /**
   * Get health status for all adapters
   */
  getHealthStatus(): Map<string, AdapterHealthStatus> {
    return new Map(this.healthStatus);
  }

  /**
   * Get health status for a specific adapter
   */
  getAdapterHealth(adapter: StorageAdapter): AdapterHealthStatus | undefined {
    const adapterId = getAdapterId(adapter);
    return this.healthStatus.get(adapterId);
  }

  /**
   * Record successful operation
   */
  recordSuccess(adapter: StorageAdapter, responseTime: number): void {
    const adapterId = getAdapterId(adapter);
    const health = this.healthStatus.get(adapterId);

    if (health) {
      health.totalOperations++;
      health.consecutiveFailures = 0;
      health.lastHealthCheck = Date.now();
      health.averageResponseTime = this.updateAverageResponseTime(
        health.averageResponseTime,
        responseTime,
        health.totalOperations
      );

      // Update failure rate
      health.failureRate = health.failedOperations / health.totalOperations;

      // Mark as healthy if it was previously unhealthy
      if (!health.isHealthy) {
        health.isHealthy = true;
        this.eventEmitter.emit('adapterRecovered', {
          adapterId,
          totalOperations: health.totalOperations,
          failureRate: health.failureRate,
        });
      }
    }
  }

  /**
   * Record failed operation
   */
  recordFailure(
    adapter: StorageAdapter,
    error: Error,
    responseTime?: number
  ): void {
    const adapterId = getAdapterId(adapter);
    const health = this.healthStatus.get(adapterId);

    if (health) {
      health.totalOperations++;
      health.failedOperations++;
      health.consecutiveFailures++;
      health.lastError = {
        message: error.message,
        code: error instanceof StorageError ? error.code : 'UNKNOWN_ERROR',
        timestamp: Date.now(),
      };

      if (responseTime) {
        health.averageResponseTime = this.updateAverageResponseTime(
          health.averageResponseTime,
          responseTime,
          health.totalOperations
        );
      }

      // Update failure rate
      health.failureRate = health.failedOperations / health.totalOperations;

      // Mark as unhealthy if consecutive failures exceed threshold
      if (health.consecutiveFailures >= this.config.failureThreshold) {
        health.isHealthy = false;
        this.eventEmitter.emit('adapterUnhealthy', {
          adapterId,
          consecutiveFailures: health.consecutiveFailures,
          failureRate: health.failureRate,
        });
      }
    }
  }

  /**
   * Perform health check on all adapters
   */
  async performHealthCheck(): Promise<void> {
    const healthCheckPromises = this.adapters.map(adapter =>
      this.checkAdapterHealth(adapter)
    );

    await Promise.allSettled(healthCheckPromises);
  }

  /**
   * Initialize health status for all adapters
   */
  private initializeHealthStatus(): void {
    for (const adapter of this.adapters) {
      const adapterId = getAdapterId(adapter);
      const health: AdapterHealthStatus = {
        adapterId,
        isHealthy: true,
        lastHealthCheck: Date.now(),
        consecutiveFailures: 0,
        totalOperations: 0,
        failedOperations: 0,
        failureRate: 0,
        averageResponseTime: 0,
        circuitBreakerOpen: false,
      };
      this.healthStatus.set(adapterId, health);
    }
  }

  /**
   * Start health monitoring interval
   */
  private startHealthMonitoring(): void {
    this.healthCheckInterval = setInterval(
      () => this.performHealthCheck(),
      this.config.interval
    );
  }

  /**
   * Check health of a specific adapter
   */
  private async checkAdapterHealth(adapter: StorageAdapter): Promise<void> {
    const adapterId = getAdapterId(adapter);
    const health = this.healthStatus.get(adapterId);

    if (!health) return;

    const startTime = Date.now();
    try {
      // Perform basic availability check
      const isAvailable = adapter.isAvailable();

      if (this.config.deepCheck) {
        // Perform deep health check with actual operation
        const testKey = `__health_check_${Date.now()}`;
        await adapter.set(testKey, 'health_check');
        await adapter.get(testKey);
        await adapter.delete(testKey);
      }

      const responseTime = Date.now() - startTime;

      if (isAvailable) {
        health.isHealthy = true;
        health.lastHealthCheck = Date.now();
        health.consecutiveFailures = 0;
        this.recordSuccess(adapter, responseTime);
      } else {
        throw new Error('Adapter not available');
      }
    } catch (error) {
      // Use the same startTime reference to compute response time on failure
      const responseTime = Math.max(0, Date.now() - startTime);
      this.recordFailure(
        adapter,
        error instanceof Error ? error : new Error(String(error)),
        responseTime
      );
    }
  }

  /**
   * Update average response time using exponential moving average
   */
  private updateAverageResponseTime(
    current: number,
    newValue: number,
    totalOps: number
  ): number {
    if (totalOps === 1) return newValue;
    const alpha = 0.1; // Smoothing factor
    return current * (1 - alpha) + newValue * alpha;
  }
}
