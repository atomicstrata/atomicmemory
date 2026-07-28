/**
 * Cloud JWT user binding helpers shared by dual-auth and routers that
 * parse JSON after auth (e.g. `/v1/documents`).
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ASSERTED_USER_HEADER } from './asserted-user.js';

const ASSERTED_USER_HEADER_LOWER = ASSERTED_USER_HEADER.toLowerCase();

/** Read wire `user_id` from parsed body, query, or direct-storage header. */
function readRequestUserId(req: Request): string | null {
  const fromBody = pickUserId(req.body);
  if (fromBody !== null) return fromBody;
  const fromQuery = pickUserId(req.query);
  if (fromQuery !== null) return fromQuery;
  const raw = req.headers['x-atomicmemory-user-id'];
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

function respondForbidden(res: Response, reason: string): void {
  res.status(403).json({ error_code: 'forbidden', error: reason });
}

/**
 * When a JWT authenticated the request, wire `user_id` must match the
 * verified `memory_user_id` injected as {@link ASSERTED_USER_HEADER}.
 */
export function enforceMemoryUserBinding(
  req: Request,
  memoryUserId: string,
  res: Response,
): boolean {
  const requestUserId = readRequestUserId(req);
  if (requestUserId !== null && requestUserId !== memoryUserId) {
    respondForbidden(res, 'request user_id does not match token memory_user_id');
    return false;
  }
  return true;
}

/** Re-check binding after a router-owned body parser runs post-auth. */
function enforceCloudJwtUserBindingFromHeader(req: Request, res: Response): boolean {
  const assertedUser = readAssertedUserHeader(req);
  if (assertedUser === null) {
    return true;
  }
  return enforceMemoryUserBinding(req, assertedUser, res);
}

/** Express guard for routers that parse JSON after global auth. */
export function cloudJwtUserBindingGuard(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (enforceCloudJwtUserBindingFromHeader(req, res)) {
      next();
    }
  };
}

/** JWT-authenticated reconcile and similar routes: never run global scope. */
export function readAssertedUserId(req: Request): string | null {
  return readAssertedUserHeader(req);
}

/** Prefer explicit body user_id; otherwise scope JWT callers to asserted identity. */
export function resolveReconcileUserId(
  bodyUserId: string | undefined,
  assertedUserId: string | null,
): string | undefined {
  if (bodyUserId) {
    return bodyUserId;
  }
  return assertedUserId ?? undefined;
}
