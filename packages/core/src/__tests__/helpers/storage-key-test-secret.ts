/**
 * Deterministic HMAC secret shared across the test suite so the
 * derived storage-key prefix is stable regardless of which test
 * file ran first. The exact value matches `.env.test`'s
 * `STORAGE_KEY_HMAC_SECRET` so a test that goes through
 * `loadRuntimeConfig` vs. a test that constructs services directly
 * produce the same provider keys for the same user.
 *
 * 64 hex chars (32 bytes of entropy) — the same length the
 * config-time validator enforces in production.
 */
export const TEST_STORAGE_KEY_HMAC_SECRET =
  '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
