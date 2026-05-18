/**
 * @file PII-safe storage-key prefix derivation.
 *
 * The storage-sibling plan removed plaintext `users/${userId}/...`
 * path segments from every provider key/URI we hand to a backend.
 * Replacement: an HMAC-SHA256 prefix that is:
 *
 *   - deterministic (same `(secret, userId)` → same 32-hex prefix),
 *     so retries / same-bytes re-uploads still collide on the same
 *     key and the idempotency contract holds end-to-end;
 *   - non-reversible (HMAC of a server-side secret), so an
 *     operator scanning backend listings cannot recover the
 *     `user_id` from a key — addresses the PII leak that motivated
 *     this commit;
 *   - per-user (different `userId` derives a different prefix), so
 *     ownership is still visually separable in the backend listing
 *     (one prefix = one user).
 *
 * Output shape: the leading 32 hex chars (16 bytes) of the HMAC.
 * 16 bytes is enough collision resistance — birthday at 2^64 over
 * the user-space — while keeping keys short. The `s/<hex32>/`
 * route is the only consumer; do NOT slice differently elsewhere.
 *
 * The secret is required at startup via
 * `RuntimeConfig.storageKeyHmacSecret`; callers thread it through
 * the service constructors. NEVER read `process.env` directly here.
 */

import { createHmac } from 'node:crypto';

/**
 * Length of the hex slice we keep as the per-user prefix.
 * Workspace constant — do not change without a key-migration plan
 * (existing keys would no longer collide with their re-upload).
 */
export const STORAGE_KEY_PREFIX_LENGTH = 32;

/**
 * Derive the per-user HMAC prefix used at the head of every
 * managed-storage key. Stable across retries; non-reversible.
 *
 * `secret` is the deployment-wide `STORAGE_KEY_HMAC_SECRET`. The
 * caller MUST source it from `RuntimeConfig.storageKeyHmacSecret`
 * (validated at startup as >=64 hex chars); never read env here.
 */
export function deriveStorageKeyPrefix(secret: string, userId: string): string {
  return createHmac('sha256', secret).update(userId).digest('hex').slice(0, STORAGE_KEY_PREFIX_LENGTH);
}
