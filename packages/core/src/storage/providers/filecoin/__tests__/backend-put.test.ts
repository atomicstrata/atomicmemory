/**
 * @file Unit tests for `FilecoinRawContentStore.put`.
 *
 * Exercises the adapter translation from `PutRawContentInput` /
 * `StoredRawContent` (the generic `RawContentStore` contract) onto
 * the `FilecoinProviderClient.put` boundary. The Synapse client
 * itself is faked through a hand-rolled `FakeClient` so the adapter
 * test stays deterministic and vendor-free.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FilecoinRawContentStore } from '../backend.js';
import { FilecoinProviderError } from '../errors.js';
import type {
  FilecoinProviderClient,
  FilecoinPutInput,
  FilecoinPutResult,
} from '../provider-client.js';
import {
  REAL_PIECE_CID_A,
  REAL_PIECE_CID_A_BASE58BTC,
  REAL_PIECE_CID_B,
} from '../../../__tests__/filecoin-cid-fixtures.js';
import { PIECE_CID, PIECE_URI } from './synapse-client-rw-fixtures.js';

class FakeClient implements FilecoinProviderClient {
  readonly provider = 'filecoin' as const;
  readonly driver = 'synapse' as const;
  lastPut: FilecoinPutInput | null = null;
  constructor(private readonly putResult: FilecoinPutResult) {}
  async put(input: FilecoinPutInput): Promise<FilecoinPutResult> {
    this.lastPut = input;
    return this.putResult;
  }
  async get(): Promise<never> {
    throw new Error('not used');
  }
  async head(): Promise<never> {
    throw new Error('not used');
  }
  async delete(): Promise<never> {
    throw new Error('not used');
  }
  async verify(): Promise<never> {
    throw new Error('not used');
  }
  async checkReadiness(): Promise<readonly never[]> {
    return [];
  }
  async getServiceMinUploadBytes(): Promise<number> {
    throw new Error('not used');
  }
}

function baseResult(overrides: Partial<FilecoinPutResult> = {}): FilecoinPutResult {
  return {
    pieceCid: PIECE_CID,
    storageUri: PIECE_URI,
    sizeBytes: 11,
    copies: [
      { providerId: '1', dataSetId: '42', pieceId: '7', role: 'primary' },
      { providerId: '2', dataSetId: '42', pieceId: '7', role: 'secondary' },
    ],
    failedAttempts: [],
    complete: true,
    requestedCopies: 2,
    ...overrides,
  };
}

const HELLO = Buffer.from('hello world');
const HELLO_SHA256 = createHash('sha256').update(HELLO).digest('hex');

describe('FilecoinRawContentStore.put — happy path', () => {
  it('returns a generic StoredRawContent with the canonical Filecoin URI', async () => {
    const fake = new FakeClient(baseResult());
    const store = new FilecoinRawContentStore(fake);
    const out = await store.put({ key: 'k', body: HELLO, contentType: 'text/plain' });
    expect(out.storageUri).toBe(PIECE_URI);
    expect(out.storageProvider).toBe('filecoin');
    expect(out.sizeBytes).toBe(HELLO.length);
  });

  it("ALWAYS returns status='pending' on Filecoin (eventual provider) even when Synapse complete=true", async () => {
    const fake = new FakeClient(baseResult({ complete: true }));
    const store = new FilecoinRawContentStore(fake);
    const out = await store.put({ key: 'k', body: HELLO });
    expect(out.status).toBe('pending');
    // The raw UploadResult.complete flag IS preserved in the
    // internal sidecar so the reconciler can distinguish
    // "all-copies-accepted" from a partial upload.
    expect((out.providerMetadata['filecoin'] as { complete: boolean }).complete).toBe(true);
  });

  it('writes the SHA-256 of the PLAINTEXT bytes (not Synapse size) on content_hash', async () => {
    const fake = new FakeClient(baseResult({ sizeBytes: 1024 }));
    const store = new FilecoinRawContentStore(fake);
    const out = await store.put({ key: 'k', body: HELLO });
    expect(out.contentHash).toBe(HELLO_SHA256);
    expect(out.sizeBytes).toBe(HELLO.length); // plaintext byte count, NOT Synapse padded size
  });

  it('forwards key + contentType through to the provider client', async () => {
    const fake = new FakeClient(baseResult());
    const store = new FilecoinRawContentStore(fake);
    await store.put({ key: 's/abc/doc/01.bin', body: HELLO, contentType: 'application/pdf' });
    expect(fake.lastPut?.key).toBe('s/abc/doc/01.bin');
    expect(fake.lastPut?.contentType).toBe('application/pdf');
  });
});

describe('FilecoinRawContentStore.put — provider metadata projection', () => {
  it('builds the internal filecoin sidecar with pieceCid/data_set_id/copies/...', async () => {
    const fake = new FakeClient(baseResult());
    const store = new FilecoinRawContentStore(fake);
    const out = await store.put({ key: 'k', body: HELLO });
    const sidecar = out.providerMetadata['filecoin'] as Record<string, unknown>;
    expect(sidecar['driver']).toBe('synapse');
    expect(sidecar['piece_cid']).toBe(PIECE_CID);
    expect(sidecar['data_set_id']).toBe('42');
    expect(sidecar['requested_copies']).toBe(2);
    expect(sidecar['complete']).toBe(true);
    expect(sidecar['copies']).toEqual([
      { provider_id: '1', data_set_id: '42', piece_id: '7', role: 'primary', status: 'accepted' },
      { provider_id: '2', data_set_id: '42', piece_id: '7', role: 'secondary', status: 'accepted' },
    ]);
  });

  it('omits ipfs_cid from the sidecar when the driver leaves the slot unset (live Synapse contract today)', async () => {
    // The live Synapse driver does not emit `result.ipfsCid`. The
    // sidecar key set MUST stay stable across the live driver and
    // any future filecoin-pin driver — omit the key entirely
    // rather than writing `null`, so closed-key assertions over
    // the sidecar shape stay deterministic.
    const fake = new FakeClient(baseResult());
    const store = new FilecoinRawContentStore(fake);
    const out = await store.put({ key: 'k', body: HELLO });
    const sidecar = out.providerMetadata['filecoin'] as Record<string, unknown>;
    expect('ipfs_cid' in sidecar).toBe(false);
  });

  it("status='pending' on a partial upload too; sidecar carries complete=false + failed_attempts", async () => {
    const fake = new FakeClient(
      baseResult({
        complete: false,
        copies: [
          { providerId: '1', dataSetId: '42', pieceId: '7', role: 'primary' },
        ],
        failedAttempts: [
          { providerId: '2', role: 'secondary', errorCode: 'filecoin_copy_failed', explicit: false },
        ],
      }),
    );
    const store = new FilecoinRawContentStore(fake);
    const out = await store.put({ key: 'k', body: HELLO });
    expect(out.status).toBe('pending');
    const sidecar = out.providerMetadata['filecoin'] as Record<string, unknown>;
    expect(sidecar['complete']).toBe(false);
    expect(sidecar['failed_attempts']).toBe(1);
    // Per-copy status is 'accepted' on upload; the reconciler /
    // head path advances it to 'available' after proof + retrieval.
    expect((sidecar['copies'] as Array<{ status: string }>)[0]!.status).toBe('accepted');
  });
});

/**
 * Phase 3 — identifier validation. Defense-in-depth at the
 * adapter layer: a misbehaving (or future) provider client must
 * not be able to plant a malformed PieceCID in the sidecar or an
 * inconsistent URI in `storage_artifacts.uri`. Both checks throw
 * typed `FilecoinProviderError`s — never a raw Error and never a
 * vendor response.
 */
describe('FilecoinRawContentStore.put — Phase 3 identifier validation', () => {
  async function expectErrorCode(
    behavior: () => Promise<unknown>,
    code: 'invalid_piece_cid' | 'identifier_mismatch' | 'invalid_uri',
  ): Promise<void> {
    let caught: unknown;
    try {
      await behavior();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FilecoinProviderError);
    expect((caught as FilecoinProviderError).errorCode).toBe(code);
  }

  it.each([
    ['malformed pieceCid (sentinel placeholder)', 'baga-test'],
    ['too short', 'baga6ea4seaq'],
    ['wrong prefix (looks like an IPFS CID)', 'bafy' + 'a'.repeat(56)],
    ['uppercase outside multibase b charset', 'BAGA6EA4SEAQ' + 'a'.repeat(48)],
    // Shape-only synthetics that pass a naive multibase-prefix
    // regex but FAIL the SDK's `asPieceCID` parser. These pin
    // the reviewer-flagged bug from PR #36: a regex-only gate
    // would falsely accept these and let them reach
    // `storage_artifacts` / `raw_storage_metadata` only to fail
    // downstream at head/get/delete.
    ['legacy-prefix shape-only synthetic', 'baga6ea4seaq' + 'a'.repeat(48)],
    ['modern-prefix shape-only synthetic', 'bafkzci' + 'a'.repeat(56)],
  ])(
    'put: refuses to persist when provider returns %s (errorCode=invalid_piece_cid)',
    async (_label, badCid) => {
      const fake = new FakeClient(
        baseResult({ pieceCid: badCid, storageUri: `filecoin://piece/${badCid}` }),
      );
      const store = new FilecoinRawContentStore(fake);
      await expectErrorCode(
        () => store.put({ key: 'k', body: HELLO }),
        'invalid_piece_cid',
      );
    },
  );

  it('put: refuses to persist when storageUri carries an INCONSISTENT pieceCid (identifier_mismatch)', async () => {
    // Both values are individually real, parser-valid PieceCIDs,
    // but they're DIFFERENT — a real driver bug shape we have to
    // catch before the adapter writes the sidecar.
    const otherCid = REAL_PIECE_CID_B;
    const fake = new FakeClient(
      baseResult({ pieceCid: PIECE_CID, storageUri: `filecoin://piece/${otherCid}` }),
    );
    const store = new FilecoinRawContentStore(fake);
    await expectErrorCode(
      () => store.put({ key: 'k', body: HELLO }),
      'identifier_mismatch',
    );
  });

  it('put: refuses to persist when storageUri has the wrong scheme (errorCode=invalid_uri)', async () => {
    // `parsePieceUri` distinguishes URI-shape errors
    // (`invalid_uri`) from CID-shape errors
    // (`invalid_piece_cid`) — the wrong scheme triggers the
    // former before we even reach the CID check.
    const fake = new FakeClient(
      baseResult({ pieceCid: PIECE_CID, storageUri: `ipfs://${PIECE_CID}` }),
    );
    const store = new FilecoinRawContentStore(fake);
    await expectErrorCode(
      () => store.put({ key: 'k', body: HELLO }),
      'invalid_uri',
    );
  });

  it('put: sanitized error messages do NOT echo the rejected identifier', async () => {
    const adversarial = 'baga' + 'XSS<script>' + 'a'.repeat(40);
    const fake = new FakeClient(
      baseResult({ pieceCid: adversarial, storageUri: `filecoin://piece/${adversarial}` }),
    );
    const store = new FilecoinRawContentStore(fake);
    let caught: Error | undefined;
    try {
      await store.put({ key: 'k', body: HELLO });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).not.toContain('XSS');
    expect(caught!.message).not.toContain('<script>');
  });
});

/**
 * Phase 3 — identifier CANONICALIZATION. `asPieceCID` accepts
 * any parser-valid multibase encoding of the same PieceCID
 * (e.g. base58btc `z…`) and normalizes it to the canonical
 * base32-lower `bafk…` form. The adapter must persist the
 * canonical form — never the wire-shape the provider returned —
 * so a future driver returning a non-canonical multibase variant
 * cannot leave a non-canonical URI or sidecar value behind.
 */
describe('FilecoinRawContentStore.put — Phase 3 identifier canonicalization', () => {
  it('canonicalizes a non-canonical (base58btc) PieceCID before persistence', async () => {
    const nonCanonical = REAL_PIECE_CID_A_BASE58BTC;
    const canonical = REAL_PIECE_CID_A;
    const fake = new FakeClient(
      baseResult({
        pieceCid: nonCanonical,
        storageUri: `filecoin://piece/${nonCanonical}`,
      }),
    );
    const store = new FilecoinRawContentStore(fake);
    const out = await store.put({ key: 'k', body: HELLO });
    expect(out.storageUri).toBe(`filecoin://piece/${canonical}`);
    expect(out.storageUri).not.toContain(nonCanonical);
    const sidecar = out.providerMetadata['filecoin'] as Record<string, unknown>;
    expect(sidecar['piece_cid']).toBe(canonical);
    expect(JSON.stringify(out.providerMetadata)).not.toContain(nonCanonical);
  });
});

/**
 * Phase 4 — optional `ipfsCid` slot on `FilecoinPutResult`. The
 * live Synapse driver leaves it `undefined`; a future filecoin-
 * pin driver will populate it. The adapter validates via
 * `multiformats/cid` (real codec-aware parse, rejects CIDv0 and
 * non-CIDs) and persists the canonical CIDv1 string under
 * `raw_storage_metadata.filecoin.ipfs_cid`. The canonical storage
 * URI stays PieceCID-based — `ipfsCid` does NOT change row
 * identity.
 */
describe('FilecoinRawContentStore.put — Phase 4 optional ipfs_cid', () => {
  const VALID_IPFS_CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';

  it('persists a valid ipfsCid under sidecar ipfs_cid; storage URI stays PieceCID-based', async () => {
    const fake = new FakeClient(baseResult({ ipfsCid: VALID_IPFS_CID }));
    const store = new FilecoinRawContentStore(fake);
    const out = await store.put({ key: 'k', body: HELLO });
    expect(out.storageUri).toBe(`filecoin://piece/${PIECE_CID}`);
    expect(out.storageUri).not.toContain(VALID_IPFS_CID);
    const sidecar = out.providerMetadata['filecoin'] as Record<string, unknown>;
    expect(sidecar['ipfs_cid']).toBe(VALID_IPFS_CID);
  });

  it('canonicalizes a non-canonical (base58btc) ipfsCid into the canonical CIDv1 string', async () => {
    const { CID } = await import('multiformats/cid');
    const { base58btc } = await import('multiformats/bases/base58');
    const nonCanonical = CID.parse(VALID_IPFS_CID).toString(base58btc);
    const fake = new FakeClient(baseResult({ ipfsCid: nonCanonical }));
    const store = new FilecoinRawContentStore(fake);
    const out = await store.put({ key: 'k', body: HELLO });
    const sidecar = out.providerMetadata['filecoin'] as Record<string, unknown>;
    expect(sidecar['ipfs_cid']).toBe(VALID_IPFS_CID);
    expect(JSON.stringify(out.providerMetadata)).not.toContain(nonCanonical);
  });

  it.each([
    ['plain garbage', 'not-a-cid'],
    ['too short', 'bafy'],
    // CIDv0 (`Qm…`) — forward-looking field; legacy 1.0 not accepted.
    ['CIDv0 (legacy base58btc)', 'QmYjtig7VJQ6XsnUjqqJvj7QaMcCAwtrgNdahSiFofrE7o'],
  ])('rejects a malformed ipfsCid (%s) with errorCode invalid_ipfs_cid', async (_label, bad) => {
    const fake = new FakeClient(baseResult({ ipfsCid: bad }));
    const store = new FilecoinRawContentStore(fake);
    let caught: unknown;
    try {
      await store.put({ key: 'k', body: HELLO });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FilecoinProviderError);
    expect((caught as FilecoinProviderError).errorCode).toBe('invalid_ipfs_cid');
  });

  it('sanitization: malformed ipfsCid error does NOT echo the rejected value', async () => {
    const adversarial = 'XSS<script>alert(1)</script>';
    const fake = new FakeClient(baseResult({ ipfsCid: adversarial }));
    const store = new FilecoinRawContentStore(fake);
    let caught: Error | undefined;
    try {
      await store.put({ key: 'k', body: HELLO });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).not.toContain('XSS');
    expect(caught!.message).not.toContain('<script>');
  });
});
