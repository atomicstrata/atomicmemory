/**
 * @file Unit tests for the shared Filecoin / IPFS CID structural-
 * SHAPE gates.
 *
 * `isPieceCid` / `isIpfsCid` are codec-blind regex gates used at
 * the public-projection seam to silently drop adversarial /
 * legacy / manually-planted JSONB column values. Real codec-
 * aware PieceCIDv2 parsing lives at the provider boundary in
 * `providers/filecoin/piece-cid.ts` (Synapse SDK wrapper); these
 * tests deliberately do NOT depend on the SDK so the eager-import
 * path stays lean.
 *
 * The shape gates must:
 *   1. Accept real PieceCIDs (`REAL_PIECE_CID_*` from the shared
 *      fixture) — they're a strict subset of the shape grammar.
 *   2. Accept legacy `baga…` shape (covers the historical
 *      fil-commitment-unsealed form some pre-migration rows may
 *      carry).
 *   3. Reject obvious sentinels, wrong charset/casing, missing
 *      length, and non-string inputs.
 *
 * Predicates are exception-free — these tests pin that they
 * return booleans only and never throw on adversarial input.
 */

import { describe, expect, it } from 'vitest';
import { isIpfsCid, isPieceCid } from '../filecoin-cid-validation.js';
import { REAL_PIECE_CID_A, REAL_PIECE_CID_B } from './filecoin-cid-fixtures.js';

/** Legacy `baga…` shape-only synthetic — passes the codec-blind regex; FAILS the SDK parser. */
const VALID_PIECE_CID_LEGACY = 'baga6ea4seaq' + 'a'.repeat(48);
const VALID_PIECE_CID_DIGITS = 'baga6ea4seaq' + '234567'.repeat(8); // 48 chars of digit-only base32-lower
/**
 * Modern `bafkzci…` shape-only synthetic. Passes the codec-blind
 * regex but does NOT round-trip through the Synapse SDK parser
 * — see file header for why both shapes are intentionally
 * accepted at the public-projection seam.
 */
const VALID_PIECE_CID_V2 = 'bafkzci' + 'a'.repeat(56);
/** Realistic IPFS CIDv1: `bafy` (dag-pb) + 55 base32 chars. */
const VALID_IPFS_CID = 'bafy' + 'a'.repeat(55);
const VALID_RAW_CID = 'bafk' + 'a'.repeat(55);

describe('isPieceCid (shape gate)', () => {
  it.each([
    ['legacy baga prefix shape-only synthetic', VALID_PIECE_CID_LEGACY],
    ['legacy baga w/ digit-only tail', VALID_PIECE_CID_DIGITS],
    ['modern bafkzci prefix shape-only synthetic', VALID_PIECE_CID_V2],
    ['real parser-valid PieceCIDv2 (REAL_PIECE_CID_A)', REAL_PIECE_CID_A],
    ['real parser-valid PieceCIDv2 (REAL_PIECE_CID_B)', REAL_PIECE_CID_B],
  ])('accepts %s (shape is a superset of parser-valid PieceCIDs)', (_label, cid) => {
    expect(isPieceCid(cid)).toBe(true);
  });

  it.each([
    ['baga-test-cid', 'sentinel placeholder — too short + invalid charset'],
    ['baga6ea4seaq', 'prefix only — below length floor'],
    ['baga', 'just the legacy prefix'],
    ['bafkzci', 'just the modern prefix'],
    ['baga' + 'a'.repeat(49), 'one short of length floor (50)'],
    ['bafkzci' + 'a'.repeat(49), 'modern prefix, one short of length floor (50)'],
    ['BAGA6EA4SEAQ' + 'a'.repeat(48), 'uppercase rejected (multibase b is lowercase)'],
    ['BAFKZCI' + 'a'.repeat(56), 'modern prefix uppercase rejected'],
    [`baga6ea4seaq${'1'.repeat(48)}`, 'digit `1` outside base32-lower charset'],
    [`baga6ea4seaq${'0'.repeat(48)}`, 'digit `0` outside base32-lower charset'],
    [`baga6ea4seaq${'8'.repeat(48)}`, 'digit `8` outside base32-lower charset'],
    [`baga6ea4seaq${'9'.repeat(48)}`, 'digit `9` outside base32-lower charset'],
    [`bafy${'a'.repeat(56)}`, 'CIDv1 shape but NOT PieceCID prefix (dag-pb)'],
    [`bafk${'a'.repeat(56)}`, 'CIDv1 raw but missing fr32 multihash prefix'],
    [`baga6ea4seaq${'a'.repeat(48)}/extra`, 'extra path segment'],
    [`  ${VALID_PIECE_CID_LEGACY}  `, 'surrounding whitespace'],
    [VALID_PIECE_CID_LEGACY + '\n', 'trailing newline'],
  ])('rejects %j (%s)', (input) => {
    expect(isPieceCid(input)).toBe(false);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['number', 42],
    ['boolean', true],
    ['array', [VALID_PIECE_CID_LEGACY]],
    ['object', { cid: VALID_PIECE_CID_LEGACY }],
    ['Buffer-like', Buffer.from(VALID_PIECE_CID_LEGACY)],
  ])('rejects non-string %s without throwing', (_label, input) => {
    expect(isPieceCid(input)).toBe(false);
  });
});

describe('isIpfsCid', () => {
  it.each([
    ['IPFS dag-pb v1 (bafy...)', VALID_IPFS_CID],
    ['IPFS raw v1 (bafk...)', VALID_RAW_CID],
    ['legacy PieceCID is also a structurally-valid CIDv1', VALID_PIECE_CID_LEGACY],
    ['modern PieceCIDv2 is also a structurally-valid CIDv1', VALID_PIECE_CID_V2],
  ])('accepts %s', (_label, cid) => {
    expect(isIpfsCid(cid)).toBe(true);
  });

  it.each([
    ['empty string', ''],
    ['too short', 'bafy' + 'a'.repeat(50)],
    ['wrong multibase prefix', 'zfoo' + 'a'.repeat(55)],
    ['no prefix at all', 'a'.repeat(60)],
    ['CIDv0 base58 (Qm...)', 'Qm' + 'a'.repeat(44)],
    ['uppercase', 'BAFY' + 'A'.repeat(55)],
    ['mixed-case', 'Bafy' + 'a'.repeat(55)],
    ['contains slash', 'bafy' + 'a'.repeat(55) + '/path'],
    ['contains digit `1` (base32-lower excludes 0/1/8/9)', `bafy${'1'.repeat(56)}`],
  ])('rejects %s', (_label, input) => {
    expect(isIpfsCid(input)).toBe(false);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['number', 42],
    ['object', { cid: VALID_IPFS_CID }],
  ])('rejects non-string %s without throwing', (_label, input) => {
    expect(isIpfsCid(input)).toBe(false);
  });
});
