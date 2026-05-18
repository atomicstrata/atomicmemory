/**
 * @file Filecoin provider-client interface — the seam between the
 * `RawContentStore` adapter and any vendor-specific Filecoin client.
 *
 * The interface admits two drivers today (`FilecoinDriverName =
 * 'synapse' | 'filecoin_pin'`). The default is `'synapse'`,
 * backed by `@filoz/synapse-sdk` directly; the Phase 5 opt-in
 * `'filecoin_pin'` driver is backed by `filecoin-pin/core/upload`
 * and composes the Synapse client for non-CAR-first operations.
 * The closed-union type forces every new driver to be a literal-
 * by-literal addition; never widen it to plain `string`.
 *
 * Boundary rules:
 *
 * - The wrapper `backend.ts` is the ONLY caller of these methods.
 *   The reconciler, the route layer, and the service layer never
 *   talk to a `FilecoinProviderClient` directly.
 * - Inputs and outputs are AtomicMemory-shaped, NOT Synapse-shaped.
 *   Mapping happens inside the concrete client
 *   (`synapse-client.ts`); vendor types never escape
 *   `providers/filecoin/`.
 * - Sanitization (see `errors.ts`): any vendor error a client
 *   catches must be replaced with a `FilecoinProviderError` whose
 *   `errorCode` is one of the documented stable codes. Raw vendor
 *   messages do not escape.
 */

export interface FilecoinCopySnapshot {
  /** SP identifier (stringified bigint — JSON cannot carry bigint). */
  readonly providerId: string;
  /** Data-set identifier this copy lives in (stringified bigint). */
  readonly dataSetId: string;
  /**
   * Piece-id within the data set (stringified positive decimal
   * bigint). OMITTED when the underlying driver returned a
   * sentinel/non-positive value: filecoin-pin's `executeUpload`
   * can return `pieceId === 0n` for copies that have been stored
   * at the SP but not yet confirmed at the data-set, and writing
   * the raw `'0'` into the sidecar would later trip the hint
   * reader's positive-decimal-bigint validator and emit a
   * spurious `filecoin.hint.malformed` diagnostic on every
   * delete. Absent is silently skipped; only positive values are
   * carried.
   */
  readonly pieceId?: string;
  /** `'primary'` (uploaded direct) or `'secondary'` (pulled SP→SP). */
  readonly role: 'primary' | 'secondary';
}

export interface FilecoinFailedAttempt {
  readonly providerId: string;
  readonly role: 'primary' | 'secondary';
  /** Sanitized error code; never the raw vendor message. */
  readonly errorCode: string;
  /** Whether the caller explicitly pinned the provider (no retry). */
  readonly explicit: boolean;
}

export interface FilecoinPutInput {
  /**
   * Storage-key prefix the upload pipeline computed (PII-safe HMAC).
   * The Synapse client does not consume this directly — the SDK
   * routes by data set, not key — but the adapter still propagates
   * it for shared observability/metrics with the immediate
   * providers.
   */
  readonly key: string;
  /** Bytes to upload. The Synapse SDK accepts `Uint8Array | ReadableStream`. */
  readonly body: Buffer;
  readonly contentType?: string;
  /**
   * Optional sanitized per-piece metadata produced by
   * `metadata.ts:buildFilecoinMetadata`. Caller is responsible for
   * staying under Synapse's `MAX_KEYS_PER_PIECE` cap. The adapter
   * passes this through to `StorageManager.upload`'s
   * `pieceMetadata` option as string-only entries.
   */
  readonly pieceMetadata?: Readonly<Record<string, string>>;
  /** Per-call timeout (ms); the adapter wires this to an `AbortSignal`. */
  readonly timeoutMs?: number;
}

export interface FilecoinPutResult {
  /** PieceCID stringified for stable serialization across logs/storage. */
  readonly pieceCid: string;
  /**
   * Canonical storage URI persisted on the row, of the form
   * `filecoin://piece/<pieceCid>`.
   */
  readonly storageUri: string;
  /** Bytes the SDK reported as stored (post-padding). */
  readonly sizeBytes: number;
  /** Successful copies reported by `UploadResult.copies`. */
  readonly copies: ReadonlyArray<FilecoinCopySnapshot>;
  /** Sanitized failed attempts from `UploadResult.failedAttempts`. */
  readonly failedAttempts: ReadonlyArray<FilecoinFailedAttempt>;
  /** `true` iff every requested copy succeeded. */
  readonly complete: boolean;
  /** Copy count the caller requested (echoed from the SDK). */
  readonly requestedCopies: number;
  /**
   * Optional IPFS / CAR-root CID (CIDv1, any IPLD codec) the
   * driver derived alongside the PieceCID. The live Synapse
   * driver leaves this `undefined` today; the filecoin-pin
   * driver (Phase 5) is expected to populate it so consumers
   * can resolve content via IPFS gateways without re-deriving
   * the CID from bytes. The adapter validates the value via
   * `requireIpfsCid` (real `multiformats/cid` parse), persists
   * the canonical multibase form under
   * `raw_storage_metadata.filecoin.ipfs_cid`, and projects it
   * publicly as `ipfs_cid`. The canonical AtomicMemory storage
   * URI stays `filecoin://piece/<canonicalPieceCid>` regardless —
   * `ipfsCid` does NOT change row identity.
   */
  readonly ipfsCid?: string;
}

export interface FilecoinGetInput {
  readonly storageUri: string;
  readonly timeoutMs?: number;
}

export interface FilecoinGetResult {
  readonly body: Buffer;
  /**
   * Bounded provider metadata that survived public projection. The
   * adapter does NOT echo the full SDK download result back — it
   * only carries the piece identity for the reconciler.
   */
  readonly providerMetadata: Record<string, unknown>;
}

export interface FilecoinHeadInput {
  readonly storageUri: string;
  /**
   * Optional hint for which data set holds the piece. When omitted
   * the adapter consults `StorageManager.findDataSets` to locate
   * the right context.
   */
  readonly dataSetId?: string;
}

export interface FilecoinHeadResult {
  readonly exists: boolean;
  /**
   * `true` once the piece is retrievable AND the data set's most
   * recent proof has been accepted. Bounded so the reconciler can
   * promote `blob_pending → blob_available` without exposing the
   * full PDP cycle state on the public wire.
   */
  readonly proven: boolean;
  readonly providerMetadata: Record<string, unknown>;
}

export interface FilecoinDeleteInput {
  readonly storageUri: string;
  readonly dataSetId?: string;
  /**
   * Positive decimal bigint string carrying the per-copy
   * `piece_id` Synapse assigned at upload time (see
   * `UploadResult.copies[].pieceId` and the sidecar
   * `raw_storage_metadata.filecoin.copies[].piece_id`). When
   * supplied, the Synapse driver issues
   * `deletePiece({ piece: BigInt(pieceId) })` against the
   * resolved data-set context. This bypasses the SDK's
   * CID→active-piece lookup, which cannot resolve freshly
   * uploaded pieces before PDP proof lands — the lookup path
   * is the failure mode the live calibration smoke surfaced.
   */
  readonly pieceId?: string;
}

export interface FilecoinDeleteResult {
  readonly deleted: boolean;
  readonly semantics: 'tombstone' | 'unpin' | 'delete';
  /**
   * Hex transaction hash of the scheduled-removal tx, when the
   * provider returned one. `undefined` is reported as
   * `already-scheduled` semantics.
   */
  readonly txHash?: string;
}

export interface FilecoinVerifyInput {
  readonly storageUri: string;
  readonly expectedContentHash: string;
  readonly timeoutMs?: number;
}

export interface FilecoinVerifyResult {
  readonly verified: boolean;
  readonly reason?: string;
}

export type FilecoinReadinessNetwork = 'calibration' | 'mainnet';

export type FilecoinReadinessStatus = 'passed' | 'failed' | 'unknown';

/**
 * Closed-shape readiness probe entry. Errors are reported via the
 * opaque `errorCode` from a documented stable set — raw vendor
 * messages, wallet addresses, allowances, and provider auth
 * payloads do NOT cross this boundary.
 */
export interface FilecoinReadinessCheck {
  readonly name: string;
  readonly status: FilecoinReadinessStatus;
  readonly errorCode?: string;
}

/**
 * Closed union of accepted driver names. New drivers MUST be added
 * to this union literal-by-literal so exhaustive `switch (driver)`
 * coverage stays compiler-enforced. NEVER widen this to plain
 * `string` — that would forfeit the exhaustiveness invariant the
 * harvest plan §Virtues 1 calls out. Adding a new value here is a
 * type-level capability gate; runtime acceptance is gated
 * separately by `parseFilecoinProviderConfig` in `config.ts`.
 */
export type FilecoinDriverName = 'synapse' | 'filecoin_pin';

export interface FilecoinProviderClient {
  readonly provider: 'filecoin';
  readonly driver: FilecoinDriverName;
  put(input: FilecoinPutInput): Promise<FilecoinPutResult>;
  get(input: FilecoinGetInput): Promise<FilecoinGetResult>;
  head(input: FilecoinHeadInput): Promise<FilecoinHeadResult>;
  delete(input: FilecoinDeleteInput): Promise<FilecoinDeleteResult>;
  verify(input: FilecoinVerifyInput): Promise<FilecoinVerifyResult>;
  /**
   * Non-mutating readiness probe used by the factory and (later)
   * the reconciler. The provider client owns the probe — the
   * adapter, route layer, and document service never call into
   * the SDK for readiness. Every check carries a stable
   * `errorCode` from the documented enum so log consumers and
   * tests can rely on the shape regardless of how the SDK
   * reports the underlying condition.
   */
  checkReadiness(
    network: FilecoinReadinessNetwork,
  ): Promise<ReadonlyArray<FilecoinReadinessCheck>>;
  /**
   * Non-mutating SDK read of the provider's advertised minimum
   * upload size in bytes. Used by preflight/sizing callers
   * (live calibration smoke + future direct-upload sizing) to
   * size payloads against the provider's real contract rather
   * than a baked-in constant. Lookup failures throw a typed
   * `FilecoinProviderError` (errorCode `filecoin_storage_info_failed`
   * on Synapse; per-driver code on other implementations); they
   * never resolve to `null` or silently degrade.
   */
  getServiceMinUploadBytes(): Promise<number>;
}
