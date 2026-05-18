/**
 * @file Repair Manager
 *
 * This module handles background repair of failed storage operations.
 * It provides functionality for:
 * - Tracking failed operations that need repair
 * - Background repair scheduling and execution
 * - Operation retry logic with exponential backoff
 * - Cleanup of old or unrepairable operations
 *
 * @example
 * ```typescript
 * import { RepairManager } from './repair-manager';
 *
 * const manager = new RepairManager(config, eventEmitter, healthTracker);
 * await manager.initialize();
 * manager.recordFailedOperation(operation);
 * ```
 */

import { StorageAdapter } from './storage-adapter';
import { EventEmitter } from '../core/events';
import { getAdapterId } from './adapter-utils';
import { FailedOperation, RepairConfig } from './types';
import { HealthTracker } from './health-tracker';

/**
 * Manager for repairing failed storage operations
 */
export class RepairManager {
  private failedOperations = new Map<string, FailedOperation>();
  private repairInterval?: NodeJS.Timeout;
  private initialized = false;

  constructor(
    private config: RepairConfig,
    private eventEmitter: EventEmitter,
    private healthTracker: HealthTracker
  ) {}

  /**
   * Initialize repair manager
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    if (this.config.enabled) {
      this.startBackgroundRepair();
    }

    this.initialized = true;
  }

  /**
   * Shutdown repair manager
   */
  async shutdown(): Promise<void> {
    if (this.repairInterval) {
      clearInterval(this.repairInterval);
      this.repairInterval = undefined;
    }
    this.initialized = false;
  }

  /**
   * Record a failed operation for potential repair
   */
  recordFailedOperation(operation: FailedOperation): void {
    if (!this.config.enabled) return;

    // Check if we need to evict operations due to queue size limit
    if (
      this.config.maxQueueSize &&
      this.failedOperations.size >= this.config.maxQueueSize
    ) {
      this.evictOperations(1); // Make room for the new operation
    }

    this.failedOperations.set(operation.id, operation);
  }

  /**
   * Get count of pending repair operations
   */
  getPendingRepairCount(): number {
    return this.failedOperations.size;
  }

  /**
   * Get maximum queue size
   */
  getMaxQueueSize(): number {
    return this.config.maxQueueSize || Infinity;
  }

  /**
   * Evict operations from the queue based on the configured policy
   */
  private evictOperations(count: number): void {
    if (this.failedOperations.size === 0) return;

    const operations = Array.from(this.failedOperations.values());
    const toEvict: FailedOperation[] = [];

    switch (this.config.evictionPolicy) {
      case 'oldest':
        // Sort by timestamp (oldest first)
        operations.sort((a, b) => a.timestamp - b.timestamp);
        toEvict.push(...operations.slice(0, count));
        break;

      case 'least-attempts':
        // Sort by repair attempts (least attempts first)
        operations.sort((a, b) => a.repairAttempts - b.repairAttempts);
        toEvict.push(...operations.slice(0, count));
        break;

      case 'random':
      default: {
        // Random eviction
        const shuffled = [...operations].sort(() => Math.random() - 0.5);
        toEvict.push(...shuffled.slice(0, count));
        break;
      }
    }

    // Remove evicted operations and emit events
    for (const operation of toEvict) {
      this.failedOperations.delete(operation.id);

      this.eventEmitter.emit('operationDropped', {
        operationId: operation.id,
        key: operation.key,
        type: operation.type,
        reason: 'queue-full',
        evictionPolicy: this.config.evictionPolicy || 'random',
        queueSize: this.failedOperations.size,
        maxQueueSize: this.config.maxQueueSize || 0,
      });
    }
  }

  /**
   * Start background repair interval
   */
  private startBackgroundRepair(): void {
    this.repairInterval = setInterval(
      () => this.performBackgroundRepair(),
      this.config.interval
    );
  }

  /**
   * Perform background repair of failed operations
   */
  private async performBackgroundRepair(): Promise<void> {
    const now = Date.now();
    const operationsToRepair: FailedOperation[] = [];

    // Find operations that need repair
    for (const [_operationId, operation] of this.failedOperations) {
      if (this.shouldRepairOperation(operation, now)) {
        operationsToRepair.push(operation);

        if (operationsToRepair.length >= this.config.batchSize) {
          break;
        }
      }
    }

    // Attempt to repair operations
    for (const operation of operationsToRepair) {
      await this.attemptRepair(operation);
    }

    // Clean up old operations that can't be repaired
    this.cleanupOldOperations();
  }

  /**
   * Check if operation should be repaired
   */
  private shouldRepairOperation(
    operation: FailedOperation,
    now: number
  ): boolean {
    return (
      now - operation.timestamp <= this.config.maxAge &&
      operation.repairAttempts < this.config.maxAttempts &&
      (!operation.lastRepairAttempt ||
        now - operation.lastRepairAttempt >= this.config.interval)
    );
  }

  /**
   * Attempt to repair a failed operation
   */
  private async attemptRepair(operation: FailedOperation): Promise<void> {
    const healthyAdapters = this.healthTracker.getHealthyAdapters();
    const failedAdapterIds = new Set(operation.failedAdapters);

    // Find adapters that were previously failed but might be healthy now
    const repairCandidates = healthyAdapters.filter(adapter =>
      failedAdapterIds.has(getAdapterId(adapter))
    );

    if (repairCandidates.length === 0) {
      return; // No candidates for repair
    }

    // Validate repair operation against adapter capabilities
    const validCandidates = repairCandidates.filter(adapter =>
      this.validateRepairOperation(adapter, operation)
    );

    if (validCandidates.length === 0) {
      // No valid candidates, drop the operation
      this.failedOperations.delete(operation.id);
      this.eventEmitter.emit('operationDropped', {
        operationId: operation.id,
        key: operation.key,
        type: operation.type,
        reason: 'max-attempts-exceeded',
        queueSize: this.failedOperations.size,
        maxQueueSize: this.config.maxQueueSize || 0,
      });
      return;
    }

    operation.repairAttempts++;
    operation.lastRepairAttempt = Date.now();

    let repairedCount = 0;

    for (const adapter of validCandidates) {
      try {
        await this.executeRepairOperation(adapter, operation);
        repairedCount++;

        // Remove from failed adapters list
        const adapterId = getAdapterId(adapter);
        operation.failedAdapters = operation.failedAdapters.filter(
          id => id !== adapterId
        );
      } catch (error) {
        // Repair failed, adapter might still be unhealthy
        this.healthTracker.recordFailure(
          adapter,
          error instanceof Error ? error : new Error(String(error))
        );
      }
    }

    if (repairedCount > 0) {
      this.eventEmitter.emit('operationRepaired', {
        operationId: operation.id,
        key: operation.key,
        repairedAdapters: repairedCount,
      });
    }

    // If all adapters are repaired, remove the operation
    if (operation.failedAdapters.length === 0) {
      this.failedOperations.delete(operation.id);
    } else {
      this.failedOperations.set(operation.id, operation);
    }
  }

  /**
   * Execute repair operation on adapter
   */
  private async executeRepairOperation(
    adapter: StorageAdapter,
    operation: FailedOperation
  ): Promise<void> {
    if (operation.type === 'set') {
      await adapter.set(
        operation.key,
        operation.value,
        operation.options as any
      );
    } else if (operation.type === 'delete') {
      await adapter.delete(operation.key);
    } else {
      throw new Error(`Unsupported repair operation type: ${operation.type}`);
    }
  }

  /**
   * Clean up operations that are too old or have exceeded max attempts
   */
  private cleanupOldOperations(): void {
    const now = Date.now();
    const operationsToRemove: string[] = [];

    for (const [operationId, operation] of this.failedOperations) {
      if (this.shouldCleanupOperation(operation, now)) {
        operationsToRemove.push(operationId);
      }
    }

    // Remove operations and emit events
    for (const operationId of operationsToRemove) {
      const operation = this.failedOperations.get(operationId);
      this.failedOperations.delete(operationId);

      if (operation) {
        const reason =
          operation.repairAttempts >= this.config.maxAttempts
            ? 'max_attempts'
            : 'expired';

        // Emit both the legacy abandoned event and the new dropped event
        this.eventEmitter.emit('operationAbandoned', {
          operationId,
          key: operation.key,
          reason: reason === 'max_attempts' ? 'max_attempts' : 'expired',
        });

        this.eventEmitter.emit('operationDropped', {
          operationId,
          key: operation.key,
          type: operation.type,
          reason:
            reason === 'max_attempts' ? 'max-attempts-exceeded' : 'too-old',
          queueSize: this.failedOperations.size,
          maxQueueSize: this.config.maxQueueSize || 0,
        });
      }
    }
  }

  /**
   * Check if operation should be cleaned up
   */
  private shouldCleanupOperation(
    operation: FailedOperation,
    now: number
  ): boolean {
    return (
      now - operation.timestamp > this.config.maxAge ||
      operation.repairAttempts >= this.config.maxAttempts
    );
  }

  /**
   * Validate if a repair operation is valid for the given adapter
   */
  private validateRepairOperation(
    adapter: any,
    operation: FailedOperation
  ): boolean {
    try {
      // Check if adapter is available
      if (!adapter.isAvailable || !adapter.isAvailable()) {
        return false;
      }

      // Get adapter capabilities
      const capabilities = adapter.getCapabilities
        ? adapter.getCapabilities()
        : {};

      // Validate key length
      if (
        capabilities.maxKeyLength &&
        operation.key.length > capabilities.maxKeyLength
      ) {
        return false;
      }

      // Validate value size for set operations
      if (operation.type === 'set' && operation.value) {
        const valueSize = this.estimateValueSize(operation.value);
        if (
          capabilities.maxValueSize &&
          valueSize > capabilities.maxValueSize
        ) {
          return false;
        }
      }

      // For delete operations, just check if the adapter supports the operation
      if (operation.type === 'delete' && !adapter.delete) {
        return false;
      }

      // For set operations, check if the adapter supports the operation
      if (operation.type === 'set' && !adapter.set) {
        return false;
      }

      return true;
    } catch (error) {
      // If validation fails, assume the operation is invalid
      return false;
    }
  }

  /**
   * Estimate the size of a value in bytes
   */
  private estimateValueSize(value: unknown): number {
    try {
      if (typeof value === 'string') {
        return new TextEncoder().encode(value).length;
      }
      if (value instanceof ArrayBuffer) {
        return value.byteLength;
      }
      if (value instanceof Uint8Array) {
        return value.length;
      }
      // For other types, estimate based on JSON serialization
      return new TextEncoder().encode(JSON.stringify(value)).length;
    } catch {
      // If we can't estimate, return a conservative estimate
      return 1024; // 1KB default
    }
  }
}
