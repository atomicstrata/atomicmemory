/**
 * @file Tests for `FilecoinPinFilecoinProviderClient.put`.
 *
 * The driver builds a CAR from the put body, hands it to
 * `filecoin-pin/core/upload.executeUpload`, and maps the SDK-
 * shaped result back to the provider-neutral `FilecoinPutResult`.
 * These tests pin every observable contract that result-mapping
 * implies WITHOUT calling the real Synapse SDK:
 *
 *   - `pieceCid` / `storageUri` round-trip from the SDK result.
 *   - `ipfsCid` reflects the CAR's actual root CID (not a value
 *     the SDK fabricated).
 *   - `sizeBytes` reports the CAR's byte count, NOT the raw
 *     input length — the upload boundary persisted bytes are the
 *     CAR, so the sidecar should reflect what actually went onto
 *     disk.
 *   - `copies[].providerId` / `dataSetId` / `pieceId` are
 *     stringified bigints (closed bigint-to-string boundary).
 *   - `failedAttempts[].errorCode` is the closed
 *     `filecoin_pin_copy_failed` literal — the SDK's raw error
 *     message NEVER crosses the boundary.
 *   - Upload failures surface as
 *     `FilecoinProviderError('filecoin_pin_upload_failed', …)`
 *     with a sanitized message.
 *
 * `executeUpload` is intercepted via `vi.mock`. The fake stays
 * vendor-free aside from the import path itself.
 */

import { describe, expect, it, vi } from 'vitest';
import { CarReader } from '@ipld/car';
import { FilecoinPinFilecoinProviderClient } from '../filecoin-pin-client.js';
import { FilecoinProviderError } from '../errors.js';
import { REAL_PIECE_CID_A } from '../../../__tests__/filecoin-cid-fixtures.js';
import { fakeDelegate, fakeSynapse, uploadResultFixture } from './filecoin-pin-test-fixtures.js';

const mockExecuteUpload = vi.fn();
vi.mock('filecoin-pin/core/upload', () => ({
  executeUpload: (...args: unknown[]) => mockExecuteUpload(...args),
}));

const HELLO = Buffer.from('hello filecoin-pin');

describe('FilecoinPinFilecoinProviderClient.put — result-shape mapping', () => {
  it('maps a successful upload to the canonical FilecoinPutResult', async () => {
    mockExecuteUpload.mockReset();
    mockExecuteUpload.mockResolvedValueOnce(uploadResultFixture());
    const client = new FilecoinPinFilecoinProviderClient(fakeSynapse, fakeDelegate);
    const result = await client.put({ key: 'k', body: HELLO });
    expect(result.pieceCid).toBe(REAL_PIECE_CID_A);
    expect(result.storageUri).toBe(`filecoin://piece/${REAL_PIECE_CID_A}`);
    expect(result.copies).toEqual([
      { providerId: '4', dataSetId: '42', pieceId: '7', role: 'primary' },
      { providerId: '9', dataSetId: '42', pieceId: '7', role: 'secondary' },
    ]);
    expect(result.complete).toBe(true);
    expect(result.requestedCopies).toBe(2);
    expect(result.failedAttempts).toEqual([]);
  });

  it('populates `ipfsCid` with the CAR root CID (CIDv1 base32-lower)', async () => {
    mockExecuteUpload.mockReset();
    mockExecuteUpload.mockResolvedValueOnce(uploadResultFixture());
    const client = new FilecoinPinFilecoinProviderClient(fakeSynapse, fakeDelegate);
    const result = await client.put({ key: 'k', body: HELLO });
    expect(result.ipfsCid).toMatch(/^b[a-z2-7]+$/);
    // The CAR handed to executeUpload must declare the SAME root.
    const [, carData] = mockExecuteUpload.mock.calls[0]!;
    const reader = await CarReader.fromBytes(Buffer.from(carData as Uint8Array));
    const roots = await reader.getRoots();
    expect(roots[0]!.toString()).toBe(result.ipfsCid);
  });

  it('reports `sizeBytes` as the CAR byte count, not the raw input length', async () => {
    mockExecuteUpload.mockReset();
    mockExecuteUpload.mockResolvedValueOnce(uploadResultFixture());
    const client = new FilecoinPinFilecoinProviderClient(fakeSynapse, fakeDelegate);
    const result = await client.put({ key: 'k', body: HELLO });
    const [, carData] = mockExecuteUpload.mock.calls[0]!;
    expect(result.sizeBytes).toBe((carData as Uint8Array).byteLength);
    expect(result.sizeBytes).toBeGreaterThan(HELLO.length);
  });
});

describe('FilecoinPinFilecoinProviderClient.put — sanitization + error mapping', () => {
  it('maps SDK upload failure to FilecoinProviderError("filecoin_pin_upload_failed")', async () => {
    mockExecuteUpload.mockReset();
    mockExecuteUpload.mockRejectedValueOnce(new Error('PLANTED-VENDOR-MESSAGE'));
    const client = new FilecoinPinFilecoinProviderClient(fakeSynapse, fakeDelegate);
    let caught: unknown;
    try {
      await client.put({ key: 'k', body: HELLO });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FilecoinProviderError);
    expect((caught as FilecoinProviderError).errorCode).toBe('filecoin_pin_upload_failed');
    expect((caught as Error).message).not.toContain('PLANTED-VENDOR-MESSAGE');
  });

  it('failed-attempt entries strip the raw vendor `error` string', async () => {
    mockExecuteUpload.mockReset();
    mockExecuteUpload.mockResolvedValueOnce(
      uploadResultFixture({
        failedAttempts: [
          { providerId: 9n, role: 'secondary', error: 'PLANTED-SP-RPC-LEAK', explicit: false },
        ],
      }),
    );
    const client = new FilecoinPinFilecoinProviderClient(fakeSynapse, fakeDelegate);
    const result = await client.put({ key: 'k', body: HELLO });
    expect(result.failedAttempts).toEqual([
      { providerId: '9', role: 'secondary', errorCode: 'filecoin_pin_copy_failed', explicit: false },
    ]);
    expect(JSON.stringify(result)).not.toContain('PLANTED-SP-RPC-LEAK');
  });
});

describe('FilecoinPinFilecoinProviderClient.put — boundary identity', () => {
  it('passes the configured copies + providerIds through to executeUpload', async () => {
    mockExecuteUpload.mockReset();
    mockExecuteUpload.mockResolvedValueOnce(uploadResultFixture());
    const client = new FilecoinPinFilecoinProviderClient(fakeSynapse, fakeDelegate, {
      copies: 3,
      providerIds: ['4', '9'],
    });
    await client.put({ key: 'k', body: HELLO });
    const [, , , options] = mockExecuteUpload.mock.calls[0]!;
    const opts = options as Record<string, unknown>;
    expect(opts.copies).toBe(3);
    expect(opts.providerIds).toEqual([4n, 9n]);
    // IPNI announcement validation is bypassed — the driver does
    // not block `put` on a global IPNI lookup.
    expect((opts.ipniValidation as Record<string, unknown>).enabled).toBe(false);
  });

  it('advertises driver=filecoin_pin and provider=filecoin on the boundary', () => {
    const client = new FilecoinPinFilecoinProviderClient(fakeSynapse, fakeDelegate);
    expect(client.driver).toBe('filecoin_pin');
    expect(client.provider).toBe('filecoin');
  });
});

describe('FilecoinPinFilecoinProviderClient.put — invalid piece_id is omitted from the sidecar', () => {
  // Phase 5 blocker fix: filecoin-pin's `executeUpload` can return
  // `pieceId: 0n` for copies stored at the SP but not yet confirmed
  // at the data-set. Persisting `'0'` would trip the existing hint
  // reader's positive-decimal-bigint validator on every delete and
  // emit a spurious `filecoin.hint.malformed` diagnostic. The
  // driver maps non-positive pieceIds to "omit the field" so the
  // sidecar carries valid hints OR no hint at all — never garbage.
  it('omits `piece_id` from copy entries whose pieceId is 0n (pre-confirmation)', async () => {
    mockExecuteUpload.mockReset();
    mockExecuteUpload.mockResolvedValueOnce(
      uploadResultFixture({
        copies: [
          { providerId: 4n, dataSetId: 42n, pieceId: 0n, role: 'primary' },
          { providerId: 9n, dataSetId: 42n, pieceId: 7n, role: 'secondary' },
        ],
      }),
    );
    const client = new FilecoinPinFilecoinProviderClient(fakeSynapse, fakeDelegate);
    const result = await client.put({ key: 'k', body: HELLO });
    // Pre-confirmation copy: no `pieceId` at the boundary, no
    // `piece_id` in the persisted shape we hand to the adapter.
    expect(result.copies[0]).toEqual({ providerId: '4', dataSetId: '42', role: 'primary' });
    expect('pieceId' in result.copies[0]!).toBe(false);
    // Confirmed copy: `pieceId` carried through.
    expect(result.copies[1]).toEqual({
      providerId: '9', dataSetId: '42', pieceId: '7', role: 'secondary',
    });
  });

  it('rejects negative piece IDs at the boundary too (defensive against vendor regressions)', async () => {
    mockExecuteUpload.mockReset();
    mockExecuteUpload.mockResolvedValueOnce(
      uploadResultFixture({
        copies: [{ providerId: 4n, dataSetId: 42n, pieceId: -1n, role: 'primary' }],
      }),
    );
    const client = new FilecoinPinFilecoinProviderClient(fakeSynapse, fakeDelegate);
    const result = await client.put({ key: 'k', body: HELLO });
    expect('pieceId' in result.copies[0]!).toBe(false);
  });
});
