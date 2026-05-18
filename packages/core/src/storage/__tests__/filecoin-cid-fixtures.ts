/**
 * @file Canonical real-PieceCID fixtures shared across the test
 * suite.
 *
 * Both values round-trip through `@filoz/synapse-core/piece`'s
 * `asPieceCID()` — i.e. they are real PieceCIDv2 strings (CIDv1,
 * raw codec 0x55, multihash code 0x1011 from
 * `@web3-storage/data-segment`). They are the public fixtures the
 * Synapse SDK ships in its JSONRPC mocks, copied here verbatim so
 * this file itself does not import the Filecoin SDK and stays
 * cheap to load on the eager-import path.
 *
 * Use these wherever a test exercises the provider boundary
 * (`FilecoinRawContentStore.put`, `parsePieceUri`,
 * `formatPieceUri`, anything that reaches the SDK parser).
 * Wire-shape / public-projection tests can use them too — a real
 * PieceCID is shape-valid by construction, and using the same
 * strings everywhere makes the suite self-consistent.
 *
 * For shape-only adversarial-JSONB fixtures (negative cases
 * targeting the regex gate in `../filecoin-cid-validation.ts`),
 * inline the synthetic string at the call site — do NOT add it
 * here, since this file is for round-trippable PieceCIDs only.
 */

/** Sourced from `@filoz/synapse-core/dist/src/mocks/jsonrpc/index.js`. */
export const REAL_PIECE_CID_A =
  'bafkzcibcd4bdomn3tgwgrh3g532zopskstnbrd2n3sxfqbze7rxt7vqn7veigmy';
export const REAL_PIECE_CID_B =
  'bafkzcibeqcad6efnpwn62p5vvs5x3nh3j7xkzfgb3xtitcdm2hulmty3xx4tl3wace';

/**
 * Non-canonical but parser-valid encoding of `REAL_PIECE_CID_A`
 * in base58btc (multibase prefix `z`). The Synapse SDK's
 * `asPieceCID` accepts any parser-valid multibase encoding of
 * the same CID and normalizes it to the canonical `bafk…` form;
 * this constant exists so tests can prove the provider boundary
 * canonicalizes inputs (URI + sidecar values) before persistence
 * rather than just accepting them. Computed once via
 * `CID.parse(REAL_PIECE_CID_A).toString(base58btc)` and inlined.
 */
export const REAL_PIECE_CID_A_BASE58BTC =
  'zsXb84QzbmDdwKDx3CL1RkRkyjAGjJ4d21r7WPF8jTeNbeXqnLuPY';
