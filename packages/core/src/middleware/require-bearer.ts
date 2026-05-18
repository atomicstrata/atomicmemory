/**
 * @file `requireBearer` — Express middleware that validates the
 * `Authorization: Bearer <token>` header against a configured shared
 * key in constant time.
 *
 * Mounted in front of every SDK-facing `/v1/*` router by
 * `src/app/create-app.ts`. Public probes (`/health`, `/openapi.json`)
 * stay outside the protected scope.
 *
 * Failure response:
 *
 *   401 { error_code: 'unauthenticated', error: '<reason>' }
 *
 * The wire envelope intentionally distinguishes "missing header"
 * from "wrong key" only by `error` text; both share the same
 * `error_code` so caller logic does not branch on the difference
 * (preventing oracle-style probing of valid header shape).
 */

import { timingSafeEqual } from 'node:crypto';
import type { Request, RequestHandler, Response, NextFunction } from 'express';

const BEARER_PREFIX = 'Bearer ';

/**
 * Build a middleware that admits a request only when its
 * `Authorization` header carries the configured shared key. The
 * expected key is captured at construction time so a config rotation
 * requires a server restart (matches the rest of the runtime-config
 * model).
 */
export function requireBearer(expectedApiKey: string): RequestHandler {
  if (typeof expectedApiKey !== 'string' || expectedApiKey.length === 0) {
    throw new Error('requireBearer: expectedApiKey must be a non-empty string');
  }
  const expectedBuffer = Buffer.from(expectedApiKey, 'utf8');
  return (req: Request, res: Response, next: NextFunction): void => {
    const headerValue = readAuthorizationHeader(req);
    if (headerValue === null) {
      respondUnauthenticated(res, 'missing or malformed Authorization header');
      return;
    }
    const providedBuffer = Buffer.from(headerValue, 'utf8');
    if (providedBuffer.length !== expectedBuffer.length) {
      respondUnauthenticated(res, 'invalid api key');
      return;
    }
    if (!timingSafeEqual(providedBuffer, expectedBuffer)) {
      respondUnauthenticated(res, 'invalid api key');
      return;
    }
    next();
  };
}

function readAuthorizationHeader(req: Request): string | null {
  const raw = req.headers['authorization'];
  if (typeof raw !== 'string' || !raw.startsWith(BEARER_PREFIX)) return null;
  const token = raw.slice(BEARER_PREFIX.length).trim();
  return token.length > 0 ? token : null;
}

function respondUnauthenticated(res: Response, reason: string): void {
  res.status(401).json({ error_code: 'unauthenticated', error: reason });
}
