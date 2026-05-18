/**
 * @file IndexedDB Storage Adapter
 *
 * IndexedDB implementation for persistent browser storage with versioning,
 * transactions, and cross-browser compatibility. Supports CRUD operations,
 * batch transactions, and automatic database upgrades.
 */

import {
  BaseStorageAdapter,
  StorageCapabilities,
  BatchOperation,
} from './storage-adapter';
import { StorageError } from '../core/error-handling/';
import { StorageStats } from './types';
import { calculateDataSize } from './storage-utils';

interface IndexedDBConfig {
  dbName?: string;
  version?: number;
  storeName?: string;
}

interface StoredItem {
  key: string;
  value: any;
  timestamp: number;
  size: number;
}

export class IndexedDBStorageAdapter extends BaseStorageAdapter {
  private db?: IDBDatabase;
  private dbName: string;
  private version: number;
  private storeName: string;
  protected initialized = false;

  constructor() {
    super();
    this.dbName = 'atomicmemory-sdk';
    this.version = 1;
    this.storeName = 'storage';
  }

  async initialize(config?: IndexedDBConfig): Promise<void> {
    if (this.initialized) return;

    if (config) {
      this.dbName = config.dbName || this.dbName;
      this.version = config.version || this.version;
      this.storeName = config.storeName || this.storeName;
    }

    if (!this.isAvailable()) {
      throw new StorageError(
        'IndexedDB not available',
        'INDEXEDDB_UNAVAILABLE',
        { operation: 'initialize' }
      );
    }

    try {
      this.db = await this.openDatabase();
      this.initialized = true;
    } catch (error) {
      throw new StorageError(
        `Failed to initialize IndexedDB: ${error instanceof Error ? error.message : String(error)}`,
        'INDEXEDDB_INIT_FAILED',
        { operation: 'initialize' }
      );
    }
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = undefined;
    }
    this.initialized = false;
  }

  isAvailable(): boolean {
    return typeof indexedDB !== 'undefined';
  }

  async get<T>(key: string): Promise<T | null> {
    this.validateKey(key, 'get');
    const result = await this.readItem(key, 'INDEXEDDB_GET_FAILED', 'get');
    return result ? (result.value as T) : null;
  }

  async set<T>(key: string, value: T, _options?: any): Promise<void> {
    this.validateKeyValue(key, value, 'set');
    this.ensureInitialized();

    const size = calculateDataSize(value);
    const item: StoredItem = {
      key,
      value,
      timestamp: Date.now(),
      size,
    };

    try {
      const transaction = this.db!.transaction([this.storeName], 'readwrite');
      const store = transaction.objectStore(this.storeName);
      const request = store.put(item);

      await this.promisifyRequest(request);
    } catch (error) {
      throw new StorageError(
        `Failed to set value for key "${key}": ${error instanceof Error ? error.message : String(error)}`,
        'INDEXEDDB_SET_FAILED',
        { operation: 'set', key }
      );
    }
  }

  async delete(key: string): Promise<boolean> {
    this.validateKey(key, 'delete');
    this.ensureInitialized();

    try {
      const transaction = this.db!.transaction([this.storeName], 'readwrite');
      const store = transaction.objectStore(this.storeName);

      // Check if key exists first
      const getRequest = store.get(key);
      const existing = await this.promisifyRequest<StoredItem>(getRequest);

      if (!existing) {
        return false;
      }

      const deleteRequest = store.delete(key);
      await this.promisifyRequest(deleteRequest);
      return true;
    } catch (error) {
      throw new StorageError(
        `Failed to delete key "${key}": ${error instanceof Error ? error.message : String(error)}`,
        'INDEXEDDB_DELETE_FAILED',
        { operation: 'delete', key }
      );
    }
  }

  async has(key: string): Promise<boolean> {
    this.validateKey(key, 'has');
    const result = await this.readItem(key, 'INDEXEDDB_HAS_FAILED', 'has');
    return result !== undefined;
  }

  /**
   * Shared readonly-txn + store.get path used by {@link get} and
   * {@link has}. Extracted to keep each op focused on its return-shape
   * logic rather than repeating the transaction-setup + StorageError
   * wrapping boilerplate.
   */
  private async readItem(
    key: string,
    errorCode: string,
    operation: 'get' | 'has',
  ): Promise<StoredItem | undefined> {
    this.ensureInitialized();
    try {
      const transaction = this.db!.transaction([this.storeName], 'readonly');
      const store = transaction.objectStore(this.storeName);
      const request = store.get(key);
      return (await this.promisifyRequest<StoredItem>(request)) ?? undefined;
    } catch (error) {
      throw new StorageError(
        `Failed to ${operation === 'get' ? 'get value for' : 'check existence of'} key "${key}": ${error instanceof Error ? error.message : String(error)}`,
        errorCode,
        { operation, key },
      );
    }
  }

  async keys(prefix?: string): Promise<string[]> {
    this.ensureInitialized();

    try {
      const transaction = this.db!.transaction([this.storeName], 'readonly');
      const store = transaction.objectStore(this.storeName);
      const request = store.getAllKeys();

      const allKeys = await this.promisifyRequest<string[]>(request);

      if (!prefix) {
        return allKeys;
      }

      return allKeys.filter(key => key.startsWith(prefix));
    } catch (error) {
      throw new StorageError(
        `Failed to retrieve keys: ${error instanceof Error ? error.message : String(error)}`,
        'INDEXEDDB_KEYS_FAILED',
        { operation: 'keys' }
      );
    }
  }

  async clear(prefix?: string): Promise<void> {
    this.ensureInitialized();

    try {
      if (!prefix) {
        // Clear all data
        const transaction = this.db!.transaction([this.storeName], 'readwrite');
        const store = transaction.objectStore(this.storeName);
        const request = store.clear();
        await this.promisifyRequest(request);
      } else {
        // Clear by prefix
        const keysToDelete = await this.keys(prefix);
        if (keysToDelete.length > 0) {
          await this.batch(keysToDelete.map(key => ({ type: 'delete', key })));
        }
      }
    } catch (error) {
      throw new StorageError(
        `Failed to clear storage: ${error instanceof Error ? error.message : String(error)}`,
        'INDEXEDDB_CLEAR_FAILED',
        { operation: 'clear' }
      );
    }
  }

  async getStats(): Promise<StorageStats> {
    this.ensureInitialized();

    try {
      const transaction = this.db!.transaction([this.storeName], 'readonly');
      const store = transaction.objectStore(this.storeName);
      const request = store.getAll();

      const allItems = await this.promisifyRequest<StoredItem[]>(request);

      const totalSize = allItems.reduce(
        (sum, item) => sum + (item.size || 0),
        0
      );

      const availableSize = this.getCapabilities().maxTotalSize - totalSize;

      return {
        keyCount: allItems.length,
        totalSize,
        availableSize,
        utilization: totalSize / this.getCapabilities().maxTotalSize,
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
      };
    } catch (error) {
      throw new StorageError(
        `Failed to get storage stats: ${error instanceof Error ? error.message : String(error)}`,
        'INDEXEDDB_STATS_FAILED',
        { operation: 'getStats' }
      );
    }
  }

  getCapabilities(): StorageCapabilities {
    return {
      maxKeyLength: 1000,
      maxValueSize: 100 * 1024 * 1024, // 100MB
      maxTotalSize: 1024 * 1024 * 1024, // 1GB
      supportsEncryption: false,
      supportsCompression: false,
      supportsExpiration: false,
      supportsTransactions: true,
      supportsBatch: true,
    };
  }

  async batch(operations: BatchOperation[]): Promise<void> {
    if (operations.length === 0) return;

    this.ensureInitialized();

    try {
      const transaction = this.db!.transaction([this.storeName], 'readwrite');
      const store = transaction.objectStore(this.storeName);

      const promises: Promise<any>[] = [];

      for (const operation of operations) {
        switch (operation.type) {
          case 'set': {
            this.validateKeyValue(operation.key, operation.value, 'batch');
            const item: StoredItem = {
              key: operation.key,
              value: operation.value,
              timestamp: Date.now(),
              size: calculateDataSize(operation.value),
            };
            promises.push(this.promisifyRequest(store.put(item)));
            break;
          }

          case 'delete':
            this.validateKey(operation.key, 'batch');
            promises.push(this.promisifyRequest(store.delete(operation.key)));
            break;

          default:
            throw new StorageError(
              `Unsupported batch operation type: ${(operation as any).type}`,
              'INDEXEDDB_INVALID_OPERATION',
              { operation: 'batch' }
            );
        }
      }

      await Promise.all(promises);
    } catch (error) {
      throw new StorageError(
        `Batch operation failed: ${error instanceof Error ? error.message : String(error)}`,
        'INDEXEDDB_BATCH_FAILED',
        { operation: 'batch' }
      );
    }
  }

  private async openDatabase(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.version);

      request.onerror = () => {
        reject(
          new Error(
            `Failed to open database: ${request.error?.message || 'Unknown error'}`
          )
        );
      };

      request.onsuccess = () => {
        resolve(request.result);
      };

      request.onupgradeneeded = event => {
        const db = (event.target as IDBOpenDBRequest).result;

        // Create object store if it doesn't exist
        if (!db.objectStoreNames.contains(this.storeName)) {
          const store = db.createObjectStore(this.storeName, {
            keyPath: 'key',
          });

          // Create indexes for efficient querying
          store.createIndex('timestamp', 'timestamp', { unique: false });
        }
      };
    });
  }

  private promisifyRequest<T = any>(request: IDBRequest): Promise<T> {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  private ensureInitialized(): void {
    if (!this.initialized || !this.db) {
      throw new StorageError(
        'IndexedDB adapter not initialized',
        'INDEXEDDB_NOT_INITIALIZED',
        { operation: 'validate' }
      );
    }
  }
}
