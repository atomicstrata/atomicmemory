/**
 * Upstream AI provider error classification for HTTP routes.
 *
 * Provider SDKs expose slightly different error classes, but they
 * consistently carry an HTTP-ish `status` plus message text. This
 * module converts those raw SDK failures into a small sanitized
 * envelope for route handlers without coupling routes to one vendor.
 */

export interface UpstreamProviderFailure {
  status: number;
  errorCode: string;
  error: string;
  message: string;
  providerStatus: number;
  retryable: boolean;
  details: string;
}

export function classifyUpstreamProviderFailure(err: unknown): UpstreamProviderFailure | null {
  const providerStatus = readProviderStatus(err);
  if (providerStatus === null || !looksLikeProviderError(err, providerStatus)) return null;
  const details = sanitizeProviderDetails(errorMessage(err));
  if (providerStatus === 429 && isQuotaFailure(details)) {
    return providerFailure('upstream_provider_quota_exceeded', 503, providerStatus, false, details);
  }
  if (providerStatus === 429) {
    return providerFailure('upstream_provider_rate_limited', 503, providerStatus, true, details);
  }
  if (providerStatus === 401 || providerStatus === 403) {
    return providerFailure('upstream_provider_auth_failed', 502, providerStatus, false, details);
  }
  return providerFailure('upstream_provider_error', providerStatus >= 500 ? 503 : 502, providerStatus, providerStatus >= 500, details);
}

export function routeErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err ?? 'Internal server error');
}

function providerFailure(
  errorCode: string,
  status: number,
  providerStatus: number,
  retryable: boolean,
  details: string,
): UpstreamProviderFailure {
  const messages = providerFailureMessages(errorCode);
  return { status, errorCode, providerStatus, retryable, details, ...messages };
}

function providerFailureMessages(errorCode: string): Pick<UpstreamProviderFailure, 'error' | 'message'> {
  if (errorCode === 'upstream_provider_quota_exceeded') return quotaMessage();
  if (errorCode === 'upstream_provider_rate_limited') return rateLimitMessage();
  if (errorCode === 'upstream_provider_auth_failed') return authFailureMessage();
  return {
    error: 'Upstream provider request failed',
    message: 'The configured AI provider rejected the request. Check provider configuration and provider status.',
  };
}

function quotaMessage(): Pick<UpstreamProviderFailure, 'error' | 'message'> {
  return {
    error: 'Upstream provider quota exceeded',
    message: 'The configured AI provider rejected the request because its account quota or billing is unavailable.',
  };
}

function rateLimitMessage(): Pick<UpstreamProviderFailure, 'error' | 'message'> {
  return {
    error: 'Upstream provider rate limited',
    message: 'The configured AI provider rate-limited the request. Retry after the provider limit resets.',
  };
}

function authFailureMessage(): Pick<UpstreamProviderFailure, 'error' | 'message'> {
  return {
    error: 'Upstream provider authentication failed',
    message: 'The configured AI provider rejected the request credentials. Check the provider API key and account access.',
  };
}

function readProviderStatus(err: unknown): number | null {
  if (!err || typeof err !== 'object' || !('status' in err)) return null;
  const status = (err as { status?: unknown }).status;
  return typeof status === 'number' && Number.isInteger(status) ? status : null;
}

function looksLikeProviderError(err: unknown, status: number): boolean {
  const message = routeErrorMessage(err).toLowerCase();
  if (status === 401 || status === 403 || status === 429 || status >= 500) {
    return hasProviderErrorShape(err) || hasProviderKeyword(message);
  }
  return hasProviderErrorShape(err) && status >= 400;
}

function hasProviderErrorShape(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const candidate = err as Record<string, unknown>;
  return 'headers' in candidate || 'request_id' in candidate || 'code' in candidate || 'type' in candidate;
}

function hasProviderKeyword(message: string): boolean {
  return /\b(openai|anthropic|ollama|voyage|google|gemini|groq|provider|llm|embedding|embed|api key|quota|billing|rate limit)\b/.test(message);
}

function isQuotaFailure(details: string): boolean {
  return /\b(quota|billing|insufficient_quota|credits?)\b/i.test(details);
}

function errorMessage(err: unknown): string {
  return routeErrorMessage(err);
}

function sanitizeProviderDetails(message: string): string {
  return message
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[REDACTED_API_KEY]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED_TOKEN]')
    .slice(0, 500);
}
