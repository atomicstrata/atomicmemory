/**
 * @file In-Memory Storage Adapter
 *
 * This file provides an in-memory storage adapter for the AtomicMemory SDK.
 * It's primarily used for testing, development, and as a fallback when
 * persistent storage is not available.
 *
 * Features:
 * - Fast read/write operations
 * - TTL support with automatic cleanup
 * - Memory usage tracking
 * - Configurable size limits
 * - Thread-safe operations
 */

import {
  BaseStorageAdapter,
  StorageCapabilities,
  BatchOperation,
  StorageQuotaExceededError,
} from './storage-adapter';
import { StorageStats } from './types';

interface MemoryItem<T = any> {
  value: T;
  size: number;
  createdAt: number;
  expiresAt?: number;
}

/**
 * In-memory storage adapter implementation
 */
export class MemoryStorageAdapter extends BaseStorageAdapter {
  private storage = new Map<string, MemoryItem>();
  private totalSize = 0;
  private maxSize = 50 * 1024 * 1024; // 50MB default
  private cleanupInterval?: NodeJS.Timeout;

  async initialize(config?: { maxSize?: number }): Promise<void> {
    if (this.initialized) return;

    this.maxSize = config?.maxSize || this.maxSize;

    // Start cleanup interval for expired items
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpired();
    }, 60000); // Clean up every minute

    this.initialized = true;
  }

  async close(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = undefined;
    }

    this.storage.clear();
    this.totalSize = 0;
    this.closed = true;
  }

  isAvailable(): boolean {
    return true; // Always available
  }

  async get<T>(key: string): Promise<T | null> {
    this.validateReady();
    this.validateKey(key, 'get');

    const item = this.storage.get(key);
    if (!item) return null;

    // Check expiration
    if (item.expiresAt && Date.now() > item.expiresAt) {
      await this.delete(key);
      return null;
    }

    return item.value as T;
  }

  async set<T>(
    key: string,
    value: T,
    options?: { ttl?: number }
  ): Promise<void> {
    this.validateReady();
    this.validateKeyValue(key, value, 'set');

    const serialized = JSON.stringify(value);
    const size = new Blob([serialized]).size;

    // Check if adding this item would exceed quota
    const existingItem = this.storage.get(key);
    const sizeIncrease = size - (existingItem?.size || 0);

    if (this.totalSize + sizeIncrease > this.maxSize) {
      throw new StorageQuotaExceededError('set', key);
    }

    const item: MemoryItem<T> = {
      value,
      size,
      createdAt: Date.now(),
      expiresAt: options?.ttl ? Date.now() + options.ttl : undefined,
    };

    this.storage.set(key, item);
    this.totalSize += sizeIncrease;
  }

  async delete(key: string): Promise<boolean> {
    this.validateReady();
    this.validateKey(key, 'delete');

    const item = this.storage.get(key);
    if (!item) return false;

    this.storage.delete(key);
    this.totalSize -= item.size;
    return true;
  }

  async has(key: string): Promise<boolean> {
    this.validateReady();
    this.validateKey(key);

    const item = this.storage.get(key);
    if (!item) return false;

    // Check expiration
    if (item.expiresAt && Date.now() > item.expiresAt) {
      await this.delete(key);
      return false;
    }

    return true;
  }

  async keys(prefix?: string): Promise<string[]> {
    this.validateReady();

    const allKeys = Array.from(this.storage.keys());

    if (!prefix) return allKeys;

    return allKeys.filter(key => key.startsWith(prefix));
  }

  async clear(prefix?: string): Promise<void> {
    this.validateReady();

    if (!prefix) {
      this.storage.clear();
      this.totalSize = 0;
      return;
    }

    const keysToDelete = await this.keys(prefix);
    for (const key of keysToDelete) {
      await this.delete(key);
    }
  }

  async getStats(): Promise<StorageStats> {
    this.validateReady();
    // Opportunistically cleanup expired items before reporting
    this.cleanupExpired();
    const stats = {
      keyCount: this.storage.size,
      totalSize: this.totalSize,
      availableSize: this.maxSize - this.totalSize,
      utilization: this.totalSize / this.maxSize,
      operationCount: {
        get: 0, // These would need to be tracked in a real implementation
        set: 0,
        delete: 0,
        batch: 0,
      },
      performance: {
        averageLatency: 0, // These would need to be tracked in a real implementation
        operationsPerSecond: 0,
      },
      health: {
        isHealthy: true,
        lastCheck: Date.now(),
        failureCount: 0,
      },
    } as StorageStats & {
      adapterType?: string;
      supportsTransactions?: boolean;
      supportsBatch?: boolean;
    };
    // Provide back-compat fields expected by some tests
    (stats as any).itemCount = stats.keyCount;
    (stats as any).adapterType = 'memory';
    (stats as any).supportsTransactions = true;
    (stats as any).supportsBatch = true;
    return stats as StorageStats;
  }

  getCapabilities(): StorageCapabilities {
    return {
      maxKeyLength: 1000,
      maxValueSize: 10 * 1024 * 1024, // 10MB per item
      maxTotalSize: this.maxSize,
      supportsEncryption: false,
      supportsCompression: false,
      supportsExpiration: true,
      supportsTransactions: true,
      supportsBatch: true,
    };
  }

  async batch(operations: BatchOperation[]): Promise<void> {
    this.validateReady();

    // Calculate total size change first
    let sizeChange = 0;
    for (const op of operations) {
      if (op.type === 'set') {
        const size = new Blob([JSON.stringify(op.value)]).size;
        const existing = this.storage.get(op.key);
        sizeChange += size - (existing?.size || 0);
      } else if (op.type === 'delete') {
        const existing = this.storage.get(op.key);
        if (existing) sizeChange -= existing.size;
      }
    }

    // Check quota
    if (this.totalSize + sizeChange > this.maxSize) {
      throw new StorageQuotaExceededError('batch');
    }

    // Execute all operations
    for (const op of operations) {
      if (op.type === 'set') {
        await this.set(op.key, op.value);
      } else if (op.type === 'delete') {
        await this.delete(op.key);
      }
    }
  }

  /**
   * Cleans up expired items
   */
  private cleanupExpired(): void {
    const now = Date.now();
    const expiredKeys: string[] = [];

    for (const [key, item] of this.storage.entries()) {
      if (item.expiresAt && now > item.expiresAt) {
        expiredKeys.push(key);
      }
    }

    for (const key of expiredKeys) {
      const item = this.storage.get(key);
      if (item) {
        this.storage.delete(key);
        this.totalSize -= item.size;
      }
    }
  }
}
