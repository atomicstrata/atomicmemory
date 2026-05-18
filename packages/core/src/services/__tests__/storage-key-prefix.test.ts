/**
 * Commit F regression tests for `deriveStorageKeyPrefix`.
 *
 * Invariants under test:
 *   - PII-safe shape — always 32 hex chars, never the raw userId;
 *   - deterministic — same `(secret, userId)` always derives the
 *     same prefix (so a same-bytes re-upload collides on the same
 *     backend key and the idempotency contract holds);
 *   - per-user separation — different `userId` values derive
 *     different prefixes (so backend ops can visually separate
 *     one user's artifacts from another);
 *   - per-secret separation — rotating the deployment secret
 *     produces a different prefix for the same user (so a stolen
 *     key listing from an old secret can't be re-correlated with
 *     a new secret's listings);
 *   - pinned vector — the canonical `(secret, userId)` pair from
 *     `.env.test` derives a fixed 32-hex output, locked here so
 *     a refactor that changes the HMAC input/encoding fails loudly.
 */

import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  STORAGE_KEY_PREFIX_LENGTH,
  deriveStorageKeyPrefix,
} from '../storage-key-prefix.js';
import { TEST_STORAGE_KEY_HMAC_SECRET } from '../../__tests__/helpers/storage-key-test-secret.js';

const SECRET = TEST_STORAGE_KEY_HMAC_SECRET;

function fullHmac(secret: string, userId: string): string {
  return createHmac('sha256', secret).update(userId).digest('hex');
}

describe('deriveStorageKeyPrefix — PII-safe shape', () => {
  it('returns 32 lowercase hex characters', () => {
    const prefix = deriveStorageKeyPrefix(SECRET, 'user-1');
    expect(prefix).toMatch(/^[0-9a-f]{32}$/);
    expect(prefix.length).toBe(STORAGE_KEY_PREFIX_LENGTH);
  });

  it('never echoes the raw userId in the output', () => {
    const userId = 'ethan@example.com';
    const prefix = deriveStorageKeyPrefix(SECRET, userId);
    expect(prefix).not.toContain(userId);
    expect(prefix).not.toContain('ethan');
    expect(prefix).not.toContain('@');
  });

  it('matches the leading 32 hex chars of the full HMAC-SHA256', () => {
    const userId = 'alpha-user';
    expect(deriveStorageKeyPrefix(SECRET, userId)).toBe(
      fullHmac(SECRET, userId).slice(0, STORAGE_KEY_PREFIX_LENGTH),
    );
  });
});

describe('deriveStorageKeyPrefix — determinism + separation', () => {
  it('is stable for the same (secret, userId) across calls', () => {
    expect(deriveStorageKeyPrefix(SECRET, 'user-1'))
      .toBe(deriveStorageKeyPrefix(SECRET, 'user-1'));
  });

  it('differs across users under the same secret', () => {
    expect(deriveStorageKeyPrefix(SECRET, 'user-A'))
      .not.toBe(deriveStorageKeyPrefix(SECRET, 'user-B'));
  });

  it('differs across secrets for the same user', () => {
    const otherSecret =
      'ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100';
    expect(deriveStorageKeyPrefix(SECRET, 'user-1'))
      .not.toBe(deriveStorageKeyPrefix(otherSecret, 'user-1'));
  });

  // Literal canonical vector. Computed once at commit time with
  // `createHmac('sha256', '000102…1e1f').update('user-1').digest('hex').slice(0,32)`
  // and pinned here. Re-computing the expected value inside the
  // test would let a subtle encoding/normalization regression
  // pass silently; a hardcoded value forces an intentional update.
  it('pins the canonical (.env.test secret, "user-1") output to b3d714c24994187e2246ee1e08228fc2', () => {
    expect(deriveStorageKeyPrefix(SECRET, 'user-1'))
      .toBe('b3d714c24994187e2246ee1e08228fc2');
  });

  it('pins additional canonical vectors so per-user separation is provably under contract', () => {
    expect(deriveStorageKeyPrefix(SECRET, 'user-A'))
      .toBe('9586dd30e8807e4a21b6343108390e48');
    expect(deriveStorageKeyPrefix(SECRET, 'user-B'))
      .toBe('5249c3705272bda10c2efbc3371e3124');
  });
});
