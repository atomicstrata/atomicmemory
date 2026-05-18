/**
 * @file Tests for the canonical Filecoin storage URI helpers.
 *
 * Phase 3 hardening: both `formatPieceUri` and `parsePieceUri`
 * now validate the trailing PieceCID via the live Synapse SDK
 * parser (`asPieceCID` wrapped in `../piece-cid.ts`). Sentinel
 * inputs and shape-only synthetics from earlier iterations no
 * longer pass; the positive cases here use real PieceCIDs from
 * the shared fixture so the suite exercises the actual SDK
 * parser instead of a regex stand-in.
 */

import { describe, expect, it } from 'vitest';
import { formatPieceUri, parsePieceUri } from '../uri.js';
import { FilecoinProviderError } from '../errors.js';
import {
  REAL_PIECE_CID_A,
  REAL_PIECE_CID_A_BASE58BTC,
  REAL_PIECE_CID_B,
} from '../../../__tests__/filecoin-cid-fixtures.js';

const VALID_PIECE_CID = REAL_PIECE_CID_A;
const VALID_PIECE_CID_2 = REAL_PIECE_CID_B;

describe('formatPieceUri', () => {
  it('builds the canonical scheme + host + pieceCid path', () => {
    expect(formatPieceUri(VALID_PIECE_CID)).toBe(`filecoin://piece/${VALID_PIECE_CID}`);
  });

  it('trims surrounding whitespace before formatting', () => {
    expect(formatPieceUri(`  ${VALID_PIECE_CID}  `)).toBe(`filecoin://piece/${VALID_PIECE_CID}`);
  });

  it.each(['', '   ', '\t', '\n'])('rejects empty/whitespace PieceCID (%j)', (bad) => {
    expect(() => formatPieceUri(bad)).toThrow(FilecoinProviderError);
  });

  it.each(['baga/extra', 'baga?query', 'baga#frag', 'baga with space'])(
    'rejects unsafe characters in PieceCID (%j) before the SDK parse',
    (bad) => {
      expect(() => formatPieceUri(bad)).toThrow(/URI-safe/);
    },
  );

  it.each([
    'baga-test-cid',
    'baga6ea4seaq',
    'baga',
    'BAGA6EA4SEAQ' + 'a'.repeat(48), // uppercase rejected (multibase is lowercase)
    'bafy' + 'a'.repeat(56), // valid CIDv1 shape but NOT a PieceCID
    // Shape-only synthetics that would slip past a regex but FAIL
    // the SDK parser. These pin the bug the reviewer flagged in PR
    // #36: a regex-only gate would falsely accept these.
    'baga6ea4seaq' + 'a'.repeat(48),
    'bafkzci' + 'a'.repeat(56),
  ])('rejects malformed PieceCID (%j) with errorCode invalid_piece_cid', (bad) => {
    expect.assertions(2);
    try {
      formatPieceUri(bad);
    } catch (err) {
      expect(err).toBeInstanceOf(FilecoinProviderError);
      expect((err as FilecoinProviderError).errorCode).toBe('invalid_piece_cid');
    }
  });

  it('canonicalizes a non-canonical (base58btc) PieceCID into the canonical bafk… URI', () => {
    // `asPieceCID` accepts any parser-valid multibase encoding of
    // the same PieceCID and normalizes it. `formatPieceUri` must
    // emit the canonical form so a non-canonical input cannot
    // surface in `storage_artifacts.uri`.
    expect(formatPieceUri(REAL_PIECE_CID_A_BASE58BTC)).toBe(
      `filecoin://piece/${REAL_PIECE_CID_A}`,
    );
  });

  it('error message for malformed PieceCID does NOT echo the rejected value (sanitization)', () => {
    const adversarial = 'baga' + '${"injected": true}' + 'rest';
    try {
      formatPieceUri(adversarial);
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).not.toContain('injected');
      expect(msg).not.toContain('${');
    }
  });
});

describe('parsePieceUri', () => {
  it('returns the PieceCID for a canonical URI', () => {
    expect(parsePieceUri(`filecoin://piece/${VALID_PIECE_CID}`)).toBe(VALID_PIECE_CID);
  });

  it.each([
    ['', 'invalid_uri'],
    ['ipfs://baga-x', 'invalid_uri'],
    ['https://example.com/baga', 'invalid_uri'],
    ['filecoin://piece/', 'invalid_uri'],
    [`filecoin://piece/${VALID_PIECE_CID}/extra`, 'invalid_uri'],
    [`filecoin://piece/${VALID_PIECE_CID}?q=1`, 'invalid_uri'],
    [`filecoin://piece/${VALID_PIECE_CID}#frag`, 'invalid_uri'],
    [`filecoin://something-else/${VALID_PIECE_CID}`, 'invalid_uri'],
  ])('rejects malformed URI shape %j with errorCode %s', (bad, code) => {
    expect.assertions(2);
    try {
      parsePieceUri(bad);
    } catch (err) {
      expect(err).toBeInstanceOf(FilecoinProviderError);
      expect((err as FilecoinProviderError).errorCode).toBe(code);
    }
  });

  it.each([
    'filecoin://piece/baga-test-cid',
    'filecoin://piece/baga',
    'filecoin://piece/' + 'bafy' + 'a'.repeat(56),
    // Shape-only synthetics — the SDK parser must reject them
    // even though they would pass a naive multibase-prefix regex.
    'filecoin://piece/baga6ea4seaq' + 'a'.repeat(48),
    'filecoin://piece/bafkzci' + 'a'.repeat(56),
  ])('rejects valid-URI-shape-but-malformed PieceCID %j with errorCode invalid_piece_cid', (bad) => {
    expect.assertions(2);
    try {
      parsePieceUri(bad);
    } catch (err) {
      expect(err).toBeInstanceOf(FilecoinProviderError);
      expect((err as FilecoinProviderError).errorCode).toBe('invalid_piece_cid');
    }
  });

  it('round-trips through format/parse', () => {
    expect(parsePieceUri(formatPieceUri(VALID_PIECE_CID_2))).toBe(VALID_PIECE_CID_2);
  });

  it('canonicalizes a non-canonical (base58btc) PieceCID in the URI body', () => {
    // The URI may carry any parser-valid multibase encoding of
    // the same PieceCID; the parser must collapse to canonical.
    const uri = `filecoin://piece/${REAL_PIECE_CID_A_BASE58BTC}`;
    expect(parsePieceUri(uri)).toBe(REAL_PIECE_CID_A);
  });
});
