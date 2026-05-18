/**
 * @file Storage Utilities
 *
 * Utility functions for storage operations including serialization,
 * compression, data validation, and operation helpers.
 */

import { StorageError } from '../core/error-handling/';

/**
 * Storage operation result with adapter information
 */
interface StorageOperationResult<T = any> {
  success: boolean;
  value?: T;
  error?: Error;
  adapter: string;
}

/**
 * Serializes data for storage
 */
function serializeData(data: any): string {
  try {
    return JSON.stringify(data);
  } catch (error) {
    throw new StorageError('Failed to serialize data', 'SERIALIZATION_FAILED', {
      operation: 'serialize',
    });
  }
}

/**
 * Deserializes data from storage
 */
function deserializeData<T>(serialized: string): T {
  try {
    return JSON.parse(serialized) as T;
  } catch (error) {
    throw new StorageError(
      'Failed to deserialize data',
      'DESERIALIZATION_FAILED',
      { operation: 'deserialize' }
    );
  }
}

/**
 * Compresses data for efficient storage (simple implementation)
 */
function compressData(data: string): string {
  // Simple compression using base64 encoding for now
  // In production, could use actual compression algorithms
  try {
    return btoa(data);
  } catch (error) {
    throw new StorageError('Failed to compress data', 'COMPRESSION_FAILED', {
      operation: 'compress',
    });
  }
}

/**
 * Decompresses stored data
 */
function decompressData(compressed: string): string {
  try {
    return atob(compressed);
  } catch (error) {
    throw new StorageError(
      'Failed to decompress data',
      'DECOMPRESSION_FAILED',
      { operation: 'decompress' }
    );
  }
}

/**
 * Calculates the size of serialized data
 */
export function calculateDataSize(data: any): number {
  try {
    const serialized = serializeData(data);
    return new Blob([serialized]).size;
  } catch (error) {
    return 0;
  }
}

/**
 * Validates storage key format
 */
function validateStorageKey(key: string): boolean {
  return typeof key === 'string' && key.length > 0 && key.length <= 1000;
}

/**
 * Creates a timeout promise that rejects after specified milliseconds
 */
function createTimeoutPromise(timeoutMs: number): Promise<never> {
  return new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('Operation timeout')), timeoutMs)
  );
}

/**
 * Wraps an operation with a timeout
 */
async function withTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs: number
): Promise<T> {
  return Promise.race([operation(), createTimeoutPromise(timeoutMs)]);
}

/**
 * Validates that a value is not undefined (storage constraint)
 */
function validateStorageValue(value: any): void {
  if (value === undefined) {
    throw new StorageError('Value cannot be undefined', 'INVALID_VALUE', {
      operation: 'validate',
    });
  }
}

/**
 * Estimates the memory footprint of a value
 */
function estimateMemorySize(value: any): number {
  if (value === null || value === undefined) return 0;

  switch (typeof value) {
    case 'boolean':
      return 4;
    case 'number':
      return 8;
    case 'string':
      return value.length * 2; // UTF-16 encoding
    case 'object':
      return calculateDataSize(value);
    default:
      return 0;
  }
}

/**
 * Generates a unique storage key with timestamp
 */
function generateStorageKey(prefix: string = 'key'): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substr(2, 9);
  return `${prefix}_${timestamp}_${random}`;
}

/**
 * Checks if a key matches a prefix pattern
 */
function matchesPrefix(key: string, prefix?: string): boolean {
  if (!prefix) return true;
  return key.startsWith(prefix);
}

/**
 * Filters keys by prefix
 */
function filterKeysByPrefix(keys: string[], prefix?: string): string[] {
  if (!prefix) return keys;
  return keys.filter(key => matchesPrefix(key, prefix));
}
