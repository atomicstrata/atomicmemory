/**
 * @file RetryEngine — storage operation retry + abort + timeout helpers
 *
 * Extracted from StorageManager so the facade stays focused on adapter
 * dispatch and quorum logic. RetryEngine owns everything retry-related:
 * exponential backoff with jitter, abort-signal propagation, operation
 * timeouts, retry-attempt/success/failure event emission, and the
 * retryable-error classifier.
 *
 * Consumers pass an `operation` thunk plus a lightweight `RetryContext`
 * (operation name, optional key, optional signal); RetryEngine drives the
 * loop and surfaces the same events and log lines StorageManager emitted
 * before the split.
 */

import { StorageError } from '../core/error-handling/errors';
import { EventEmitter } from '../core/events';
import type { Logger } from '../utils/logger';

interface RetryPolicy {
  maxAttempts: number;
  initialDelay: number;
  maxDelay: number;
  backoffMultiplier: number;
  jitterFactor: number;
  maxTotalDuration?: number;
}

export interface RetryEngineConfig {
  retryPolicy: RetryPolicy;
  collectErrors: boolean;
}

interface RetryContext {
  operationName: string;
  key?: string;
  signal?: AbortSignal;
}

const RETRYABLE_PATTERNS = [
  /network/i,
  /timeout/i,
  /temporary/i,
  /unavailable/i,
  /connection/i,
  /ECONNRESET/i,
  /ENOTFOUND/i,
  /ETIMEDOUT/i,
];

export class RetryEngine {
  constructor(
    private readonly config: RetryEngineConfig,
    private readonly eventEmitter: EventEmitter,
    private readonly logger: Logger,
  ) {}

  async executeWithRetry<T>(
    operation: () => Promise<T>,
    context: RetryContext,
  ): Promise<T> {
    const { operationName, key, signal } = context;
    const { maxAttempts } = this.config.retryPolicy;
    let lastError: Error | undefined;
    const startTime = Date.now();

    this.checkAbortSignal(signal, 'Operation aborted before starting');

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        this.checkAbortSignal(signal, 'Operation aborted during retry');
        this.checkTotalDuration(startTime, 'before attempt');

        const result = await operation();
        this.handleRetrySuccess(attempt, startTime, operationName, key, lastError);
        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (signal?.aborted || lastError.message.includes('aborted')) {
          throw lastError;
        }

        const isRetryable = this.isRetryableError(lastError);
        const isFinalAttempt = !isRetryable || attempt >= maxAttempts;

        if (!isFinalAttempt) {
          this.checkTotalDuration(startTime, 'before retry decision');
        }

        this.emitStorageError(lastError, operationName, key, attempt, isFinalAttempt);

        if (isFinalAttempt) {
          this.handleFinalAttemptFailure(lastError, operationName, key, attempt, startTime);
          throw lastError;
        }

        const delay = this.calculateRetryDelay(attempt);
        this.emitRetryAttempt(operationName, key, attempt, delay, lastError, isRetryable);
        await this.delayWithAbort(delay, signal);
      }
    }

    throw lastError!;
  }

  async withTimeout<T>(operation: () => Promise<T>, timeout: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new StorageError('Operation timed out', 'TIMEOUT', {}, true));
      }, timeout);

      operation()
        .then(resolve)
        .catch(reject)
        .finally(() => clearTimeout(timer));
    });
  }

  private checkAbortSignal(signal: AbortSignal | undefined, message: string): void {
    if (signal?.aborted) {
      throw new Error(message);
    }
  }

  private checkTotalDuration(startTime: number, context: string): void {
    const limit = this.config.retryPolicy.maxTotalDuration;
    if (!limit) return;

    const elapsed = Date.now() - startTime;
    if (elapsed >= limit) {
      throw new Error(
        `Operation exceeded maximum total duration of ${limit}ms (${context})`,
      );
    }
  }

  private handleRetrySuccess(
    attempt: number,
    startTime: number,
    operationName: string,
    key: string | undefined,
    lastError: Error | undefined,
  ): void {
    if (attempt <= 1) return;

    const totalDuration = Date.now() - startTime;
    this.eventEmitter.emit('storageRetrySuccess', {
      operation: operationName,
      key,
      attemptNumber: attempt,
      totalAttempts: attempt,
      totalDuration,
      finalError: lastError?.message,
    });

    this.logger.info('Operation succeeded after retries', {
      component: 'storage-manager',
      operation: operationName,
      key,
      attemptNumber: attempt,
      totalDuration,
      finalError: lastError?.message,
    });
  }

  private emitStorageError(
    error: Error,
    operationName: string,
    key: string | undefined,
    attempt: number,
    isFinalAttempt: boolean,
  ): void {
    if (!this.config.collectErrors) return;

    this.eventEmitter.emit('storageError', {
      error,
      operation: operationName,
      key,
      retryCount: attempt - 1,
      attemptNumber: attempt,
      finalAttempt: isFinalAttempt,
      success: false,
    });
  }

  private handleFinalAttemptFailure(
    error: Error,
    operationName: string,
    key: string | undefined,
    attempt: number,
    startTime: number,
  ): void {
    this.logger.error('Operation failed after all retry attempts', {
      component: 'storage-manager',
      operation: operationName,
      key,
      totalAttempts: attempt,
      finalError: error.message,
      totalDuration: Date.now() - startTime,
    });
  }

  private calculateRetryDelay(attempt: number): number {
    const { initialDelay, backoffMultiplier, maxDelay, jitterFactor } =
      this.config.retryPolicy;
    const baseDelay = Math.min(
      initialDelay * Math.pow(backoffMultiplier, attempt - 1),
      maxDelay,
    );
    const jitter = baseDelay * jitterFactor * Math.random();
    return Math.floor(baseDelay + jitter);
  }

  private emitRetryAttempt(
    operationName: string,
    key: string | undefined,
    attempt: number,
    delay: number,
    error: Error,
    isRetryable: boolean,
  ): void {
    const payload = {
      operation: operationName,
      key,
      attemptNumber: attempt,
      maxAttempts: this.config.retryPolicy.maxAttempts,
      delay,
      error: error.message,
      isRetryable,
    };

    this.eventEmitter.emit('storageRetryAttempt', payload);
    this.logger.debug('Retrying operation after failure', {
      component: 'storage-manager',
      ...payload,
    });
  }

  private async delayWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('Operation aborted during delay'));
        return;
      }

      let abortHandler: (() => void) | undefined;

      const timeout = setTimeout(() => {
        if (signal && abortHandler) {
          signal.removeEventListener('abort', abortHandler);
        }
        resolve();
      }, ms);

      if (signal) {
        abortHandler = () => {
          clearTimeout(timeout);
          reject(new Error('Operation aborted during delay'));
        };
        signal.addEventListener('abort', abortHandler, { once: true });
      }
    });
  }

  private isRetryableError(error: Error): boolean {
    if (error instanceof StorageError) {
      return error.retryable;
    }
    return RETRYABLE_PATTERNS.some(
      pattern => pattern.test(error.message) || pattern.test(error.name),
    );
  }
}
