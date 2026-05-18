/**
 * @file Shared test helper for the new auth + identity contract.
 *
 * Every `/v1/*` route is protected by the `requireBearer` middleware
 * (see `src/middleware/require-bearer.ts`); storage routes additionally
 * read owner scope from `X-AtomicMemory-User-Id`. Tests reach those
 * routes via `globalThis.fetch`, and each call site MUST send these
 * headers explicitly — there is no global interceptor, so the test
 * suite proves callers really set auth.
 *
 * Importers:
 *   import { authHeader, authHeaderWithUser } from '../../__tests__/helpers/auth-headers.js';
 *
 *   await fetch(url, { headers: authHeader() });
 *   await fetch(url, { headers: authHeaderWithUser('u1') });
 *   await fetch(url, { headers: { ...authHeader(), 'Content-Type': 'application/json' } });
 *
 * The helper reads `coreApiKey` from the central runtime config
 * (`src/config.ts`) so it stays in sync with the same key the live
 * server validates against; `.env.test` populates the config at
 * import time via the Vitest setup file.
 *
 * This file lives under `src/__tests__/helpers/` (test-only).
 * `config-singleton-audit.test.ts` excludes `__tests__/**` from the
 * singleton-import count, so importing `config` here does not
 * regress the workspace's config-threading ratchet.
 */

import { config as runtimeConfig } from '../../config.js';

const USER_ID_HEADER = 'X-AtomicMemory-User-Id';

/**
 * Build the `Authorization: Bearer <coreApiKey>` header pair tests
 * pass to /v1/* routes. Throws when the configured key is empty so
 * test authors notice broken setup instead of silently sending a
 * wrong key.
 */
export function authHeader(): Record<string, string> {
  const key = runtimeConfig.coreApiKey;
  if (key === undefined || key.length === 0) {
    throw new Error(
      'authHeader: runtimeConfig.coreApiKey is empty. Tests must load .env.test before calling.',
    );
  }
  return { Authorization: `Bearer ${key}` };
}

/**
 * Same as `authHeader` plus the `X-AtomicMemory-User-Id` header
 * storage routes require for owner scope. Other authenticated routers
 * (memories, documents, agents) still read user_id from query/body
 * in this pass; they use plain `authHeader()` instead.
 */
export function authHeaderWithUser(userId: string): Record<string, string> {
  return {
    ...authHeader(),
    [USER_ID_HEADER]: userId,
  };
}
