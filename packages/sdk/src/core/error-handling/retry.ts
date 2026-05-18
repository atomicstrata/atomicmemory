/**
 * @file AtomicMemory SDK Retry System
 *
 * This file provides retry mechanisms with exponential backoff for the AtomicMemory SDK.
 * It includes configurable retry policies and automatic retry logic for operations
 * that may fail due to transient issues.
 *
 * @example
 * ```typescript
 * import { RetryableOperation, withRetry } from './retry';
 *
 * const result = await withRetry(
 *   () => riskyOperation(),
 *   { maxAttempts: 3, initialDelay: 1000 }
 * );
 * ```
 */

import { AtomicMemoryError } from './errors';

/**
 * Retry policy configuration
 */
export interface RetryPolicy {
  /** Maximum number of retry attempts */
  maxAttempts: number;
  /** Initial delay in milliseconds */
  initialDelay: number;
  /** Maximum delay in milliseconds */
  maxDelay: number;
  /** Backoff multiplier */
  backoffMultiplier: number;
  /** Jitter factor (0-1) to add randomness */
  jitterFactor: number;
  /** Function to determine if an error should be retried */
  shouldRetry?: (error: Error, attempt: number) => boolean;
}

/**
 * Default retry policy (without shouldRetry function to avoid cloning issues)
 */
const DEFAULT_RETRY_POLICY: Omit<RetryPolicy, 'shouldRetry'> = {
  maxAttempts: 3,
  initialDelay: 1000, // 1 second
  maxDelay: 30000, // 30 seconds
  backoffMultiplier: 2,
  jitterFactor: 0.1,
};

/**
 * Default shouldRetry function
 */
const DEFAULT_SHOULD_RETRY = (error: Error, attempt: number) => {
  // Retry AtomicMemoryErrors that are marked as retryable
  if (error instanceof AtomicMemoryError) {
    return error.retryable && attempt < 3;
  }
  // Retry network errors and timeouts
  if (error.name === 'NetworkError' || error.message.includes('timeout')) {
    return attempt < 3;
  }
  return false;
};

/**
 * Retryable operation wrapper with exponential backoff
 */
export class RetryableOperation<T> {
  private policy: RetryPolicy;
  private operation: () => Promise<T>;

  constructor(operation: () => Promise<T>, policy: Partial<RetryPolicy> = {}) {
    this.operation = operation;
    this.policy = {
      ...DEFAULT_RETRY_POLICY,
      ...policy,
    };
  }

  /**
   * Executes the operation with retry logic
   */
  async execute(): Promise<T> {
    let lastError: Error | undefined;
    let attempt = 0;

    while (attempt < this.policy.maxAttempts) {
      try {
        const result = await this.operation();
        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        attempt++;

        // Check if we should retry
        const shouldRetry = this.policy.shouldRetry
          ? this.policy.shouldRetry(lastError, attempt)
          : this.defaultShouldRetry(lastError, attempt);

        if (!shouldRetry || attempt >= this.policy.maxAttempts) {
          break;
        }

        // Calculate delay with exponential backoff and jitter
        const delay = this.calculateDelay(attempt);
        await this.sleep(delay);
      }
    }

    // If we get here, all retries failed
    if (!lastError) {
      throw new AtomicMemoryError(
        'Operation failed with no error details',
        'RETRY_EXHAUSTED'
      );
    }

    throw new AtomicMemoryError(
      `Operation failed after ${attempt} attempts: ${lastError.message}`,
      'RETRY_EXHAUSTED',
      {
        cause: lastError,
        context: {
          attempts: attempt,
          policy: this.policy,
        },
      }
    );
  }

  /**
   * Default retry logic
   */
  private defaultShouldRetry(error: Error, attempt: number): boolean {
    // Retry AtomicMemoryErrors that are marked as retryable
    if (error instanceof AtomicMemoryError) {
      return error.retryable && attempt < this.policy.maxAttempts;
    }

    // Retry network errors and timeouts
    if (error.name === 'NetworkError' || error.message.includes('timeout')) {
      return attempt < this.policy.maxAttempts;
    }

    // Don't retry other errors by default
    return false;
  }

  /**
   * Calculates delay with exponential backoff and jitter
   */
  private calculateDelay(attempt: number): number {
    const baseDelay = Math.min(
      this.policy.initialDelay *
        Math.pow(this.policy.backoffMultiplier, attempt - 1),
      this.policy.maxDelay
    );

    // Add jitter to prevent thundering herd
    const jitter = baseDelay * this.policy.jitterFactor * Math.random();
    return Math.floor(baseDelay + jitter);
  }

  /**
   * Sleep for specified milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

/**
 * Utility function to wrap any async operation with retry logic
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  policy?: Partial<RetryPolicy>
): Promise<T> {
  const retryableOp = new RetryableOperation(operation, policy);
  return retryableOp.execute();
}
