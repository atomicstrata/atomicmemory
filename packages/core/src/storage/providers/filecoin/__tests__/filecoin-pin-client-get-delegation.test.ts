/**
 * @file Tests for `FilecoinPinFilecoinProviderClient.get`,
 * `verify`, and the methods the driver delegates to its Synapse
 * client.
 *
 * The driver:
 *   - `get`: reads CAR bytes via the Synapse delegate, parses
 *     the CAR's declared SOLE root (a malformed/malicious CAR
 *     with multiple roots is rejected; a stale sidecar must
 *     not redirect retrieval), walks the UnixFS DAG to recover
 *     the original bytes, and augments `providerMetadata` with
 *     `ipfs_cid` (the CAR root in canonical string form);
 *   - `verify`: OVERRIDES the delegate. Synapse-side `verify`
 *     would hash CAR bytes; we hash the extracted plaintext
 *     via this client's own `get`. Tests below pin the
 *     verify-via-plaintext-hash contract.
 *   - `head`, `delete`, `checkReadiness`,
 *     `getServiceMinUploadBytes`: delegate to the Synapse client
 *     unchanged. Delete-semantics invariant (Phase 5): the new
 *     driver preserves the same `tombstone` semantics the direct
 *     driver returns. Asserted explicitly.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { CarWriter } from '@ipld/car';
import type { Synapse } from '@filoz/synapse-sdk';
import { FilecoinPinFilecoinProviderClient } from '../filecoin-pin-client.js';
import { FilecoinProviderError } from '../errors.js';
import { buildCarFromBytes } from '../filecoin-pin-car.js';
import type { SynapseFilecoinProviderClient } from '../synapse-client.js';
import type {
  FilecoinDeleteResult,
  FilecoinGetResult,
  FilecoinHeadResult,
  FilecoinReadinessCheck,
} from '../provider-client.js';
import { REAL_PIECE_CID_A } from '../../../__tests__/filecoin-cid-fixtures.js';

const PIECE_URI = `filecoin://piece/${REAL_PIECE_CID_A}`;
const fakeSynapse = {} as unknown as Synapse;

function delegateStub(overrides: Partial<SynapseFilecoinProviderClient> = {}): SynapseFilecoinProviderClient {
  return {
    provider: 'filecoin',
    driver: 'synapse',
    get: vi.fn(),
    head: vi.fn(),
    delete: vi.fn(),
    verify: vi.fn(),
    checkReadiness: vi.fn(),
    getServiceMinUploadBytes: vi.fn(),
    put: vi.fn(),
    ...overrides,
  } as unknown as SynapseFilecoinProviderClient;
}

describe('FilecoinPinFilecoinProviderClient.get — CAR unwrapping', () => {
  it('parses the CAR via the delegate, returns the original bytes + ipfs_cid', async () => {
    const original = Buffer.from('hello filecoin-pin get-side test');
    const built = await buildCarFromBytes(original);
    const delegate = delegateStub({
      get: vi.fn().mockResolvedValueOnce({
        body: built.carBytes,
        providerMetadata: { piece_cid: REAL_PIECE_CID_A },
      } satisfies FilecoinGetResult),
    });
    const client = new FilecoinPinFilecoinProviderClient(fakeSynapse, delegate);
    const out = await client.get({ storageUri: PIECE_URI });
    expect(Buffer.compare(original, out.body)).toBe(0);
    expect(out.providerMetadata).toEqual({
      piece_cid: REAL_PIECE_CID_A,
      ipfs_cid: built.rootCid.toString(),
    });
  });

  it('rejects non-CAR retrieval bytes with a sanitized filecoin_pin_car_* error', async () => {
    const delegate = delegateStub({
      get: vi.fn().mockResolvedValueOnce({
        body: Buffer.from('totally not a car file ' + 'x'.repeat(64)),
        providerMetadata: {},
      } satisfies FilecoinGetResult),
    });
    const client = new FilecoinPinFilecoinProviderClient(fakeSynapse, delegate);
    let caught: unknown;
    try {
      await client.get({ storageUri: PIECE_URI });
    } catch (err) {
      caught = err;
    }
    // Either the CAR parser fails outright OR the DAG walk fails
    // when the (bogus) root has no blocks — both surface as a
    // closed-set `filecoin_pin_car_*` sanitized error. The
    // important invariant is that no vendor stack escapes.
    expect(caught).toBeInstanceOf(FilecoinProviderError);
    const code = (caught as FilecoinProviderError).errorCode;
    expect(code.startsWith('filecoin_pin_car_')).toBe(true);
    expect((caught as Error).message).not.toContain('totally not a car file');
  });
});

describe('FilecoinPinFilecoinProviderClient — delegation to Synapse', () => {
  it('head: forwards input + result through the delegate verbatim', async () => {
    const headResult: FilecoinHeadResult = {
      exists: true, proven: true, providerMetadata: { piece_cid: REAL_PIECE_CID_A },
    };
    const head = vi.fn().mockResolvedValueOnce(headResult);
    const client = new FilecoinPinFilecoinProviderClient(
      fakeSynapse, delegateStub({ head }),
    );
    const out = await client.head({ storageUri: PIECE_URI });
    expect(out).toBe(headResult);
    expect(head).toHaveBeenCalledWith({ storageUri: PIECE_URI });
  });

  it('delete: preserves the Synapse delegate\'s tombstone semantics (Phase 5 invariant)', async () => {
    const deleteResult: FilecoinDeleteResult = {
      deleted: true, semantics: 'tombstone', txHash: '0xfeed',
    };
    const del = vi.fn().mockResolvedValueOnce(deleteResult);
    const client = new FilecoinPinFilecoinProviderClient(
      fakeSynapse, delegateStub({ delete: del }),
    );
    const out = await client.delete({ storageUri: PIECE_URI, pieceId: '7', dataSetId: '42' });
    expect(out.semantics).toBe('tombstone');
    expect(del).toHaveBeenCalledWith({
      storageUri: PIECE_URI, pieceId: '7', dataSetId: '42',
    });
  });

  it('checkReadiness, getServiceMinUploadBytes: delegate without modification', async () => {
    const readiness: ReadonlyArray<FilecoinReadinessCheck> = [
      { name: 'network_reachable', status: 'passed' },
    ];
    const checkReadiness = vi.fn().mockResolvedValueOnce(readiness);
    const getServiceMinUploadBytes = vi.fn().mockResolvedValueOnce(127);
    const client = new FilecoinPinFilecoinProviderClient(
      fakeSynapse, delegateStub({ checkReadiness, getServiceMinUploadBytes }),
    );
    expect(await client.checkReadiness('calibration')).toBe(readiness);
    expect(await client.getServiceMinUploadBytes()).toBe(127);
  });
});

describe('FilecoinPinFilecoinProviderClient.verify — hashes EXTRACTED plaintext (not raw CAR)', () => {
  // Phase 5 blocker fix: Synapse-side `verify` would hash the CAR
  // bytes the SDK returns for our PieceCID. Those are NOT what the
  // caller's `expectedContentHash` was computed over (the upload
  // path hashed plaintext). The filecoin-pin client overrides
  // `verify` to fetch via its own `get` (CAR-extract → plaintext)
  // before hashing.
  const plaintext = Buffer.from('verify-side plaintext payload for Phase 5 hash test');

  it('returns verified=true when the extracted plaintext matches expectedContentHash', async () => {
    const built = await buildCarFromBytes(plaintext);
    const realHash = createHash('sha256').update(plaintext).digest('hex');
    // The delegate.verify would hash the CAR bytes — it must not
    // be called by this code path. We assert that below.
    const delegateVerify = vi.fn();
    const client = new FilecoinPinFilecoinProviderClient(
      fakeSynapse,
      delegateStub({
        verify: delegateVerify,
        get: vi.fn().mockResolvedValueOnce({
          body: built.carBytes, providerMetadata: {},
        }),
      }),
    );
    const out = await client.verify({ storageUri: PIECE_URI, expectedContentHash: realHash });
    expect(out).toEqual({ verified: true });
    expect(delegateVerify).not.toHaveBeenCalled();
  });

  it('returns verified=false with reason=content_hash_mismatch on a real mismatch', async () => {
    const built = await buildCarFromBytes(plaintext);
    const client = new FilecoinPinFilecoinProviderClient(
      fakeSynapse,
      delegateStub({
        get: vi.fn().mockResolvedValueOnce({ body: built.carBytes, providerMetadata: {} }),
      }),
    );
    const out = await client.verify({
      storageUri: PIECE_URI,
      expectedContentHash: 'deadbeef'.repeat(8),
    });
    expect(out.verified).toBe(false);
    expect(out.reason).toBe('content_hash_mismatch');
  });

  it('returns verified=false with the get-side errorCode when CAR retrieval fails', async () => {
    const client = new FilecoinPinFilecoinProviderClient(
      fakeSynapse,
      delegateStub({
        get: vi.fn().mockResolvedValueOnce({
          body: Buffer.from('not a real car'),
          providerMetadata: {},
        }),
      }),
    );
    const out = await client.verify({
      storageUri: PIECE_URI,
      expectedContentHash: 'a'.repeat(64),
    });
    expect(out.verified).toBe(false);
    expect(out.reason ?? '').toMatch(/^filecoin_pin_car_/);
  });

  it('propagates input.timeoutMs through to the delegate `get` so verify retrieval stays bounded', async () => {
    // Phase 5 blocker fix: a verify call inherits its retrieval
    // bound from the same `timeoutMs` knob used for direct
    // Synapse verify. The CAR-side wrapper must forward the
    // option through, not drop it.
    const built = await buildCarFromBytes(plaintext);
    const realHash = createHash('sha256').update(plaintext).digest('hex');
    const getSpy = vi.fn().mockResolvedValueOnce({ body: built.carBytes, providerMetadata: {} });
    const client = new FilecoinPinFilecoinProviderClient(
      fakeSynapse, delegateStub({ get: getSpy }),
    );
    await client.verify({
      storageUri: PIECE_URI,
      expectedContentHash: realHash,
      timeoutMs: 4321,
    });
    expect(getSpy).toHaveBeenCalledWith({ storageUri: PIECE_URI, timeoutMs: 4321 });
  });
});

describe('FilecoinPinFilecoinProviderClient.get — CAR root cardinality', () => {
  it('rejects a CAR with multiple declared roots (must be exactly one)', async () => {
    // Build a hand-rolled multi-root CAR. `buildCarFromBytes`
    // never emits more than one root; encountering two roots in
    // a retrieved CAR means either a malformed upload, a wire
    // mismatch, or a malicious payload. We refuse to silently
    // pick a root in any of those cases.
    const a = await buildCarFromBytes(Buffer.from('root A'));
    const b = await buildCarFromBytes(Buffer.from('root B'));
    type CarCid = Parameters<CarWriter['put']>[0]['cid'];
    const { writer, out } = CarWriter.create([
      a.rootCid as unknown as CarCid,
      b.rootCid as unknown as CarCid,
    ]);
    const collected: Uint8Array[] = [];
    const collecting = (async () => {
      for await (const chunk of out) collected.push(chunk);
    })();
    await writer.close();
    await collecting;
    const malformed = Buffer.concat(collected);

    const client = new FilecoinPinFilecoinProviderClient(
      fakeSynapse,
      delegateStub({
        get: vi.fn().mockResolvedValueOnce({ body: malformed, providerMetadata: {} }),
      }),
    );
    let caught: unknown;
    try {
      await client.get({ storageUri: PIECE_URI });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FilecoinProviderError);
    expect((caught as FilecoinProviderError).errorCode).toBe('filecoin_pin_car_ambiguous_roots');
  });
});
