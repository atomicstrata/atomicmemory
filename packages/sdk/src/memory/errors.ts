/**
 * @file V3 Memory Provider Errors
 *
 * Standardized error hierarchy for memory provider operations.
 * Every provider adapter must throw these instead of raw errors.
 */

/** Base class for all provider errors. */
export class MemoryProviderError extends Error {
  constructor(
    message: string,
    public readonly provider: string,
    public readonly operation: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'MemoryProviderError';
  }
}

/** Caller invoked an extension the provider does not support. */
export class UnsupportedOperationError extends MemoryProviderError {
  constructor(provider: string, operation: string) {
    super(
      `${provider} does not support ${operation}`,
      provider,
      operation
    );
    this.name = 'UnsupportedOperationError';
  }
}

/** Required scope fields are missing or invalid. */
export class InvalidScopeError extends MemoryProviderError {
  constructor(provider: string, missing: string[]) {
    super(
      `${provider} requires scope fields: ${missing.join(', ')}`,
      provider,
      'scope-validation'
    );
    this.name = 'InvalidScopeError';
  }
}

/** Provider-side rate limit or quota exceeded. */
export class RateLimitError extends MemoryProviderError {
  readonly retryAfterMs?: number;

  constructor(provider: string, retryAfterMs?: number) {
    super(`${provider} rate limit exceeded`, provider, 'rate-limit');
    this.name = 'RateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}
