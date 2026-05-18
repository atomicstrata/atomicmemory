/** @file Public re-exports for the SDK error-handling module (types, classes, retry). */

export {
  AtomicMemoryError,
  StorageError,
  EmbeddingError,
  SearchError,
  ConfigurationError,
  NetworkError,
} from './errors';

export type { RetryPolicy } from './retry';
export {
  RetryableOperation,
  withRetry,
} from './retry';

export { ErrorContext, ErrorUtils } from './error-utils';
