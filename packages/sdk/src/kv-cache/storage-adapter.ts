/**
 * @file Storage Adapter Interface
 *
 * This file defines the abstract interface for storage adapters in the AtomicMemory SDK.
 * Storage adapters provide a unified API for different storage backends including
 * IndexedDB, Chrome storage API, and in-memory storage.
 *
 * The adapter interface follows these principles:
 * - Consistent async API across all storage types
 * - Strong typing with generic support
 * - Error handling with specific error types
 * - Capability detection for feature support
 * - Resource cleanup and lifecycle management
 *
 * @example
 * ```typescript
 * import { StorageAdapter } from './storage-adapter';
 *
 * class MyAdapter implements StorageAdapter {
 *   async get<T>(key: string): Promise<T | null> {
 *     // Implementation
 *   }
 *   // ... other methods
 * }
 * ```
 */

import { StorageError } from '../core/error-handling/errors';
// import { StorageConstraints } from './types'; // Unused for now
import { StorageStats, StorageCapabilities } from './types';
import { StorageValidator } from './validation';

/**
 * Storage operation result with metadata
 */
interface StorageResult<T = any> {
  /** The retrieved/stored value */
  value: T;
  /** Size of the stored data in bytes */
  size?: number;
  /** When the data was last modified */
  lastModified?: number;
  /** Additional metadata from the storage backend - intentionally `any` for adapter flexibility */
  metadata?: Record<string, any>; // INTENTIONAL: Different storage backends provide different metadata structures
}

// Re-export StorageStats from types for backward compatibility
export type { StorageStats } from './types';

/**
 * Batch operation for efficient bulk storage operations
 */
export interface BatchOperation {
  /** Operation type */
  type: 'set' | 'delete';
  /** Storage key */
  key: string;
  /** Value to store (for set operations) - intentionally `any` for storage flexibility */
  value?: any; // INTENTIONAL: Storage adapters must handle any serializable value type
}

// Re-export StorageCapabilities from types for backward compatibility
export type { StorageCapabilities } from './types';

/**
 * Storage-specific error types - now using unified error hierarchy
 */
export class StorageQuotaExceededError extends StorageError {
  constructor(operation: string, key?: string) {
    super('Storage quota exceeded', 'QUOTA_EXCEEDED', { operation, key });
  }
}

class StorageNotAvailableError extends StorageError {
  constructor(adapterType: string) {
    super(`Storage adapter not available: ${adapterType}`, 'NOT_AVAILABLE', {
      operation: 'initialize',
      adapterType,
    });
  }
}

/**
 * Abstract storage adapter interface
 *
 * All storage adapters must implement this interface to provide
 * consistent access to different storage backends.
 */
export interface StorageAdapter {
  /**
   * Retrieves a value from storage
   *
   * @param key - Storage key
   * @returns Promise resolving to the value or null if not found
   * @throws {StorageError} When retrieval fails
   */
  get<T>(key: string): Promise<T | null>;

  /**
   * Stores a value in storage
   *
   * @param key - Storage key
   * @param value - Value to store
   * @param options - Storage options (TTL, compression, etc.)
   * @throws {StorageError} When storage fails
   * @throws {StorageQuotaExceededError} When storage quota is exceeded
   */
  set<T>(
    key: string,
    value: T,
    options?: {
      ttl?: number;
      compress?: boolean;
      encrypt?: boolean;
    }
  ): Promise<void>;

  /**
   * Deletes a value from storage
   *
   * @param key - Storage key
   * @returns Promise resolving to true if the key existed
   * @throws {StorageError} When deletion fails
   */
  delete(key: string): Promise<boolean>;

  /**
   * Checks if a key exists in storage
   *
   * @param key - Storage key
   * @returns Promise resolving to true if the key exists
   * @throws {StorageError} When check fails
   */
  has(key: string): Promise<boolean>;

  /**
   * Retrieves all keys from storage
   *
   * @param prefix - Optional key prefix filter
   * @returns Promise resolving to array of keys
   * @throws {StorageError} When retrieval fails
   */
  keys(prefix?: string): Promise<string[]>;

  /**
   * Clears all data from storage
   *
   * @param prefix - Optional key prefix to clear (if supported)
   * @throws {StorageError} When clearing fails
   */
  clear(prefix?: string): Promise<void>;

  /**
   * Gets storage statistics and usage information
   *
   * @returns Promise resolving to storage statistics
   * @throws {StorageError} When stats retrieval fails
   */
  getStats(): Promise<StorageStats>;

  /**
   * Gets adapter capabilities and limits
   *
   * @returns Storage capabilities object
   */
  getCapabilities(): StorageCapabilities;

  /**
   * Performs multiple storage operations atomically (if supported)
   *
   * @param operations - Array of batch operations
   * @throws {StorageError} When batch operation fails
   * @throws {Error} When transactions are not supported
   */
  batch(operations: BatchOperation[]): Promise<void>;

  /**
   * Initializes the storage adapter
   *
   * @param config - Adapter-specific configuration
   * @throws {StorageNotAvailableError} When adapter is not available
   * @throws {StorageError} When initialization fails
   */
  initialize(config?: Record<string, any>): Promise<void>; // INTENTIONAL: Different adapters need different config shapes

  /**
   * Closes the storage adapter and cleans up resources
   *
   * @throws {StorageError} When cleanup fails
   */
  close(): Promise<void>;

  /**
   * Checks if the storage adapter is available in the current environment
   *
   * @returns True if the adapter can be used
   */
  isAvailable(): boolean;
}

/**
 * Base abstract class for storage adapters
 *
 * Provides common functionality and error handling for storage adapters.
 */
export abstract class BaseStorageAdapter implements StorageAdapter {
  protected initialized = false;
  protected closed = false;
  protected validator: StorageValidator;

  constructor() {
    // Initialize validator with adapter capabilities
    this.validator = StorageValidator.fromCapabilities(this.getCapabilities());
  }

  abstract get<T>(key: string): Promise<T | null>;
  abstract set<T>(key: string, value: T, options?: any): Promise<void>; // INTENTIONAL: Different adapters support different option types
  abstract delete(key: string): Promise<boolean>;
  abstract has(key: string): Promise<boolean>;
  abstract keys(prefix?: string): Promise<string[]>;
  abstract clear(prefix?: string): Promise<void>;
  abstract getStats(): Promise<StorageStats>;
  abstract getCapabilities(): StorageCapabilities;
  abstract batch(operations: BatchOperation[]): Promise<void>;
  abstract initialize(config?: Record<string, any>): Promise<void>; // INTENTIONAL: Different adapters need different config shapes
  abstract close(): Promise<void>;
  abstract isAvailable(): boolean;

  /**
   * Validates that the adapter is initialized and not closed
   *
   * @throws {StorageError} When adapter is not ready
   */
  protected validateReady(): void {
    if (this.closed) {
      throw new StorageError('Storage adapter is closed', 'ADAPTER_CLOSED', {
        operation: 'validate',
      });
    }
    if (!this.initialized) {
      throw new StorageError(
        'Storage adapter not initialized',
        'NOT_INITIALIZED',
        { operation: 'validate' }
      );
    }
  }

  /**
   * Validates a storage key using centralized validation
   *
   * @param key - Key to validate
   * @param operation - Operation context for error reporting
   * @throws {StorageError} When key is invalid
   */
  protected validateKey(key: string, operation: string = 'validate'): void {
    this.validator.assertValidKey(key, operation);
  }

  /**
   * Validates a storage value using centralized validation
   *
   * @param value - Value to validate
   * @param operation - Operation context for error reporting
   * @throws {StorageError} When value is invalid
   */
  protected validateValue(
    value: unknown,
    operation: string = 'validate'
  ): void {
    this.validator.assertValidValue(value, operation);
  }

  /**
   * Validates a key-value pair using centralized validation
   *
   * @param key - Key to validate
   * @param value - Value to validate
   * @param operation - Operation context for error reporting
   * @throws {StorageError} When key or value is invalid
   */
  protected validateKeyValue(
    key: string,
    value: unknown,
    operation: string = 'validate'
  ): void {
    this.validator.assertValidKeyValue(key, value, operation);
  }

  /**
   * Updates the validator configuration
   *
   * @param config - Partial validation configuration to merge
   */
  protected updateValidationConfig(
    config: Partial<import('./validation').ValidationConfig>
  ): void {
    this.validator.updateConfig(config);
  }
}
