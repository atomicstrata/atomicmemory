/**
 * @file Bearer auth helpers for hosted MCP HTTP mode.
 *
 * Hosted multi-tenant auth accepts `Authorization: Bearer
 * <project API key>`, rejects missing/malformed credentials with HTTP
 * 401, and optionally validates the key against Cloud before binding a
 * session. Stdio mode does not use these helpers.
 */

import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

const BEARER_PREFIX = /^Bearer\s+(\S+)$/i;

/**
 * Lightweight authenticated Cloud probe. Core mounts it behind the same
 * Bearer check as every other /v1/memories route and answers 200 without
 * needing a user_id, so a 2xx is positive evidence that the key is valid.
 */
const DEFAULT_VALIDATE_PATH = '/v1/memories/health';

/** Upper bound on one key probe; a hung upstream must not hold the request. */
export const DEFAULT_AUTH_TIMEOUT_MS = 5_000;

/** How long a successful probe is reused before the key is re-checked. */
export const DEFAULT_AUTH_CACHE_TTL_MS = 60_000;

/** Bound on remembered keys so a flood of distinct valid keys stays small. */
const AUTH_CACHE_MAX_ENTRIES = 1_000;

export class UnauthorizedError extends Error {
  readonly statusCode = 401;

  constructor(message = 'Unauthorized') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

/**
 * The key could not be validated (upstream error, unexpected status,
 * network failure or timeout). Surfaced as HTTP 503, never as a session.
 */
export class AuthUnavailableError extends Error {
  readonly statusCode = 503;

  constructor(message = 'Unable to validate project API key', options?: ErrorOptions) {
    super(message, options);
    this.name = 'AuthUnavailableError';
  }
}

/** SHA-256 digest of an API key, used wherever keys are compared or indexed. */
export function hashApiKey(apiKey: string): Buffer {
  return createHash('sha256').update(apiKey, 'utf8').digest();
}

/**
 * Extract a Bearer token from an Authorization header value.
 * Returns null when the header is missing or not `Bearer <token>`.
 */
export function extractBearerToken(
  authorization: string | string[] | undefined,
): string | null {
  const header = Array.isArray(authorization) ? authorization[0] : authorization;
  if (!header) return null;
  const match = BEARER_PREFIX.exec(header.trim());
  if (!match) return null;
  const token = match[1]?.trim();
  return token ? token : null;
}

/**
 * Require a Bearer token from the request. Throws UnauthorizedError when
 * the header is missing or malformed.
 */
export function requireBearerToken(req: IncomingMessage): string {
  const token = extractBearerToken(req.headers.authorization);
  if (!token) {
    throw new UnauthorizedError(
      'Missing or malformed Authorization header; expected Bearer <project API key>',
    );
  }
  return token;
}

/**
 * Write a JSON 401 response. Safe to call before MCP transport handling.
 */
export function sendUnauthorized(
  res: ServerResponse,
  message = 'Unauthorized',
): void {
  if (res.headersSent) return;
  res.statusCode = 401;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('WWW-Authenticate', 'Bearer');
  res.end(JSON.stringify({ error: 'unauthorized', message }));
}

/**
 * Validate a project API key against the Cloud/core memory API.
 * Returns true when the key is accepted; false for 401/403. Throws
 * AuthUnavailableError when validity cannot be established.
 */
export type ApiKeyValidator = (
  apiUrl: string,
  apiKey: string,
) => Promise<boolean>;

export interface CloudApiKeyValidatorOptions {
  fetchImpl?: typeof fetch;
  path?: string;
  /** Probe timeout in milliseconds (default 5s). */
  timeoutMs?: number;
  /** Reuse a successful probe for this long; 0 disables caching (default 60s). */
  cacheTtlMs?: number;
  /** Clock override for tests. */
  now?: () => number;
}

/**
 * Build a validator that probes Cloud REST with the caller key.
 *
 * Only a 2xx response is accepted. 401/403 reject the key; any other
 * status, a network failure or a timeout throws AuthUnavailableError so
 * the caller answers 503 instead of opening a session on no evidence.
 * Successes are cached briefly under a hash of the key; failures never are.
 */
export function createCloudApiKeyValidator(
  options: CloudApiKeyValidatorOptions = {},
): ApiKeyValidator {
  const fetchImpl = options.fetchImpl ?? fetch;
  const path = options.path ?? DEFAULT_VALIDATE_PATH;
  const timeoutMs = options.timeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_AUTH_CACHE_TTL_MS;
  const now = options.now ?? Date.now;
  const validUntil = new Map<string, number>();

  return async (apiUrl: string, apiKey: string): Promise<boolean> => {
    const base = apiUrl.replace(/\/+$/, '');
    const url = `${base}${path.startsWith('/') ? path : `/${path}`}`;
    const cacheKey = createHash('sha256').update(url).update('\0').update(apiKey).digest('hex');
    const cachedUntil = validUntil.get(cacheKey);
    if (cachedUntil !== undefined) {
      if (cachedUntil > now()) return true;
      validUntil.delete(cacheKey);
    }

    const status = await probe(fetchImpl, url, apiKey, timeoutMs);
    if (status === 401 || status === 403) return false;
    if (status < 200 || status >= 300) {
      throw new AuthUnavailableError(`Key validation returned HTTP ${status}`);
    }
    if (cacheTtlMs > 0) remember(validUntil, cacheKey, now() + cacheTtlMs);
    return true;
  };
}

async function probe(
  fetchImpl: typeof fetch,
  url: string,
  apiKey: string,
  timeoutMs: number,
): Promise<number> {
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Only the status matters; release the connection.
    await response.body?.cancel().catch(() => undefined);
    return response.status;
  } catch (error) {
    throw new AuthUnavailableError('Key validation request failed', { cause: error });
  }
}

function remember(cache: Map<string, number>, key: string, until: number): void {
  if (cache.size >= AUTH_CACHE_MAX_ENTRIES) {
    // Maps iterate in insertion order, so this evicts the oldest entry.
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, until);
}
