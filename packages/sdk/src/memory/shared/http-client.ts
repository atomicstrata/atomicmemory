/**
 * @file Shared HTTP Client for Memory Providers
 *
 * Provider-agnostic HTTP helpers wrapping fetch with timeout, auth headers,
 * and standardized error classification (MemoryProviderError / RateLimitError).
 *
 * Each provider creates a bound HttpClient via {@link createHttpClient} so that
 * errors are automatically tagged with the correct provider name.
 */

import { MemoryProviderError, RateLimitError } from '../errors';

export interface HttpOptions {
  apiUrl: string;
  apiKey?: string;
  timeout: number;
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
 * Perform a raw fetch with the provider's auth/timeout plumbing.
 */
async function performFetch(
  options: HttpOptions,
  path: string,
  init: RequestInit
): Promise<Response> {
  const url = `${options.apiUrl}${path}`;
  const headers = buildHeaders(options, init);
  return fetch(url, {
    ...init,
    headers,
    signal: AbortSignal.timeout(options.timeout),
  });
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
    const body = await response.text().catch(() => '');
    throw new MemoryProviderError(
      `HTTP ${response.status}: ${body || response.statusText}`,
      providerName,
      path
    );
  }
}

/**
 * Execute a fetch request and handle rate-limit / error responses.
 * Returns the raw Response on success.
 */
async function executeRequest(
  providerName: string,
  options: HttpOptions,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  const response = await performFetch(options, path, init);
  await throwForStatus(response, providerName, path);
  return response;
}

/**
 * Create a set of HTTP helper functions bound to a specific provider name.
 * Errors thrown by the returned functions will include the provider name
 * for consistent error attribution.
 */
export function createHttpClient(providerName: string): HttpClient {
  return {
    async fetchJson<T>(
      options: HttpOptions,
      path: string,
      init: RequestInit = {}
    ): Promise<T> {
      const response = await executeRequest(providerName, options, path, init);
      return (await response.json()) as T;
    },

    async fetchVoid(
      options: HttpOptions,
      path: string,
      init: RequestInit = {}
    ): Promise<void> {
      await executeRequest(providerName, options, path, init);
    },

    async fetchJsonOrNull<T>(
      options: HttpOptions,
      path: string,
      init: RequestInit = {}
    ): Promise<T | null> {
      const response = await performFetch(options, path, init);
      if (response.status === 404) return null;
      await throwForStatus(response, providerName, path);
      return (await response.json()) as T;
    },

    async deleteIgnore404(
      options: HttpOptions,
      path: string,
      init: RequestInit = {}
    ): Promise<void> {
      try {
        await executeRequest(providerName, options, path, { ...init, method: 'DELETE' });
      } catch (err: unknown) {
        if (err instanceof Error && err.message.includes('HTTP 404')) return;
        throw err;
      }
    },
  };
}
