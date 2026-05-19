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

/**
 * Transport-layer failure reaching the provider — connection refused,
 * timeout, DNS failure, abort, etc. Named `MemoryTransportError` to avoid
 * colliding with the generic `NetworkError` exported from
 * `src/core/error-handling/errors.ts` (different inheritance tree).
 */
export class MemoryTransportError extends MemoryProviderError {
  readonly url: string;
  readonly code: string | null;

  constructor(provider: string, operation: string, url: string, cause: Error) {
    const code = extractTransportErrorCode(cause);
    const reason = code ? `${code}` : cause.message || 'network error';
    super(
      `cannot reach ${provider} at ${url} (${reason}); is the service running?`,
      provider,
      operation,
      cause,
    );
    this.name = 'MemoryTransportError';
    this.url = url;
    this.code = code;
  }
}

/** Internal: walk an Error chain and pull out a node-style errno code. */
function extractTransportErrorCode(err: Error): string | null {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    const code = (current as Error & { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) return code;
    if (current.name === 'AbortError' || current.name === 'TimeoutError') {
      return current.name;
    }
    current = (current as Error & { cause?: unknown }).cause;
  }
  return null;
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
