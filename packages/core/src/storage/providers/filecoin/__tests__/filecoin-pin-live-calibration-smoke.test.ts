/**
 * @file Opt-in live calibration smoke for the Phase 5
 * `filecoin_pin` driver. Mirrors `live-calibration-smoke.test.ts`
 * (the direct-Synapse smoke) but constructs the backend with
 * `RAW_STORAGE_FILECOIN_DRIVER=filecoin_pin` so the CAR-first
 * upload path runs end-to-end against the real Synapse SDK on
 * calibration.
 *
 * Gates:
 *   - `FILECOIN_PIN_LIVE_TESTS=1`        enables the suite.
 *   - `FILECOIN_PIN_LIVE_TIMEOUT_MS`     upload-timeout cap (default 600000).
 *
 * Each assertion enforces a Phase 5 contract:
 *   - upload returns a `filecoin://piece/<canonicalPieceCid>`
 *     URI AND populates the optional `ipfs_cid` sidecar slot
 *     (the concrete value-add of the CAR-first path);
 *   - the canonical PieceCID is the same shape direct-driver
 *     uploads emit (sanitization invariants hold);
 *   - the `get()` round-trip recovers the original bytes (the
 *     CAR-unwrap symmetry pinned by `filecoin-pin-car.test.ts`
 *     holds in production too);
 *   - delete semantics stay `tombstone` (delegate to Synapse).
 *
 * Safety: refuses to run against mainnet. No secrets ever cross
 * an assertion or `console.*` call.
 */

import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SIZE_CONSTANTS } from '@filoz/synapse-sdk';
import { parseFilecoinProviderConfig } from '../config.js';
import { createFilecoinStorageBackend } from '../index.js';
import type { RawContentStore, StoredRawContent } from '../../../raw-content-store.js';

const LIVE = process.env['FILECOIN_PIN_LIVE_TESTS'] === '1';
const TIMEOUT_MS = (() => {
  const raw = process.env['FILECOIN_PIN_LIVE_TIMEOUT_MS'];
  if (raw === undefined || raw === '') return 600_000;
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(`FILECOIN_PIN_LIVE_TIMEOUT_MS must be a positive integer (got '${raw}').`);
  }
  return Number.parseInt(raw, 10);
})();

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

describe.skipIf(!LIVE)(
  'Filecoin filecoin_pin live calibration smoke (CAR-first upload path)',
  () => {
    let store: RawContentStore;
    let payload: Buffer;
    let expectedHash: string;
    let stored: StoredRawContent | null = null;

    beforeAll(async () => {
      const config = parseFilecoinProviderConfig({
        ...process.env,
        // Force the filecoin_pin driver — the operator's env may
        // be set to `synapse` (the default); the live smoke
        // specifically exercises the Phase 5 driver.
        RAW_STORAGE_FILECOIN_DRIVER: 'filecoin_pin',
      });
      if (config.network !== 'calibration') {
        throw new Error(
          `filecoin_pin live smoke refuses network='${config.network}'. ` +
            'Set RAW_STORAGE_FILECOIN_NETWORK=calibration.',
        );
      }
      store = await createFilecoinStorageBackend(config);
      // Use the SDK-advertised minimum upload size (or the
      // configured override). The same constant the direct-driver
      // smoke uses, so the two suites compare like-for-like.
      const minBytes = config.minUploadBytes ?? SIZE_CONSTANTS.MIN_UPLOAD_SIZE;
      payload = Buffer.alloc(minBytes, 0x61);
      expectedHash = sha256Hex(payload);
    }, TIMEOUT_MS);

    it('upload returns a filecoin://piece URI + populated ipfs_cid sidecar', async () => {
      stored = await store.put({ key: 'k', body: payload });
      expect(stored.storageUri).toMatch(/^filecoin:\/\/piece\/b[a-z2-7]+$/);
      const sidecar = (stored.providerMetadata as { filecoin: Record<string, unknown> }).filecoin;
      expect(typeof sidecar['piece_cid']).toBe('string');
      // Phase 5 contract: the filecoin-pin path populates ipfs_cid.
      expect(typeof sidecar['ipfs_cid']).toBe('string');
      expect(sidecar['driver']).toBe('filecoin_pin');
    }, TIMEOUT_MS);

    it('get() retrieves bytes equal to the upload + sha256 matches plaintext', async () => {
      expect(stored).not.toBeNull();
      const out = await store.get(stored!.storageUri);
      expect(Buffer.compare(out.body, payload)).toBe(0);
      expect(sha256Hex(out.body)).toBe(expectedHash);
    }, TIMEOUT_MS);

    afterAll(async () => {
      if (stored === null) return;
      // Delete-semantics invariant: the filecoin_pin driver
      // delegates delete to the Synapse client → same
      // `tombstone` semantics as direct upload.
      const sidecar = (stored.providerMetadata as { filecoin: Record<string, unknown> }).filecoin;
      const result = await store.delete(stored.storageUri, { filecoin: sidecar });
      expect(result.semantics).toBe('tombstoned');
    }, TIMEOUT_MS);
  },
);

describe('Filecoin filecoin_pin live smoke — gated off by default', () => {
  it('skips everything unless FILECOIN_PIN_LIVE_TESTS=1', () => {
    if (LIVE) return;
    expect(LIVE).toBe(false);
  });
});
