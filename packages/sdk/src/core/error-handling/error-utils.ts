/**
 * @file AtomicMemory SDK Error Utilities
 *
 * This file provides utility functions and classes for error handling,
 * including error context building, error classification, and logging utilities.
 *
 * @example
 * ```typescript
 * import { ErrorContext, ErrorUtils } from './error-utils';
 *
 * const context = new ErrorContext()
 *   .add('operation', 'contextSearch')
 *   .add('query', searchQuery)
 *   .build();
 *
 * ErrorUtils.logError(error, context);
 * ```
 */

import { AtomicMemoryError } from './errors';
import {
  ErrorContextData,
  ErrorSanitizationOptions,
  SerializedError,
} from './types';
import { getLogger } from '../../utils/logger';
import { isDevelopmentEnvironment } from '../../utils/environment';

/**
 * Error context builder for consistent error reporting
 */
export class ErrorContext {
  private context: ErrorContextData = {};

  /**
   * Adds a key-value pair to the error context
   */
  // fallow-ignore-next-line unused-class-member
  add(key: keyof ErrorContextData, value: unknown): ErrorContext {
    (this.context as any)[key] = value;
    return this;
  }

  /**
   * Adds multiple key-value pairs to the error context
   */
  // fallow-ignore-next-line unused-class-member
  addAll(context: ErrorContextData): ErrorContext {
    Object.assign(this.context, context);
    return this;
  }

  /**
   * Builds and returns the context object
   */
  // fallow-ignore-next-line unused-class-member
  build(): ErrorContextData {
    return { ...this.context };
  }

  /**
   * Creates a new ErrorContext instance
   */
  static create(): ErrorContext {
    return new ErrorContext();
  }
}

/**
 * Utility functions for error handling and classification
 */
export const ErrorUtils = {
  /**
   * Checks if an error is retryable
   */
  isRetryable(error: Error): boolean {
    if (error instanceof AtomicMemoryError) {
      return error.retryable;
    }

    // Consider network errors and timeouts as retryable
    return (
      error.name === 'NetworkError' ||
      error.message.includes('timeout') ||
      error.message.includes('ECONNRESET') ||
      error.message.includes('ENOTFOUND')
    );
  },

  /**
   * Extracts error code from various error types
   */
  getErrorCode(error: Error): string {
    if (error instanceof AtomicMemoryError) {
      return error.code;
    }

    // Try to extract code from other error types
    if ('code' in error && typeof error.code === 'string') {
      return error.code;
    }

    return error.name || 'UNKNOWN_ERROR';
  },

  /**
   * Creates a user-friendly error message
   */
  getUserMessage(error: Error): string {
    if (error instanceof AtomicMemoryError) {
      switch (error.code) {
        case 'STORAGE_QUOTA_EXCEEDED':
          return 'Storage space is full. Please clear some data and try again.';
        case 'NETWORK_TIMEOUT':
          return 'Request timed out. Please check your connection and try again.';
        case 'EMBEDDING_MODEL_UNAVAILABLE':
          return 'AI model is temporarily unavailable. Please try again later.';
        default:
          return error.message;
      }
    }
    return 'An unexpected error occurred. Please try again.';
  },

  /**
   * Logs error with appropriate level based on error type
   */
  logError(error: Error, context?: ErrorContextData): void {
    const logger = getLogger('ErrorUtils');

    const logContext = {
      component: 'error-handling',
      errorName: error.name,
      errorCode: error instanceof AtomicMemoryError ? error.code : undefined,
      retryable: error instanceof AtomicMemoryError ? error.retryable : false,
      ...context,
    };

    if (error instanceof AtomicMemoryError) {
      if (error.retryable) {
        logger.warn('Retryable error occurred', logContext, error);
      } else {
        logger.error('Non-retryable error occurred', logContext, error);
      }
    } else {
      logger.error('Unexpected error occurred', logContext, error);
    }
  },

  /**
   * Wraps an error with additional context
   */
  wrapError(
    error: Error,
    message: string,
    code: string,
    context?: ErrorContextData
  ): AtomicMemoryError {
    return new AtomicMemoryError(message, code, {
      cause: error,
      context: {
        ...context,
        originalError: {
          name: error.name,
          message: error.message,
          stack: error.stack || 'No stack trace available',
        },
      },
      retryable: this.isRetryable(error),
    });
  },

  /**
   * Sanitizes error for safe serialization
   */
  sanitizeError(
    error: Error,
    options: ErrorSanitizationOptions = {}
  ): SerializedError {
    const sanitized: SerializedError = {
      name: error.name,
      message: error.message,
      timestamp: Date.now(),
      retryable: false,
    };

    if (error instanceof AtomicMemoryError) {
      sanitized.code = error.code;
      sanitized.retryable = error.retryable;
      sanitized.context = error.context;
    }

    // Only include stack trace if requested and in development
    if (options.includeStack && isDevelopmentEnvironment()) {
      sanitized.stack = error.stack;
    }

    return sanitized;
  },

  /**
   * Checks if an error indicates a quota/storage limit issue
   */
  isQuotaError(error: Error): boolean {
    const message = error.message.toLowerCase();
    return (
      message.includes('quota') ||
      message.includes('storage') ||
      message.includes('disk') ||
      message.includes('space') ||
      (error instanceof AtomicMemoryError && error.code.includes('QUOTA'))
    );
  },

  /**
   * Checks if an error indicates a network connectivity issue
   */
  isNetworkError(error: Error): boolean {
    return (
      error.name === 'NetworkError' ||
      error.message.includes('network') ||
      error.message.includes('connection') ||
      error.message.includes('timeout') ||
      (error instanceof AtomicMemoryError && error.code.startsWith('NETWORK_'))
    );
  },
};
