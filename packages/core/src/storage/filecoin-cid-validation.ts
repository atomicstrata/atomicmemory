/**
 * @file Shared Filecoin / IPFS CID structural-SHAPE gates for the
 * public-projection seam.
 *
 * These are NOT codec-aware validators. They are
 * regex-on-multibase-prefix gates whose only job is to silently
 * drop adversarial / legacy / manually-planted JSONB column
 * values before they cross the public projection wire boundary.
 * True PieceCIDv2 validation — CIDv1, raw codec (0x55),
 * multihash code 0x1011 — lives at the provider boundary in
 * `providers/filecoin/piece-cid.ts`, which wraps the live Synapse
 * SDK parser (`@filoz/synapse-core/piece.asPieceCID`). Write-path
 * inputs that fail the SDK parser are rejected before they ever
 * reach `storage_artifacts.uri` or
 * `raw_storage_metadata.filecoin.piece_cid`, so by induction any
 * value the public projector sees in a recent row already
 * round-trips through the SDK.
 *
 * Why a separate shape gate exists:
 *
 *   - The public projector (`filecoin-public-metadata.ts`) is on
 *     the EAGER import path. Importing `@filoz/synapse-core` from
 *     it would defeat the Phase 2 lazy-loading invariant that
 *     keeps the Synapse SDK out of non-Filecoin-provider
 *     startups.
 *
 *   - Legacy rows from before Phase 3, direct DB writes by
 *     operators, and adversarial test planting can still place
 *     non-parseable strings in `raw_storage_metadata`. The shape
 *     gate is a belt-and-suspenders silent drop so such values
 *     never make it onto the wire.
 *
 * Predicates:
 *
 *   - `isPieceCidShape(value)` — accepts strings whose multibase
 *     prefix is a known PieceCID encoding (legacy `baga…` or
 *     modern PieceCIDv2 `bafkzci…`) followed by enough base32-lower
 *     characters to plausibly carry a digest. Does NOT decode
 *     the bytes or verify the codec/multihash.
 *
 *   - `isIpfsCidShape(value)` — broader CIDv1 base32-lower shape;
 *     reserved for the Phase 4 `ipfs_cid` / CAR-root field. No
 *     production caller emits the field yet.
 *
 * The functions are named `isPieceCid` / `isIpfsCid` (historical
 * names retained to avoid churn at call sites) but the file
 * header is the source of truth on what they actually do —
 * "structural shape only, no codec validation."
 *
 * Layering rule: this module sits at the shared-storage layer
 * and has ZERO dependencies on `providers/filecoin/*` or any
 * Filecoin vendor package. The boundary test
 * (`import-boundary-helpers.ts:SHARED_STORAGE_ALLOWLIST`)
 * explicitly permits provider files to import it via
 * `../../filecoin-cid-validation.js` — that allowance now exists
 * only for the public projector's `import { isPieceCid }` (the
 * provider boundary uses the SDK parser instead).
 *
 * Errors: this file does NOT throw — predicates return booleans.
 */

/**
 * PieceCID structural shape: CIDv1 base32-lower. Two canonical
 * multicodec encodings are accepted:
 *
 *   - **Legacy `baga…`** — multicodec `fil-commitment-unsealed`
 *     (0xf101) + sha2-256. Historical Filecoin storage identity;
 *     ~59–62 chars overall.
 *
 *   - **Modern `bafkzci…`** — CIDv1 raw codec (0x55) + multihash
 *     code 0x1011 (`fr32-sha2-256-trunc254-padded-binary-tree`,
 *     from `@web3-storage/data-segment`). This is the PieceCIDv2
 *     shape the live Synapse SDK emits today
 *     (`@filoz/synapse-core` `isPieceCID`). ~63–66 chars overall.
 *
 * The regex requires the `(baga|bafkzci)` prefix and at least 50
 * additional base32-lower characters, rejecting obvious sentinels
 * (`baga-test`, `bafkzci-x`) while leaving room for digest-length
 * variants within either codec family. Codec semantics (CID
 * version, codec byte, multihash code) are NOT decoded here — the
 * SDK enforces them on its side. This validator's job is to gate
 * adversarial JSONB / placeholders / wire-format garbage before
 * the value reaches the URI parser, the sidecar persister, or the
 * public projector.
 *
 * Charset is base32 lowercase per multibase `b`: `[a-z2-7]`.
 */
const PIECE_CID_RE = /^(baga|bafkzci)[a-z2-7]{50,}$/;

/**
 * Generic CIDv1 base32-lower shape. Multibase prefix `b` followed
 * by 55+ base32-lower characters (typical CIDv1 base32 length is
 * 59 chars; floor at 55 to accommodate variant multihashes).
 * Accepts both IPFS-style `bafy...` / `bafk...` and PieceCID-style
 * `baga...`. Phase 4 / filecoin-pin uses this for the `ipfs_cid`
 * / CAR-root metadata field.
 */
const IPFS_CID_RE = /^b[a-z2-7]{55,}$/;

/**
 * Returns `true` if `value` has the surface shape of a PieceCID
 * string (legacy `baga…` or modern PieceCIDv2 `bafkzci…`
 * multibase prefix + sufficient base32-lower length). Does NOT
 * decode the multihash bytes, verify the codec, or confirm the
 * value parses through the Synapse SDK — see this file's
 * header for why the codec-aware check lives at the provider
 * boundary instead.
 *
 * Used at the public-projection seam (`filecoin-public-metadata`)
 * to silently drop adversarial / legacy / manually-planted
 * column values before the wire.
 */
export function isPieceCid(value: unknown): value is string {
  return typeof value === 'string' && PIECE_CID_RE.test(value);
}

/**
 * Returns `true` if `value` has the surface shape of a CIDv1
 * base32-lower string (any multicodec). Reserved for the
 * `ipfs_cid` / CAR-root identity Phase 4 will plumb through; no
 * production caller emits the field yet. Same shape-only
 * semantics as {@link isPieceCid}.
 */
export function isIpfsCid(value: unknown): value is string {
  return typeof value === 'string' && IPFS_CID_RE.test(value);
}
