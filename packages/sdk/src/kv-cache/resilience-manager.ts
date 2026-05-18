/**
 * @file Storage Resilience Manager
 *
 * This file provides resilience capabilities for the storage system including:
 * - Health monitoring and circuit breaker patterns
 * - Write quorum enforcement
 * - Background repair of failed operations
 * - Adapter failure detection and recovery
 *
 * The resilience manager coordinates between specialized modules:
 * - HealthTracker: monitors adapter health and metrics
 * - CircuitBreaker: manages circuit breaker patterns
 * - RepairManager: handles background repair operations
 *
 * @example
 * ```typescript
 * import { ResilienceManager } from './resilience-manager';
 *
 * const resilience = new ResilienceManager(adapters, config);
 * await resilience.initialize();
 *
 * const healthyAdapters = resilience.getHealthyAdapters();
 * ```
 */

import { StorageAdapter } from './storage-adapter';
import { EventEmitter } from '../core/events';
import { HealthTracker } from './health-tracker';
import { CircuitBreaker } from './circuit-breaker';
import { RepairManager } from './repair-manager';
import { getAdapterId } from './adapter-utils';
import {
  AdapterHealthStatus,
  ResilienceConfig,
  FailedOperation,
} from './types';

/**
 * Default resilience configuration
 */
const DEFAULT_RESILIENCE_CONFIG: ResilienceConfig = {
  circuitBreaker: {
    failureThreshold: 0.5, // 50% failure rate
    minimumOperations: 10,
    timeout: 30000, // 30 seconds
    testOperations: 3,
  },
  healthCheck: {
    interval: 30000, // 30 seconds
    timeout: 5000, // 5 seconds
    failureThreshold: 3,
    deepCheck: false,
  },
  quorum: {
    writeQuorum: 1,
    readQuorum: 1,
    requirePrimary: false,
    timeout: 10000, // 10 seconds
  },
  repair: {
    enabled: true,
    interval: 60000, // 1 minute
    batchSize: 10,
    maxAge: 3600000, // 1 hour
    maxAttempts: 3,
    maxQueueSize: 1000, // Maximum 1000 failed operations in memory
    evictionPolicy: 'oldest', // Evict oldest operations when queue is full
  },
};

/**
 * Manages storage resilience including health monitoring, circuit breakers, and repair
 */
export class ResilienceManager {
  private healthTracker: HealthTracker;
  private circuitBreaker: CircuitBreaker;
  private repairManager: RepairManager;
  private initialized = false;
  private eventEmitter: EventEmitter;

  constructor(
    private adapters: StorageAdapter[],
    private config: ResilienceConfig = DEFAULT_RESILIENCE_CONFIG,
    eventEmitter?: EventEmitter
  ) {
    // Merge with defaults
    this.config = {
      ...DEFAULT_RESILIENCE_CONFIG,
      ...config,
      circuitBreaker: {
        ...DEFAULT_RESILIENCE_CONFIG.circuitBreaker,
        ...config.circuitBreaker,
      },
      healthCheck: {
        ...DEFAULT_RESILIENCE_CONFIG.healthCheck,
        ...config.healthCheck,
      },
      quorum: { ...DEFAULT_RESILIENCE_CONFIG.quorum, ...config.quorum },
      repair: { ...DEFAULT_RESILIENCE_CONFIG.repair, ...config.repair },
    };

    this.eventEmitter = eventEmitter || new EventEmitter();

    // Initialize specialized modules
    this.healthTracker = new HealthTracker(
      this.adapters,
      this.config.healthCheck,
      this.eventEmitter
    );
    this.circuitBreaker = new CircuitBreaker(
      this.config.circuitBreaker,
      this.eventEmitter
    );
    this.repairManager = new RepairManager(
      this.config.repair,
      this.eventEmitter,
      this.healthTracker
    );
  }

  /**
   * Initialize the resilience manager
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    await this.healthTracker.initialize();
    await this.repairManager.initialize();

    this.initialized = true;
  }

  /**
   * Shutdown the resilience manager
   */
  async shutdown(): Promise<void> {
    await this.healthTracker.shutdown();
    await this.repairManager.shutdown();

    this.initialized = false;
  }

  /**
   * Get adapters that are currently healthy and available
   */
  getHealthyAdapters(): StorageAdapter[] {
    return this.healthTracker.getHealthyAdapters();
  }

  /**
   * Check if write quorum can be satisfied
   */
  canSatisfyWriteQuorum(): boolean {
    const healthyAdapters = this.getHealthyAdapters();
    const quorum = this.config.quorum.writeQuorum;

    if (this.config.quorum.requirePrimary && healthyAdapters.length > 0) {
      // Check if primary adapter (first in list) is healthy
      const primaryAdapter = this.adapters[0];
      const primaryHealth = this.healthTracker.getAdapterHealth(primaryAdapter);
      if (!primaryHealth?.isHealthy || primaryHealth?.circuitBreakerOpen) {
        return false;
      }
    }

    return healthyAdapters.length >= quorum;
  }

  /**
   * Check if read quorum can be satisfied
   */
  canSatisfyReadQuorum(): boolean {
    const healthyAdapters = this.getHealthyAdapters();
    return healthyAdapters.length >= this.config.quorum.readQuorum;
  }

  /**
   * Record a successful operation for health tracking
   */
  recordSuccess(adapter: StorageAdapter, responseTime: number): void {
    this.healthTracker.recordSuccess(adapter, responseTime);

    const adapterId = getAdapterId(adapter);
    const health = this.healthTracker.getAdapterHealth(adapter);
    if (health) {
      this.circuitBreaker.recordSuccess(adapterId, health);
    }
  }

  /**
   * Record a failed operation for health tracking
   */
  recordFailure(
    adapter: StorageAdapter,
    error: Error,
    responseTime?: number
  ): void {
    this.healthTracker.recordFailure(adapter, error, responseTime);

    const adapterId = getAdapterId(adapter);
    const health = this.healthTracker.getAdapterHealth(adapter);
    if (health) {
      this.circuitBreaker.recordFailure(adapterId, health);
    }
  }

  /**
   * Record a failed operation for later repair
   */
  recordFailedOperation(
    type: 'set' | 'delete',
    key: string,
    value: unknown,
    options: unknown,
    failedAdapters: StorageAdapter[]
  ): void {
    const operationId = this.generateOperationId();
    const failedOperation: FailedOperation = {
      id: operationId,
      type,
      key,
      value,
      options,
      failedAdapters: failedAdapters.map(adapter => getAdapterId(adapter)),
      timestamp: Date.now(),
      repairAttempts: 0,
    };

    this.repairManager.recordFailedOperation(failedOperation);

    this.eventEmitter.emit('operationFailed', {
      operationId,
      type,
      key,
      failedAdapters: failedOperation.failedAdapters,
    });
  }

  /**
   * Get health status for all adapters
   */
  getHealthStatus(): Map<string, AdapterHealthStatus> {
    return this.healthTracker.getHealthStatus();
  }

  /**
   * Get health status for a specific adapter
   */
  getAdapterHealth(adapter: StorageAdapter): AdapterHealthStatus | undefined {
    return this.healthTracker.getAdapterHealth(adapter);
  }

  /**
   * Force a health check for all adapters
   */
  async performHealthCheck(): Promise<void> {
    await this.healthTracker.performHealthCheck();
  }

  /**
   * Generate unique operation ID
   */
  private generateOperationId(): string {
    return `op_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
  }
}
