/**
 * @file Error Handling Type Definitions
 *
 * This file provides precise TypeScript types for the AtomicMemory SDK error handling system,
 * replacing generic Record<string, any> types with specific interfaces for better
 * type safety and error context management.
 *
 * @example
 * ```typescript
 * import { ErrorContextData, AtomicMemoryErrorOptions } from './types';
 *
 * const context: ErrorContextData = {
 *   operation: 'contextSearch',
 *   query: 'machine learning',
 *   timestamp: Date.now()
 * };
 * ```
 */

/**
 * Error severity levels
 */
type ErrorSeverity = 'low' | 'medium' | 'high' | 'critical';

/**
 * Error categories for classification
 */
type ErrorCategory =
  | 'storage'
  | 'network'
  | 'embedding'
  | 'search'
  | 'configuration'
  | 'validation'
  | 'authentication'
  | 'authorization'
  | 'rate-limit'
  | 'timeout'
  | 'unknown';

/**
 * Structured error context data - flexible interface for error context
 */
export interface ErrorContextData {
  /** The operation that was being performed */
  operation?: string;
  /** Component or module where the error occurred */
  component?: string;
  /** User ID or session ID for tracking */
  userId?: string;
  /** Request ID for correlation */
  requestId?: string;
  /** Timestamp when the error occurred */
  timestamp?: number;
  /** Storage key for storage operations */
  key?: string;
  /** Adapter type for storage operations */
  adapterType?: string;
  /** Number of attempts for retry operations */
  attempts?: number;
  /** Underlying cause error */
  cause?: Error | unknown;
  /** Input parameters that caused the error */
  input?: {
    /** Query string or search term */
    query?: string;
    /** Storage key */
    key?: string;
    /** File path or resource identifier */
    path?: string;
    /** Configuration values */
    config?: Record<string, unknown>;
  };
  /** Performance metrics at time of error */
  performance?: {
    /** Duration of the failed operation in milliseconds */
    duration?: number;
    /** Memory usage in bytes */
    memoryUsage?: number;
    /** CPU usage percentage */
    cpuUsage?: number;
  };
  /** Network-related context */
  network?: {
    /** HTTP status code */
    statusCode?: number;
    /** Request URL */
    url?: string;
    /** Request method */
    method?: string;
    /** Response headers */
    headers?: Record<string, string>;
  };
  /** Storage-related context */
  storage?: {
    /** Storage adapter type */
    adapterType?: string;
    /** Database name */
    database?: string;
    /** Table or collection name */
    table?: string;
    /** Storage size in bytes */
    size?: number;
  };
  /** Embedding-related context */
  embedding?: {
    /** Model name */
    model?: string;
    /** Text length */
    textLength?: number;
    /** Embedding dimensions */
    dimensions?: number;
    /** Batch size */
    batchSize?: number;
  };
  /** Search-related context */
  search?: {
    /** Search type */
    type?: string;
    /** Number of results requested */
    limit?: number;
    /** Similarity threshold */
    threshold?: number;
    /** Number of contexts searched */
    contextCount?: number;
  };
  /** Additional custom context - allows any additional properties */
  custom?: Record<string, unknown>;
  /** Allow any additional properties for flexibility */
  [key: string]: unknown;
}

/**
 * Options for creating AtomicMemoryError instances
 */
export interface AtomicMemoryErrorOptions {
  /** The underlying cause of this error */
  cause?: Error;
  /** Structured error context */
  context?: ErrorContextData;
  /** Whether this error is retryable */
  retryable?: boolean;
  /** Error severity level */
  severity?: ErrorSeverity;
  /** Error category for classification */
  category?: ErrorCategory;
  /** Whether to include stack trace */
  includeStack?: boolean;
}

/**
 * Error sanitization options
 */
export interface ErrorSanitizationOptions {
  /** Whether to include stack traces */
  includeStack?: boolean;
  /** Whether to include sensitive data */
  includeSensitive?: boolean;
  /** Maximum depth for nested objects */
  maxDepth?: number;
  /** Fields to exclude from sanitization */
  excludeFields?: string[];
}

/**
 * Serialized error format for JSON transmission
 */
export interface SerializedError {
  /** Error name */
  name: string;
  /** Error message */
  message: string;
  /** Error code */
  code?: string;
  /** Error context */
  context?: ErrorContextData;
  /** Timestamp */
  timestamp: number;
  /** Whether retryable */
  retryable: boolean;
  /** Stack trace (if included) */
  stack?: string;
  /** Error severity */
  severity?: ErrorSeverity;
  /** Error category */
  category?: ErrorCategory;
}
