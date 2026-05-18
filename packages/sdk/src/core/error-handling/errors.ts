/**
 * @file AtomicMemory SDK Error Classes
 *
 * This file provides the error class hierarchy for the AtomicMemory SDK.
 * All SDK errors inherit from AtomicMemoryError and include structured
 * error codes, context, and retry information.
 *
 * @example
 * ```typescript
 * import { AtomicMemoryError, StorageError } from './errors';
 *
 * throw new StorageError('Database connection failed', 'CONNECTION_FAILED', {
 *   storage: { database: 'contexts', adapterType: 'indexeddb' },
 *   retryable: true
 * });
 * ```
 */

import { ErrorContextData, AtomicMemoryErrorOptions } from './types';

/**
 * Base error class for all AtomicMemory SDK errors
 */
export class AtomicMemoryError extends Error {
  public readonly code: string;
  public readonly context?: ErrorContextData;
  public readonly timestamp: number;
  public readonly retryable: boolean;
  public readonly originalError?: Error;

  constructor(
    message: string,
    code: string,
    options: AtomicMemoryErrorOptions = {}
  ) {
    super(message);
    this.name = 'AtomicMemoryError';
    this.code = code;
    this.context = options.context;
    this.timestamp = Date.now();
    this.retryable = options.retryable ?? false;
    this.originalError = options.cause;

    // Maintain proper stack trace
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, AtomicMemoryError);
    }
  }

  /**
   * Converts the error to a JSON-serializable object
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      context: this.context,
      timestamp: this.timestamp,
      retryable: this.retryable,
      stack: this.stack,
    };
  }
}

/**
 * Storage-related errors
 */
export class StorageError extends AtomicMemoryError {
  constructor(
    message: string,
    code: string,
    context?: ErrorContextData,
    retryable = false
  ) {
    super(message, `STORAGE_${code}`, { context, retryable });
    this.name = 'StorageError';
  }
}

/**
 * Embedding generation errors
 */
export class EmbeddingError extends AtomicMemoryError {
  constructor(
    message: string,
    code: string,
    context?: ErrorContextData,
    retryable = true
  ) {
    super(message, `EMBEDDING_${code}`, { context, retryable });
    this.name = 'EmbeddingError';
  }
}

/**
 * Search and retrieval errors
 */
export class SearchError extends AtomicMemoryError {
  constructor(
    message: string,
    code: string,
    context?: ErrorContextData,
    retryable = false,
    cause?: Error
  ) {
    super(message, `SEARCH_${code}`, { context, retryable, cause });
    this.name = 'SearchError';
  }
}

/**
 * Configuration errors
 */
export class ConfigurationError extends AtomicMemoryError {
  constructor(message: string, code: string, context?: ErrorContextData) {
    super(message, `CONFIG_${code}`, { context, retryable: false });
    this.name = 'ConfigurationError';
  }
}

/**
 * Network/API errors
 */
export class NetworkError extends AtomicMemoryError {
  constructor(
    message: string,
    code: string,
    context?: ErrorContextData,
    retryable = true
  ) {
    super(message, `NETWORK_${code}`, { context, retryable });
    this.name = 'NetworkError';
  }
}
