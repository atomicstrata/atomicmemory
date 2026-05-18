/**
 * Raw-content storage interface for the document pipeline.
 *
 * Adapter-agnostic facade for the bytes that back a document with
 * `storage_mode = 'managed_blob'`. Implementations live alongside this
 * file (`local-fs-store.ts`, `s3-store.ts`); the factory in
 * `factory.ts` selects one at startup based on `RuntimeConfig`.
 *
 * Contract:
 *
 * - `put` writes the supplied bytes under the supplied key, returns the
 *   URI we will persist on `raw_documents.storage_uri`.
 * - `get` and `head` accept the same URI shape `put` returned. They are
 *   the read-side hooks the future parsing path will call.
 * - `delete` is **idempotent**: a missing key returns `{ deleted: false }`,
 *   not an error. Transport/auth failures still throw.
 * - Adapters MUST NOT silently fall back to a different provider; if
 *   their config is wrong or the upstream service is unavailable, they
 *   must throw.
 */

/**
 * Lifecycle hint returned by `put`. Immediate providers (`local_fs`,
 * `s3`) always report `'stored'` — bytes are retrievable the moment
 * `put` returns. Eventual providers (e.g. Filecoin onramps in a future
 * phase) may report `'pending'` when the provider has accepted the
 * upload but storage/retrievability is not yet confirmed; the service
 * layer maps that onto `raw_storage_status='blob_pending'` and a
 * reconciler later promotes the row to `'blob_available'` or
 * `'blob_archival_failed'`.
 */
export type StoredRawContentStatus = 'stored' | 'pending';

/** Identifier returned by `put`; opaque to the rest of the codebase. */
export interface StoredRawContent {
  /** Adapter-prefixed URI we persist on `raw_documents.storage_uri`. */
  storageUri: string;
  /** Adapter id (e.g. `local_fs`, `s3`). Mirrors `raw_documents.storage_provider`. */
  storageProvider: string;
  /** SHA-256 hex of the bytes the adapter actually stored. */
  contentHash: string;
  /** Bytes actually persisted. Always equals `input.body.length`. */
  sizeBytes: number;
  /** See {@link StoredRawContentStatus}. */
  status: StoredRawContentStatus;
  /** Provider-side identifiers the service layer persists on `raw_documents.raw_storage_metadata`. */
  providerMetadata: RawContentProviderMetadata;
}

export interface PutRawContentInput {
  /** Adapter-relative key (e.g. `<prefix>/s/<hmac-hex32>/documents/<doc-id>/<hash>.bin`). */
  key: string;
  /** Bytes to persist. The adapter does not mutate this. */
  body: Buffer;
  /** Optional MIME type, persisted alongside the blob when supported. */
  contentType?: string;
}

/**
 * Free-form provider-side metadata. Immediate providers may
 * populate scalar fields like `etag`/`versionId`/`mtime`;
 * content-addressed providers nest a provider-keyed sibling
 * carrying their own internal shape (e.g. the Filecoin adapter
 * writes `{ filecoin: { piece_cid, copies, … } }`). The exact
 * sub-shape is provider-specific and treated as opaque by the
 * upload pipeline; the public-projection seam
 * (`filecoin-public-metadata.ts` and friends) is the single
 * translator from that internal shape to the wire response.
 */
export type RawContentProviderMetadata = Record<string, unknown>;

export interface RawContentMetadata {
  contentLength: number;
  contentType: string | null;
  contentHash: string | null;
  providerMetadata: RawContentProviderMetadata;
}

/**
 * Permanent-failure signal returned by `head()` when the provider
 * itself reports that this specific URI / CID will NEVER become
 * retrievable. The reconciler routes a `permanent` head
 * result directly to `blob_archival_failed` without consuming a
 * retry — there's no point in continuing to probe.
 *
 * Adapters MUST only set this for per-row terminal failures
 * (Filecoin onramp `status: 'failed'`, malformed `ipfs://` URI,
 * etc.). Auth / capability / rate-limit / 5xx outages are GLOBAL
 * infra failures affecting every row — those stay transient
 * (thrown errors or `exists: false`) so a single misconfigured
 * deployment doesn't permanently fail every pending row.
 */
export interface RawContentPermanentFailure {
  code: string;
  message: string;
}

export interface RawContentHeadResult {
  exists: boolean;
  metadata: RawContentMetadata | null;
  /** Optional per-row terminal-failure signal; see {@link RawContentPermanentFailure}. */
  failure?: RawContentPermanentFailure;
}

export interface RawContentGetResult {
  body: Buffer;
  metadata: RawContentMetadata;
}

export interface RawContentDeleteResult {
  /**
   * `true` when the adapter actively removed bytes; `false` when the
   * adapter found nothing to remove (already-missing). Both are
   * NON-ERROR outcomes — the cleanup helper records both in
   * `successes[]` and writes a terminal status marker either way.
   */
  deleted: boolean;
  /**
   * What the adapter's `delete` call DID at the provider boundary
   * (rev-2 §1, rev-7 §5). Drives the cleanup marker:
   *
   *   - `'deleted'`     → `markRawStorageDeletedByUri`   → `blob_deleted`
   *   - `'unpinned'`    → `markRawStorageTombstonedByUri` → `blob_tombstoned`
   *   - `'tombstoned'`  → `markRawStorageTombstonedByUri` → `blob_tombstoned`
   *
   * Already-missing carries the provider's natural semantics — a
   * local_fs `ENOENT` is still `'deleted'` (bytes are gone), a
   * Filecoin already-removed is still `'tombstoned'` (we stop
   * managing the bytes either way).
   */
  semantics: 'deleted' | 'unpinned' | 'tombstoned';
  /**
   * **Internal-only** billing/cost-impact metadata for uncertain
   * delete outcomes (Phase 7 of the Filecoin harvest plan). For
   * Filecoin, the Synapse SDK's `deletePiece({piece})` returns
   * an on-chain `0x…` transaction hash that scheduled the
   * removal — operators correlate this hash to chain-side gas
   * cost so they can audit the cost-impact of a cleanup pass.
   * Other providers (`local_fs`, `s3`) leave the field
   * `undefined`.
   *
   * **MUST NOT cross any public boundary.** The cleanup-result
   * DTO (`ManagedBlobCleanupSuccess`) is closed-key by design;
   * the route response shape never includes `txHash`. The only
   * legitimate consumer is the internal observability emitter
   * (`emitFilecoinEvent('filecoin.delete.tombstoned', { …,
   * deleteTxHash })`), which logs to operator-side telemetry.
   * The leak-invariant tests in
   * `cleanup-leak-invariants.test.ts` pin the absence on the
   * public side.
   */
  txHash?: string;
}

/**
 * Capability advertisement for a `RawContentStore` instance. The
 * upload service, status mapping, and `/v1/documents/limits` route
 * read these to decide (a) which `raw_storage_status` to write after a
 * successful `put`, (b) how `delete` interacts with the managed
 * object (issued provider removal vs unpin vs tombstone), and (c)
 * what semantics to advertise to clients via the preflight endpoint.
 */
export interface RawContentStoreCapabilities {
  /**
   * `'location'` — provider URIs are path-addressed (S3 key, local-fs
   * path). A subsequent `put` to the same key replaces the bytes the
   * URI resolves to; the URI does NOT carry a content commitment.
   * `'content'` — provider URIs are content-addressed (e.g. CID), so
   * the URI is itself a commitment over the bytes the caller stored.
   */
  addressing: 'location' | 'content';
  /**
   * `'immediate'` — bytes are retrievable the instant `put` resolves.
   * `'eventual'` — bytes may not yet be retrievable when `put`
   * resolves; the provider exposes a separate "is it available yet"
   * signal that the future reconciler consults.
   */
  retrievalConsistency: 'immediate' | 'eventual';
  /**
   * Describes what AtomicMemory's `delete` call DOES at the provider
   * boundary; it does NOT promise universal byte erasure (provider
   * versioning, object-lock, retention policy, replication, etc. live
   * outside AtomicMemory's control).
   *
   * `'delete'` — `delete` issues the provider's removal operation for
   * the managed object (e.g. `DeleteObject`, `unlink`). The provider
   * may still retain prior versions / replicas / backups according to
   * its own configuration; AtomicMemory does not assert otherwise.
   * `'unpin'` — `delete` removes AtomicMemory's pin/reference only;
   * the provider may continue to serve the bytes from other peers.
   * `'tombstone'` — AtomicMemory stops managing the bytes and cannot
   * issue removal at the provider (typical for decentralized
   * networks where AtomicMemory is one of many holders).
   */
  deleteSemantics: 'delete' | 'unpin' | 'tombstone';
  /** Whether `head` is implemented (true for all current adapters). */
  supportsHead: boolean;
  /** Whether `get` is implemented (true for all current adapters). */
  supportsGet: boolean;
}

/**
 * Opaque provider hints that `head`/`delete` MAY consult to optimize
 * lookups. Shape: a provider-keyed map mirroring the sidecar
 * `raw_documents.raw_storage_metadata` carries (e.g.
 * `{ filecoin: { data_set_id: '42' } }`). Adapters MUST treat
 * unknown / malformed / missing entries as ABSENT and fall back to
 * their normal lookup path — hints are an optimization, never a
 * correctness contract. The generic shape stays a plain
 * `Record<string, unknown>` so the boundary doesn't acquire any
 * provider-specific surface (rev-c201f21 instruction §4); each
 * adapter parses its own sibling internally.
 */
export type RawContentHints = Readonly<Record<string, unknown>>;

/**
 * Raw-content adapter. All methods are user-agnostic — caller scoping
 * lives in the key the route layer constructs.
 *
 * `head` and `delete` accept an optional `hints` object that adapters
 * MAY use to short-circuit lookups (e.g. the Filecoin adapter reads
 * `hints.filecoin.data_set_id` so it can call
 * `createContext({dataSetId})` directly instead of scanning every
 * owned data set via `findDataSets`). Adapters that don't recognize
 * a hint MUST ignore it.
 */
export interface RawContentStore {
  /** Adapter id, persisted on `raw_documents.storage_provider`. */
  readonly provider: string;
  /** See {@link RawContentStoreCapabilities}. */
  readonly capabilities: RawContentStoreCapabilities;
  put(input: PutRawContentInput): Promise<StoredRawContent>;
  get(storageUri: string): Promise<RawContentGetResult>;
  head(storageUri: string, hints?: RawContentHints): Promise<RawContentHeadResult>;
  delete(storageUri: string, hints?: RawContentHints): Promise<RawContentDeleteResult>;
}

/** Thrown when a storage URI doesn't match the adapter's expected shape. */
export class RawStorageUriError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RawStorageUriError';
  }
}
