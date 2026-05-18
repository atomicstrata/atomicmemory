/**
 * @file StorageManager - Modern Implementation
 *
 * Clean, retry-first storage manager with resilience built-in from the ground up.
 * No legacy compatibility - designed for modern, fault-tolerant storage operations.
 */

import { StorageAdapter, BatchOperation } from './storage-adapter';
import { StorageError } from '../core/error-handling/errors';
import { EventEmitter } from '../core/events';
import { ResilienceManager } from './resilience-manager';
import { RetryEngine } from './retry-engine';
import {
  ResilienceConfig,
  AdapterHealthStatus,
  StorageSetOptions,
} from './types';
import { StorageValidator } from './validation';
import { getLogger, type Logger } from '../utils/logger';

/**
 * Batch operation types for forward compatibility
 */
type BatchOperationType = 'set' | 'delete';


/**
 * Clean configuration for modern StorageManager
 * All properties support partial configuration for forward compatibility
 */
interface StorageManagerConfig {
  operationTimeout: number;
  collectErrors: boolean;
  resilience: Partial<ResilienceConfig>;
  retryPolicy: {
    maxAttempts: number;
    initialDelay: number;
    maxDelay: number;
    backoffMultiplier: number;
    jitterFactor: number;
    maxTotalDuration?: number; // Maximum total time for all retry attempts
  };
}

/**
 * Default configuration optimized for reliability
 */
const DEFAULT_CONFIG: StorageManagerConfig = {
  operationTimeout: 5000,
  collectErrors: true,
  resilience: {
    healthCheck: {
      interval: 30000,
      timeout: 5000,
      failureThreshold: 3,
      deepCheck: false,
    },
    circuitBreaker: {
      failureThreshold: 0.5,
      minimumOperations: 5,
      timeout: 60000,
      testOperations: 3,
    },
    quorum: {
      writeQuorum: 1,
      readQuorum: 1,
      requirePrimary: false,
      timeout: 5000,
    },
    repair: {
      enabled: true,
      interval: 60000,
      batchSize: 10,
      maxAge: 300000,
      maxAttempts: 3,
      maxQueueSize: 500, // Smaller default for storage manager
      evictionPolicy: 'oldest',
    },
  },
  retryPolicy: {
    maxAttempts: 3,
    initialDelay: 1000,
    maxDelay: 10000,
    backoffMultiplier: 2,
    jitterFactor: 0.1,
    maxTotalDuration: 30000, // 30 seconds total retry time limit
  },
};

/**
 * Modern StorageManager with built-in resilience and retry-first design
 */
export class StorageManager {
  private adapters: StorageAdapter[] = [];
  private config: StorageManagerConfig;
  private eventEmitter: EventEmitter;
  private resilienceManager: ResilienceManager;
  private retryEngine: RetryEngine;
  private validator: StorageValidator;
  private logger: Logger;
  private initialized = false;

  constructor(
    adapters: StorageAdapter[],
    config: Partial<StorageManagerConfig> = {},
    eventEmitter?: EventEmitter
  ) {
    this.adapters = adapters;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.eventEmitter = eventEmitter || new EventEmitter();
    this.resilienceManager = new ResilienceManager(
      adapters,
      this.config.resilience as ResilienceConfig,
      this.eventEmitter
    );

    // Initialize validator with default configuration
    // Will be updated with adapter capabilities after initialization
    this.validator = new StorageValidator();

    // Initialize logger
    this.logger = getLogger('StorageManager');

    this.retryEngine = new RetryEngine(
      { retryPolicy: this.config.retryPolicy, collectErrors: this.config.collectErrors },
      this.eventEmitter,
      this.logger,
    );
  }

  /**
   * Initialize the storage manager and all adapters
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      this.logger.debug('Storage manager already initialized');
      return;
    }

    this.logger.info('Initializing storage manager', {
      component: 'storage-manager',
      operation: 'initialize',
      adapterCount: this.adapters.length,
    });

    const initPromises = this.adapters.map(async adapter => {
      try {
        if (adapter.isAvailable()) {
          this.logger.debug('Initializing adapter', {
            component: 'storage-manager',
            operation: 'initialize',
            adapterType: adapter.constructor.name,
          });
          await this.retryEngine.withTimeout(
            () => adapter.initialize(),
            this.config.operationTimeout
          );
        }
      } catch (error) {
        // Log but don't fail initialization for individual adapters
        this.logger.warn(
          'Adapter initialization failed',
          {
            component: 'storage-manager',
            operation: 'initialize',
            adapterType: adapter.constructor.name,
          },
          error instanceof Error ? error : new Error(String(error))
        );

        if (this.config.collectErrors) {
          this.eventEmitter.emit('storageError', {
            error: error instanceof Error ? error : new Error(String(error)),
            operation: 'initialize',
            retryCount: 0,
          });
        }
      }
    });

    await Promise.allSettled(initPromises);
    await this.resilienceManager.initialize();
    this.initialized = true;

    const healthyAdapters = this.resilienceManager.getHealthyAdapters();
    if (healthyAdapters.length === 0) {
      this.logger.error('No healthy adapters available after initialization', {
        component: 'storage-manager',
        operation: 'initialize',
        totalAdapters: this.adapters.length,
        healthyAdapters: 0,
      });
      throw new StorageError(
        'No healthy adapters available',
        'NO_ADAPTERS_AVAILABLE'
      );
    }

    this.logger.info('Storage manager initialization completed', {
      component: 'storage-manager',
      operation: 'initialize',
      totalAdapters: this.adapters.length,
      healthyAdapters: healthyAdapters.length,
    });
  }

  /**
   * Get value with automatic retry and resilience
   */
  async get<T>(
    key: string,
    options?: { signal?: AbortSignal }
  ): Promise<T | null> {
    this.validateKey(key, 'get');
    const { healthyAdapters, allAdapters, unhealthyAdapters } =
      this.partitionAdaptersByHealth();

    // Emit quorum evaluation event for read
    const canSatisfyQuorum = this.resilienceManager.canSatisfyReadQuorum();
    this.eventEmitter.emit('quorumEvaluation', {
      operation: 'read',
      requiredQuorum: this.config.resilience.quorum?.readQuorum || 1,
      availableAdapters: allAdapters.length,
      healthyAdapters: healthyAdapters.map(a => a.constructor.name),
      unhealthyAdapters: unhealthyAdapters.map(a => a.constructor.name),
      quorumSatisfied: canSatisfyQuorum,
      requiresPrimary: false, // Read operations don't typically require primary
      primaryHealthy:
        healthyAdapters.length > 0
          ? healthyAdapters.includes(allAdapters[0])
          : false,
    });

    if (healthyAdapters.length === 0) {
      this.logger.error('No healthy adapters available for read', {
        component: 'storage-manager',
        operation: 'get',
        key,
        totalAdapters: allAdapters.length,
        healthyAdapters: 0,
      });
      throw new StorageError(
        'No healthy adapters available',
        'NO_ADAPTERS_AVAILABLE'
      );
    }

    // Try each healthy adapter with retry
    for (const adapter of healthyAdapters) {
      try {
        const result = await this.retryEngine.executeWithRetry(
          async () => {
            const startTime = Date.now();
            const value = await this.retryEngine.withTimeout(
              () => adapter.get<T>(key),
              this.config.operationTimeout
            );
            const responseTime = Date.now() - startTime;
            this.resilienceManager.recordSuccess(adapter, responseTime);
            return value;
          },
          { operationName: 'get', key, signal: options?.signal }
        );

        if (result !== null) {
          return result;
        }
      } catch (error) {
        this.resilienceManager.recordFailure(
          adapter,
          error instanceof Error ? error : new Error(String(error))
        );
        // Continue to next adapter
      }
    }

    return null;
  }

  /**
   * Set value with quorum and retry
   */
  async set<T>(
    key: string,
    value: T,
    options?: StorageSetOptions & { signal?: AbortSignal }
  ): Promise<void> {
    this.validateKeyValue(key, value, 'set');
    const { healthyAdapters, allAdapters, unhealthyAdapters } =
      this.partitionAdaptersByHealth();

    // Emit quorum evaluation event
    const canSatisfyQuorum = this.resilienceManager.canSatisfyWriteQuorum();
    this.eventEmitter.emit('quorumEvaluation', {
      operation: 'write',
      requiredQuorum: this.config.resilience.quorum?.writeQuorum || 1,
      availableAdapters: allAdapters.length,
      healthyAdapters: healthyAdapters.map(a => a.constructor.name),
      unhealthyAdapters: unhealthyAdapters.map(a => a.constructor.name),
      quorumSatisfied: canSatisfyQuorum,
      requiresPrimary: this.config.resilience.quorum?.requirePrimary || false,
      primaryHealthy:
        healthyAdapters.length > 0
          ? healthyAdapters.includes(allAdapters[0])
          : false,
    });

    this.logger.debug('Write quorum evaluation', {
      component: 'storage-manager',
      operation: 'set',
      key,
      requiredQuorum: this.config.resilience.quorum?.writeQuorum || 1,
      availableAdapters: allAdapters.length,
      healthyAdapters: healthyAdapters.length,
      quorumSatisfied: canSatisfyQuorum,
    });

    if (!canSatisfyQuorum) {
      this.logger.error('Cannot satisfy write quorum', {
        component: 'storage-manager',
        operation: 'set',
        key,
        requiredQuorum: this.config.resilience.quorum?.writeQuorum || 1,
        healthyAdapters: healthyAdapters.length,
        totalAdapters: allAdapters.length,
      });
      throw new StorageError(
        'Cannot satisfy write quorum',
        'QUORUM_NOT_SATISFIED'
      );
    }

    const writePromises = healthyAdapters.map(async adapter => {
      try {
        await this.retryEngine.executeWithRetry(
          async () => {
            const startTime = Date.now();
            await this.retryEngine.withTimeout(
              () => adapter.set(key, value, options),
              this.config.operationTimeout
            );
            const responseTime = Date.now() - startTime;
            this.resilienceManager.recordSuccess(adapter, responseTime);
          },
          { operationName: 'set', key, signal: options?.signal }
        );
        return { adapter, success: true };
      } catch (error) {
        this.resilienceManager.recordFailure(
          adapter,
          error instanceof Error ? error : new Error(String(error))
        );
        return { adapter, success: false, error };
      }
    });

    const results = await Promise.allSettled(writePromises);
    const successCount = results.filter(
      r => r.status === 'fulfilled' && r.value.success
    ).length;

    const requiredQuorum = this.config.resilience.quorum?.writeQuorum ?? 1;
    if (successCount < requiredQuorum) {
      // Collect errors from both fulfilled (success:false) and rejected promises
      const aggregatedErrors = results
        .map((r, idx) => {
          const adapter = healthyAdapters[idx];
          const adapterId = adapter?.constructor?.name ?? `adapter_${idx}`;
          if (r.status === 'fulfilled') {
            if ((r as any).value?.success) return null;
            const err = (r as any).value?.error;
            return {
              adapterId,
              error: err instanceof Error ? err : new Error(String(err)),
            };
          } else {
            const err = (r as PromiseRejectedResult).reason;
            return {
              adapterId,
              error: err instanceof Error ? err : new Error(String(err)),
            };
          }
        })
        .filter(Boolean) as Array<{ adapterId: string; error: Error }>;

      throw new StorageError(
        `Write quorum not satisfied: ${successCount}/${requiredQuorum}`,
        'QUORUM_NOT_SATISFIED',
        { errors: aggregatedErrors }
      );
    }
  }

  /**
   * Delete value from all adapters
   */
  async delete(
    key: string,
    options?: { signal?: AbortSignal }
  ): Promise<boolean> {
    this.validateKey(key, 'delete');
    const healthyAdapters = this.resilienceManager.getHealthyAdapters();

    let deletedFromAny = false;
    const deletePromises = healthyAdapters.map(async adapter => {
      try {
        const result = await this.retryEngine.executeWithRetry(
          async () => {
            const startTime = Date.now();
            const deleted = await this.retryEngine.withTimeout(
              () => adapter.delete(key),
              this.config.operationTimeout
            );
            const responseTime = Date.now() - startTime;
            this.resilienceManager.recordSuccess(adapter, responseTime);
            return deleted;
          },
          { operationName: 'delete', key, signal: options?.signal }
        );
        if (result) deletedFromAny = true;
      } catch (error) {
        this.resilienceManager.recordFailure(
          adapter,
          error instanceof Error ? error : new Error(String(error))
        );
      }
    });

    await Promise.allSettled(deletePromises);
    return deletedFromAny;
  }

  /**
   * Get all keys with optional prefix
   */
  async keys(prefix?: string): Promise<string[]> {
    const healthyAdapters = this.resilienceManager.getHealthyAdapters();

    if (healthyAdapters.length === 0) {
      throw new StorageError(
        'No healthy adapters available',
        'NO_ADAPTERS_AVAILABLE'
      );
    }

    // Use first healthy adapter
    const adapter = healthyAdapters[0];
    return this.retryEngine.executeWithRetry(
      async () => {
        const startTime = Date.now();
        const keys = await this.retryEngine.withTimeout(
          () => adapter.keys(prefix),
          this.config.operationTimeout
        );
        const responseTime = Date.now() - startTime;
        this.resilienceManager.recordSuccess(adapter, responseTime);
        return keys;
      },
      { operationName: 'keys', key: prefix }
    );
  }

  /**
   * Execute batch operations
   */
  async batch(
    operations: BatchOperation[],
    options?: { signal?: AbortSignal }
  ): Promise<void> {
    const healthyAdapters = this.resilienceManager.getHealthyAdapters();

    if (healthyAdapters.length === 0) {
      throw new StorageError(
        'No healthy adapters available',
        'NO_ADAPTERS_AVAILABLE'
      );
    }

    // Use first healthy adapter that supports batch
    const adapter = healthyAdapters.find(a => (a as any).batch);
    if (!adapter) {
      throw new StorageError(
        'No adapter supports batch operations',
        'BATCH_NOT_SUPPORTED'
      );
    }

    return this.retryEngine.executeWithRetry(
      async () => {
        const startTime = Date.now();
        await this.retryEngine.withTimeout(
          () => (adapter as any).batch(operations),
          this.config.operationTimeout * 2
        );
        const responseTime = Date.now() - startTime;
        this.resilienceManager.recordSuccess(adapter, responseTime);
      },
      { operationName: 'batch', signal: options?.signal }
    );
  }

  /**
   * Get adapter health status
   */
  getAdapterHealth() {
    return this.resilienceManager.getHealthStatus();
  }

  /**
   * Check if write quorum can be satisfied
   */
  canSatisfyWriteQuorum(): boolean {
    return this.resilienceManager.canSatisfyWriteQuorum();
  }

  /**
   * Check if read quorum can be satisfied
   */
  canSatisfyReadQuorum(): boolean {
    return this.resilienceManager.canSatisfyReadQuorum();
  }

  /**
   * Get available adapters
   */
  getAvailableAdapters(): string[] {
    return this.resilienceManager
      .getHealthyAdapters()
      .map(a => a.constructor.name);
  }

  /**
   * Perform health check on all adapters
   */
  async performHealthCheck(): Promise<void> {
    return this.resilienceManager.performHealthCheck();
  }

  /**
   * Get health status for all adapters
   */
  getAdapterHealthStatus(): Map<string, AdapterHealthStatus> {
    return this.resilienceManager.getHealthStatus();
  }

  /**
   * Get list of healthy adapters
   */
  getHealthyAdapters(): StorageAdapter[] {
    return this.resilienceManager.getHealthyAdapters();
  }

  /**
   * Close all adapters and cleanup
   */
  async close(): Promise<void> {
    await this.resilienceManager.shutdown();

    const closePromises = this.adapters.map(async adapter => {
      try {
        if (adapter.close) {
          await adapter.close();
        }
      } catch (error) {
        // Log but don't fail on close errors
      }
    });

    await Promise.allSettled(closePromises);
    this.initialized = false;
  }

  private partitionAdaptersByHealth(): {
    healthyAdapters: StorageAdapter[];
    allAdapters: StorageAdapter[];
    unhealthyAdapters: StorageAdapter[];
  } {
    const healthyAdapters = this.resilienceManager.getHealthyAdapters();
    const allAdapters = this.adapters;
    const unhealthyAdapters = allAdapters.filter(a => !healthyAdapters.includes(a));
    return { healthyAdapters, allAdapters, unhealthyAdapters };
  }

  /**
   * Validate key format using centralized validation
   */
  private validateKey(key: string, operation: string = 'validate'): void {
    this.validator.assertValidKey(key, operation);
  }

  /**
   * Validate key-value pair using centralized validation
   */
  private validateKeyValue(
    key: string,
    value: unknown,
    operation: string = 'validate'
  ): void {
    this.validator.assertValidKeyValue(key, value, operation);
  }
}
