/**
 * @file `RawContentStore` adapter wrapping a `FilecoinProviderClient`.
 *
 * Two reach-paths to keep in mind:
 *
 *   - Direct managed uploads (`POST /v1/storage/artifacts?mode=managed`)
 *     are rejected upstream by the
 *     `DIRECT_MANAGED_UNSUPPORTED_PROVIDERS` carve-out in
 *     `services/storage-service.ts`, so the route returns a typed
 *     501 and no `storage_artifacts` row is ever created — this
 *     adapter is not invoked on that path.
 *   - Document-path uploads against `RAW_STORAGE_PROVIDER=filecoin`
 *     construct this adapter (via `storage/factory.ts`) and call
 *     `put`/`get`/`head`/`delete` here. The adapter delegates to
 *     the underlying `FilecoinProviderClient`.
 *
 * Status mapping — Filecoin is `retrievalConsistency: 'eventual'`,
 * so `put` ALWAYS reports `'pending'` regardless of
 * `UploadResult.complete`. The reconciler / `head` path is
 * responsible for promoting `blob_pending → blob_available` after
 * a real retrievability check.
 *
 * Capabilities advertised:
 *
 *   - `addressing: 'content'`            (PieceCID-addressed)
 *   - `retrievalConsistency: 'eventual'` (deal lifecycle is async)
 *   - `deleteSemantics: 'tombstone'`     (provider tombstone only)
 *   - `supportsHead: true`               (via context.pieceStatus)
 *   - `supportsGet: true`                (via storage.download)
 */

import { createHash } from 'node:crypto';
import type {
  FilecoinDriverName,
  FilecoinProviderClient,
  FilecoinPutResult,
} from './provider-client.js';
import type {
  PutRawContentInput,
  RawContentDeleteResult,
  RawContentGetResult,
  RawContentHeadResult,
  RawContentHints,
  RawContentProviderMetadata,
  RawContentStore,
  RawContentStoreCapabilities,
  StoredRawContent,
} from '../../raw-content-store.js';
import { FilecoinProviderError } from './errors.js';
import { readFilecoinDataSetIdHint, readFilecoinDeleteHints } from './hints.js';
import { requireIpfsCid } from './ipfs-cid.js';
import { requirePieceCid } from './piece-cid.js';
import { formatPieceUri, parsePieceUri } from './uri.js';

const FILECOIN_CAPABILITIES: RawContentStoreCapabilities = {
  addressing: 'content',
  retrievalConsistency: 'eventual',
  deleteSemantics: 'tombstone',
  supportsHead: true,
  supportsGet: true,
};

export class FilecoinRawContentStore implements RawContentStore {
  readonly provider = 'filecoin';
  readonly capabilities = FILECOIN_CAPABILITIES;

  constructor(private readonly client: FilecoinProviderClient) {}

  async put(input: PutRawContentInput): Promise<StoredRawContent> {
    const result = await this.client.put({
      key: input.key,
      body: input.body,
      ...(input.contentType ? { contentType: input.contentType } : {}),
    });
    // Thread the boundary's `driver` into the sidecar — never
    // hardcode `'synapse'` here. Production: the live Synapse
    // client → `'synapse'`. Tests / a future filecoin-pin client
    // → that driver's literal. Hardcoding would lie for the
    // second driver and undermine the driver-agnostic invariant.
    return toStoredRawContent(input, result, this.client.driver);
  }

  async get(storageUri: string): Promise<RawContentGetResult> {
    const result = await this.client.get({ storageUri });
    return {
      body: result.body,
      metadata: {
        contentLength: result.body.length,
        contentType: null,
        contentHash: null,
        providerMetadata: result.providerMetadata,
      },
    };
  }

  async head(storageUri: string, hints?: RawContentHints): Promise<RawContentHeadResult> {
    const dataSetId = readFilecoinDataSetIdHint(hints);
    const result = await this.client.head({
      storageUri,
      ...(dataSetId !== null ? { dataSetId } : {}),
    });
    // Filecoin lifecycle gate: a Synapse piece is RETRIEVABLE only
    // after PDP proof has landed. The reconciler treats any
    // `exists=true` head as "promote blob_pending → blob_available",
    // so we MUST NOT report exists=true on an unproven piece —
    // otherwise the row would promote before the bytes are actually
    // retrievable. An unproven-but-known piece is reported as
    // `exists=false` (without a permanent-failure marker) so the
    // reconciler keeps the row pending and retries on a later tick.
    if (!result.exists || !result.proven) {
      return { exists: false, metadata: null };
    }
    return {
      exists: true,
      metadata: {
        contentLength: 0,
        contentType: null,
        contentHash: null,
        providerMetadata: result.providerMetadata,
      },
    };
  }

  async delete(storageUri: string, hints?: RawContentHints): Promise<RawContentDeleteResult> {
    // Extract BOTH the data-set-id (for context resolution) and
    // the per-copy piece-id (for direct deletePiece-by-id) from
    // the sidecar. The cleanup loop plumbs `raw_storage_metadata`
    // through `ManagedBlobRef` so production cleanup carries the
    // same hints the reconciler uses on `head`. CID-based delete
    // remains the fallback when hints are missing or malformed —
    // useful for legacy rows that pre-date the sidecar — but
    // Synapse cannot resolve a freshly-uploaded piece by CID
    // before PDP proof lands, so `pieceId` is required for the
    // most common case (delete shortly after upload).
    const { dataSetId, pieceId } = readFilecoinDeleteHints(hints);
    const result = await this.client.delete({
      storageUri,
      ...(dataSetId !== null ? { dataSetId } : {}),
      ...(pieceId !== null ? { pieceId } : {}),
    });
    // Phase 7 — pass `result.txHash` through as the internal-only
    // billing/cost-impact metadata. `RawContentDeleteResult.txHash`
    // is documented as INTERNAL: it MUST NOT cross any public
    // route boundary, and `cleanupManagedBlobs`'s closed-key
    // success DTO never includes it. The legitimate downstream
    // consumer is the `filecoin.delete.tombstoned` observability
    // emitter (operator-side telemetry only).
    return {
      deleted: result.deleted,
      semantics: 'tombstoned',
      ...(result.txHash !== undefined ? { txHash: result.txHash } : {}),
    };
  }
}

/**
 * Translate a Filecoin upload result to the generic
 * `StoredRawContent` shape persisted by the upload service. The
 * `content_hash` is the SHA-256 of the PLAINTEXT bytes the caller
 * passed in (the codec/AES-GCM layer already wrapped them on the
 * way down). Synapse reports the on-wire byte count in
 * `result.sizeBytes`; we persist `input.body.length` so the row's
 * `size_bytes` matches the plaintext contract the rest of the
 * pipeline uses.
 *
 * Status mapping — Filecoin is `retrievalConsistency: 'eventual'`,
 * so `put` ALWAYS reports `'pending'` regardless of
 * `UploadResult.complete`. A Synapse-side `complete=true` means the
 * SDK saw the requested copies stored on SPs; it does NOT prove the
 * data set's proof has landed or that the bytes are retrievable
 * via `download()`. The reconciler / `head` path is responsible for
 * promoting `blob_pending → blob_available` after a real
 * retrievability check. The original `complete` flag and copy
 * states are preserved in the internal
 * `raw_storage_metadata.filecoin` sidecar so the reconciler can
 * make decisions without re-querying the provider.
 */
function toStoredRawContent(
  input: PutRawContentInput,
  result: FilecoinPutResult,
  driver: FilecoinDriverName,
): StoredRawContent {
  // Phase 3 defense-in-depth: validate AND canonicalize before
  // any identifier reaches `storage_artifacts.uri` or the
  // `raw_storage_metadata.filecoin.piece_cid` sidecar. Both
  // halves of `result` are parsed through the live Synapse SDK
  // (`@filoz/synapse-core/piece.asPieceCID`) via
  // `requirePieceCid`, which ALSO returns the SDK's canonical
  // base32-lower CIDv1 multibase string. `asPieceCID` accepts
  // any parser-valid multibase encoding of the same PieceCID
  // (e.g. base58btc `z…`); the canonicalization step here
  // collapses those to the canonical `bafk…` form before
  // persistence so a future driver returning a non-canonical
  // multibase variant cannot leave a non-canonical URI or
  // sidecar value behind. The cross-field mismatch check then
  // compares the canonical forms — catching the case where
  // both halves parse but refer to different identifiers.
  const canonicalPieceCid = requirePieceCid(result.pieceCid, 'upload result');
  const canonicalFromUri = parsePieceUri(result.storageUri);
  if (canonicalFromUri !== canonicalPieceCid) {
    throw new FilecoinProviderError(
      'identifier_mismatch',
      'Provider client returned a storage URI whose PieceCID disagrees with the result.pieceCid field.',
    );
  }
  // Phase 4: validate AND canonicalize the optional IPFS/CAR-root
  // CID using a real `multiformats/cid` parse. The slot is opt-in
  // (live Synapse leaves it `undefined`); when populated, the
  // sidecar carries the canonical CIDv1 string. The canonical
  // storage URI stays PieceCID-based — `ipfsCid` does not change
  // row identity.
  const canonicalIpfsCid =
    result.ipfsCid === undefined
      ? undefined
      : requireIpfsCid(result.ipfsCid, 'upload result ipfsCid');
  return {
    storageUri: formatPieceUri(canonicalPieceCid),
    storageProvider: 'filecoin',
    contentHash: sha256Hex(input.body),
    sizeBytes: input.body.length,
    status: 'pending',
    providerMetadata: toProviderMetadata(result, driver, canonicalPieceCid, canonicalIpfsCid),
  };
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Build the internal-only `raw_storage_metadata.filecoin` sidecar
 * the document-side pipeline writes. The PUBLIC projection runs
 * later through `src/storage/filecoin-public-metadata.ts`, which
 * flattens `copies[]` into `copy_count` / `provider_ids` /
 * `copy_statuses` and drops everything else.
 *
 * Per-copy `status` is `'accepted'` on upload: the Synapse SDK's
 * `UploadResult.copies[]` only proves the SP accepted the bytes
 * (PDP proof has not landed yet, retrieval is unconfirmed). The
 * reconciler / `head` path advances copies to `'available'` once
 * `StorageContext.pieceStatus` reports proof + retrieval.
 * `complete` carries the raw `UploadResult.complete` flag so the
 * reconciler can distinguish "all copies stored" from "partial".
 */
function toProviderMetadata(
  result: FilecoinPutResult,
  driver: FilecoinDriverName,
  canonicalPieceCid: string,
  canonicalIpfsCid: string | undefined,
): RawContentProviderMetadata {
  return {
    filecoin: {
      driver,
      // Persist the SDK's canonical multibase form (not
      // `result.pieceCid`) so a non-canonical-but-parser-valid
      // input from a misbehaving driver still lands on disk as
      // the canonical `bafk…` string.
      piece_cid: canonicalPieceCid,
      // Phase 4: optional IPFS / CAR-root identity. Snake_case
      // for the JSONB key; only present when the driver
      // populated `result.ipfsCid`. Omitted entirely (vs. set to
      // `null`) so closed-key assertions over the sidecar stay
      // stable for the live Synapse driver, which never writes
      // this slot today.
      ...(canonicalIpfsCid === undefined ? {} : { ipfs_cid: canonicalIpfsCid }),
      data_set_id: result.copies[0]?.dataSetId,
      copies: result.copies.map((copy) => ({
        provider_id: copy.providerId,
        data_set_id: copy.dataSetId,
        // Omit `piece_id` entirely when the driver reported a
        // sentinel/non-positive value. Writing `'0'` (or any
        // non-positive decimal) would later trip the hint
        // reader's positive-decimal-bigint validator and emit a
        // spurious `filecoin.hint.malformed` diagnostic on every
        // delete. Absent silently falls back to the CID-based
        // delete lookup, which is the intended behaviour when a
        // piece-id hint is unavailable.
        ...(copy.pieceId !== undefined ? { piece_id: copy.pieceId } : {}),
        role: copy.role,
        status: 'accepted',
      })),
      failed_attempts: result.failedAttempts.length,
      requested_copies: result.requestedCopies,
      complete: result.complete,
    },
  };
}
