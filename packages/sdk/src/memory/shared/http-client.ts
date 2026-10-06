/**
 * @file Shared HTTP Client for Memory Providers
 *
 * Provider-agnostic HTTP helpers wrapping fetch with timeout, auth headers,
 * and standardized error classification (MemoryProviderError / RateLimitError).
 *
 * Each provider creates a bound HttpClient via {@link createHttpClient} so that
 * errors are automatically tagged with the correct provider name.
 */

import {
  MemoryProviderError,
  MemoryTransportError,
  PendingIngestError,
  RateLimitError,
} from '../errors';

export interface HttpOptions {
  apiUrl: string;
  apiKey?: string;
  timeout: number;
  /** Ingest-only policy: accepted responses cannot be mapped to completed writes. */
  rejectAccepted?: boolean;
}

// fallow-ignore-next-line unused-type
export interface HttpClient {
  fetchJson: <T>(
    options: HttpOptions,
    path: string,
    init?: RequestInit
  ) => Promise<T>;

  fetchVoid: (
    options: HttpOptions,
    path: string,
    init?: RequestInit
  ) => Promise<void>;

  fetchJsonOrNull: <T>(
    options: HttpOptions,
    path: string,
    init?: RequestInit
  ) => Promise<T | null>;

  /** DELETE with 404 treated as a no-op per V3 contract. */
  deleteIgnore404: (
    options: HttpOptions,
    path: string,
    init?: RequestInit
  ) => Promise<void>;
}

/**
 * Build standard request headers with optional Bearer auth.
 */
function buildHeaders(
  options: HttpOptions,
  init: RequestInit
): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
    ...(init.headers as Record<string, string> | undefined),
  };
}

/**
 * Perform fetch and consume its response with the provider's auth/timeout plumbing.
 * Transport-level failures (connection refused, DNS, timeout, abort, body read) are
 * re-thrown as `MemoryTransportError` so callers see an actionable
 * "cannot reach <provider> at <url>" message instead of bare "fetch failed".
 */
async function performRequest<T>(
  options: HttpOptions,
  providerName: string,
  path: string,
  init: RequestInit,
  consume: (response: Response) => Promise<T>,
): Promise<T> {
  const url = `${options.apiUrl}${path}`;
  const headers = buildHeaders(options, init);
  let responseReceived = false;
  let signal: AbortSignal | undefined;
  try {
    const timeoutSignal = AbortSignal.timeout(options.timeout);
    signal = init.signal
      ? AbortSignal.any([init.signal, timeoutSignal])
      : timeoutSignal;
    const response = await fetch(url, {
      ...init,
      headers,
      signal,
    });
    responseReceived = true;
    return await consume(response);
  } catch (err) {
    if (responseReceived && !isResponseTransportError(err, signal)) throw err;
    if (responseReceived && signal?.aborted) {
      const name =
        signal.reason instanceof Error && signal.reason.name === 'TimeoutError'
          ? 'TimeoutError'
          : 'AbortError';
      throw new MemoryTransportError(
        providerName,
        path,
        url,
        new DOMException('Response body read cancelled', name),
      );
    }
    const cause = err instanceof Error ? err : new Error(String(err));
    throw new MemoryTransportError(providerName, path, url, cause);
  }
}

/** Fetch body readers reject cancellation or socket failure, not JSON syntax, as transport errors. */
function isResponseTransportError(
  error: unknown,
  signal?: AbortSignal,
): boolean {
  if (signal?.aborted && error === signal.reason) return true;
  return (
    error instanceof Error &&
    (error.name === 'AbortError' ||
      error.name === 'TimeoutError' ||
      (error instanceof TypeError && error.cause instanceof Error))
  );
}

/**
 * Translate a non-ok Response into the appropriate provider error, or
 * return null when the caller wants 404 pass-through.
 */
async function throwForStatus(
  response: Response,
  providerName: string,
  path: string
): Promise<void> {
  if (response.status === 429) {
    const retryAfter = response.headers.get('Retry-After');
    const retryMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : undefined;
    throw new RateLimitError(providerName, retryMs);
  }

  if (!response.ok) {
    const body = await response.text();
    throw new MemoryProviderError(
      `HTTP ${response.status}: ${body || response.statusText}`,
      providerName,
      path
    );
  }
}

/**
 * Execute a fetch request and handle rate-limit / error responses.
 * Consume the response inside the same transport error boundary as fetch.
 */
async function executeRequest<T>(
  providerName: string,
  options: HttpOptions,
  path: string,
  init: RequestInit,
  consume: (response: Response) => Promise<T>,
): Promise<T> {
  return performRequest(options, providerName, path, init, async (response) => {
    await throwForStatus(response, providerName, path);
    if (options.rejectAccepted && response.status === 202) {
      await response.body?.cancel();
      throw new PendingIngestError(providerName, path);
    }
    return consume(response);
  });
}

/**
 * Create a set of HTTP helper functions bound to a specific provider name.
 * Errors thrown by the returned functions will include the provider name
 * for consistent error attribution.
 */
export function createHttpClient(providerName: string): HttpClient {
  return {
    async fetchJson<T>(options: HttpOptions, path: string, init: RequestInit = {}): Promise<T> {
      return executeRequest(providerName, options, path, init,
        async (response) => (await response.json()) as T,
      );
    },

    async fetchVoid(options: HttpOptions, path: string, init: RequestInit = {}): Promise<void> {
      await executeRequest(providerName, options, path, init, async () => {});
    },

    async fetchJsonOrNull<T>(options: HttpOptions, path: string, init: RequestInit = {}): Promise<T | null> {
      return performRequest(options, providerName, path, init, async (response) => {
        if (response.status === 404) return null;
        await throwForStatus(response, providerName, path);
        return (await response.json()) as T;
      });
    },

    async deleteIgnore404(options: HttpOptions, path: string, init: RequestInit = {}): Promise<void> {
      try {
        await executeRequest(providerName, options, path,
          { ...init, method: 'DELETE' }, async () => {},
        );
      } catch (err: unknown) {
        if (err instanceof Error && err.message.includes('HTTP 404')) return;
        throw err;
      }
    },
  };
}
