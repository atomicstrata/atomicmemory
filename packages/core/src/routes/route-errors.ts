/**
 * Shared error handling utilities for Express route handlers.
 *
 * Request-input validation is performed by the Zod-based
 * `validateBody` / `validateQuery` / `validateParams` middleware in
 * `src/middleware/validate.ts`, which emits 400 responses directly.
 * Most uncaught service-layer failures stay 500. Upstream AI provider
 * failures get a sanitized operator-facing envelope.
 */

import type { Response } from 'express';
import {
  classifyUpstreamProviderFailure,
  routeErrorMessage,
} from './upstream-provider-errors.js';
import { NulByteParameterError } from '../db/nul-guard.js';

/** Log the error and send the public JSON error response. */
export function handleRouteError(res: Response, context: string, err: unknown): void {
  // The pg query-layer backstop (`db/nul-guard.ts`) throws when a bound
  // parameter carries a NUL byte. It is client input that Postgres cannot
  // store, so it maps to a validated 400 rather than the default 500.
  if (err instanceof NulByteParameterError) {
    console.warn(`${context}: rejected a NUL byte in a bound query parameter`);
    res.status(400).json({ error: 'request must not contain NUL bytes' });
    return;
  }
  const internalMessage = routeErrorMessage(err);
  const stack = err instanceof Error ? err.stack : undefined;
  const upstream = classifyUpstreamProviderFailure(err);
  if (upstream) {
    console.error(`${context} error: [${upstream.status}] upstream provider ${upstream.providerStatus}: ${internalMessage}${stack ? `\n${stack}` : ''}`);
    res.status(upstream.status).json({
      error_code: upstream.errorCode,
      error: upstream.error,
      message: upstream.message,
      provider_status: upstream.providerStatus,
      retryable: upstream.retryable,
      details: upstream.details,
    });
    return;
  }
  console.error(`${context} error: [500] ${internalMessage}${stack ? `\n${stack}` : ''}`);
  res.status(500).json({ error: 'Internal server error' });
}
