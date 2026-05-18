/**
 * @file Unit tests for the provider-boundary IPFS / CAR-root CID
 * parser (`requireIpfsCid` in `../ipfs-cid.ts`).
 *
 * The parser wraps `multiformats/cid`'s `CID.parse` and returns
 * the canonical CIDv1 string form. CIDv0 is rejected (forward-
 * looking field, no legacy 1.0 support needed). Non-canonical
 * multibase encodings parse but the canonical form is returned
 * so the persisted sidecar value is deterministic.
 */

import { describe, expect, it } from 'vitest';
import { CID } from 'multiformats/cid';
import { base58btc } from 'multiformats/bases/base58';
import { requireIpfsCid } from '../ipfs-cid.js';
import { FilecoinProviderError } from '../errors.js';

const VALID_IPFS_DAG_PB = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
const VALID_IPFS_RAW = 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy';
const VALID_PIECE_CID_V2 = 'bafkzcibcd4bdomn3tgwgrh3g532zopskstnbrd2n3sxfqbze7rxt7vqn7veigmy';

/** Pre-derived: `CID.parse(VALID_IPFS_DAG_PB).toString(base58btc)`. */
const VALID_IPFS_DAG_PB_BASE58BTC = CID.parse(VALID_IPFS_DAG_PB).toString(base58btc);
/** CIDv0 (legacy base58btc, 46 chars). */
const LEGACY_CIDV0 = 'QmYjtig7VJQ6XsnUjqqJvj7QaMcCAwtrgNdahSiFofrE7o';

describe('requireIpfsCid', () => {
  it.each([
    ['IPFS dag-pb CIDv1', VALID_IPFS_DAG_PB],
    ['IPFS raw CIDv1', VALID_IPFS_RAW],
    ['PieceCIDv2 is also a valid CIDv1', VALID_PIECE_CID_V2],
  ])('accepts %s and returns the canonical string', (_label, cid) => {
    expect(requireIpfsCid(cid, 'test ctx')).toBe(cid);
  });

  it('canonicalizes a non-canonical (base58btc) CIDv1 encoding to the canonical bafy/bafk… form', () => {
    expect(requireIpfsCid(VALID_IPFS_DAG_PB_BASE58BTC, 'test ctx')).toBe(VALID_IPFS_DAG_PB);
  });

  it.each([
    ['empty string', ''],
    ['plain garbage', 'not-a-cid'],
    ['CIDv0 (legacy base58btc, rejected)', LEGACY_CIDV0],
    ['number', 42 as unknown],
    ['null', null],
    ['undefined', undefined],
    ['object', { cid: VALID_IPFS_DAG_PB }],
    ['array', [VALID_IPFS_DAG_PB]],
    ['Buffer', Buffer.from(VALID_IPFS_DAG_PB)],
  ])('rejects %s with errorCode invalid_ipfs_cid', (_label, input) => {
    expect.assertions(2);
    try {
      requireIpfsCid(input, 'test ctx');
    } catch (err) {
      expect(err).toBeInstanceOf(FilecoinProviderError);
      expect((err as FilecoinProviderError).errorCode).toBe('invalid_ipfs_cid');
    }
  });

  it('sanitization: the error message does NOT echo the rejected value', () => {
    const adversarial = 'XSS<script>injected</script>' + 'a'.repeat(20);
    try {
      requireIpfsCid(adversarial, 'test ctx');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).not.toContain('XSS');
      expect(msg).not.toContain('injected');
      expect(msg).not.toContain('<script>');
    }
  });
});
