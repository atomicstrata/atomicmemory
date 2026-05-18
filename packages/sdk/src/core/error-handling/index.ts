/**
 * @file AtomicMemory SDK Error Handling Module
 *
 * This module provides comprehensive error handling for the AtomicMemory SDK including
 * custom error types, retry mechanisms with exponential backoff, and error
 * classification for appropriate handling strategies.
 *
 * The error handling system features:
 * - Strongly typed error hierarchy
 * - Automatic retry with exponential backoff
 * - Error context and metadata tracking
 * - Integration with the event system
 * - Configurable retry policies
 *
 * @example
 * ```typescript
 * import { AtomicMemoryError, RetryableOperation, withRetry } from './error-handling';
 *
 * const operation = new RetryableOperation(async () => {
 *   // Some operation that might fail
 *   return await riskyOperation();
 * });
 *
 * const result = await operation.execute();
 * ```
 */

// Export all error classes
export {
  AtomicMemoryError,
  StorageError,
  EmbeddingError,
  SearchError,
  ConfigurationError,
  NetworkError,
} from './errors';

// Export retry system
export type { RetryPolicy } from './retry';
export {
  RetryableOperation,
  withRetry,
} from './retry';

// Export error utilities
export { ErrorContext, ErrorUtils } from './error-utils';
