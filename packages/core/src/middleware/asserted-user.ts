/**
 * @file `assertedUserGuard` — defense-in-depth middleware enforcing the
 * trusted-proxy identity contract.
 *
 * Background. In @atomicmemory/core the shared `CORE_API_KEY` (validated
 * by `require-bearer.ts`) authenticates the *caller process*, NOT the end
 * user. The `user_id` carried in request bodies/queries is **asserted by
 * the trusted caller** — the trusted control-plane caller — which must do
 * its own user authentication first. See `SECURITY.md` ("Trusted-Proxy
 * Identity Contract") for the blast-radius rationale.
 *
 * This guard does NOT replace that contract — it makes the proxy's user
 * assertion explicit so a daemon/proxy bug cannot silently cross-assert a
 * different user. When `trustedProxyMode` is enabled, every request that
 * carries a `user_id` MUST also carry the same value in the
 * `X-AtomicMemory-Asserted-User` header. A mismatch or a missing header on
 * a user-scoped request fails closed:
 *
 *   403 { error_code: 'asserted_user_mismatch', error: '<reason>' }
 *
 * When `trustedProxyMode` is disabled (the default), the guard is a
 * no-op and behavior is unchanged — single-user local deployments and
 * existing callers are unaffected.
 *
 * Placement. The guard must run AFTER body parsing (`express.json`) so it
 * can read the parsed wire `user_id`, and BEFORE per-route `validateBody`
 * transforms rename it to camelCase. It reads the user identity from every
 * channel core accepts: `req.body.user_id` (POST/PUT bodies),
 * `req.query.user_id` (GET/DELETE query routes), and the
 * `X-AtomicMemory-User-Id` header (the direct-storage surface). All are
 * cross-checked against the asserted-user header.
 */

import type { Request, RequestHandler, Response, NextFunction } from 'express';

/** Wire header the trusted proxy uses to restate the user it authenticated. */
export const ASSERTED_USER_HEADER = 'X-AtomicMemory-Asserted-User';

/** Header name in the lower-cased form Express exposes on `req.headers`. */
const ASSERTED_USER_HEADER_LOWER = ASSERTED_USER_HEADER.toLowerCase();

/** Lower-cased direct-storage owner header (`X-AtomicMemory-User-Id`). */
const STORAGE_USER_ID_HEADER_LOWER = 'x-atomicmemory-user-id';

/**
 * Build the asserted-user guard. `trustedProxyMode` is captured at
 * construction (mount) time and sourced from `RuntimeConfig`, never read
 * from `process.env` here — config lives at the process boundary.
 */
export function assertedUserGuard(trustedProxyMode: boolean): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!trustedProxyMode) {
      next();
      return;
    }
    const requestUserId = readRequestUserId(req);
    if (requestUserId === null) {
      // No user_id on this request — nothing to cross-check. Routes that
      // genuinely require a user_id still 400 in their own validation.
      next();
      return;
    }
    const assertedUser = readAssertedUserHeader(req);
    if (assertedUser === null) {
      respondMismatch(
        res,
        `trusted_proxy_mode requires the ${ASSERTED_USER_HEADER} header on user-scoped requests`,
      );
      return;
    }
    if (assertedUser !== requestUserId) {
      respondMismatch(
        res,
        `${ASSERTED_USER_HEADER} does not match the request user_id`,
      );
      return;
    }
    next();
  };
}

/**
 * Read the snake_case wire `user_id` from a parsed JSON body or the query
 * string. Returns `null` when absent or not a non-empty string — a present
 * user_id is the only thing this guard cross-checks.
 */
function readRequestUserId(req: Request): string | null {
  const fromBody = pickUserId(req.body);
  if (fromBody !== null) return fromBody;
  const fromQuery = pickUserId(req.query);
  if (fromQuery !== null) return fromQuery;
  return readStorageUserIdHeader(req);
}

function readStorageUserIdHeader(req: Request): string | null {
  const raw = req.headers[STORAGE_USER_ID_HEADER_LOWER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function pickUserId(source: unknown): string | null {
  if (typeof source !== 'object' || source === null) return null;
  const value = (source as Record<string, unknown>)['user_id'];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readAssertedUserHeader(req: Request): string | null {
  const raw = req.headers[ASSERTED_USER_HEADER_LOWER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function respondMismatch(res: Response, reason: string): void {
  res.status(403).json({ error_code: 'asserted_user_mismatch', error: reason });
}
