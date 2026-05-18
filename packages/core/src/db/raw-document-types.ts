/**
 * Row + input types for the document pipeline (Phase 1).
 *
 * Mirrors the columns defined in `schema.sql` for `raw_sources` and
 * `raw_documents`. The CHECK constraints in SQL accept the full enum
 * range so later phases (managed_blob, inline_small_text) can populate
 * those values without a schema change; Phase 1 service-layer code
 * still only writes `storage_mode = 'pointer_only'`.
 */

export type RawStorageMode =
  | 'pointer_only'
  | 'managed_blob'
  | 'inline_small_text';

export type RegistrationStatus = 'registered' | 'registration_failed';

export type RawStorageStatus =
  | 'pointer_recorded'
  | 'blob_stored'
  | 'inline_text_stored'
  | 'raw_storage_failed'
  /**
   * Terminal state for a tombstoned managed-blob row whose bytes were
   * successfully deleted from the configured `RawContentStore`. Set by
   * the Phase-3 cleanup path *after* the soft-delete and *after* the
   * adapter's delete call returned; lets retries of `DELETE
   * /v1/documents/:id` distinguish "blob is gone" from
   * "blob still needs cleanup" (raw_storage_failed).
   */
  | 'blob_deleted'
  /**
   * Filecoin lifecycle refactor (Slice 2): the provider accepted the
   * upload but storage / retrievability is not yet confirmed. The
   * upload service writes this when the adapter's `put()` returned
   * `status: 'pending'` (an eventual provider). The future Phase 3
   * reconciliation worker polls `head()` and promotes the row to
   * `blob_available` (success) or `blob_archival_failed` (permanent
   * failure).
   */
  | 'blob_pending'
  /**
   * Reserved for the Phase 3 reconciliation worker. No Phase-1
   * writer; the schema and the union just have to accept it so the
   * Phase 3 worker can flip a row from `blob_pending` once `head()`
   * confirms retrievability.
   */
  | 'blob_available'
  /**
   * Reserved for the Phase 3 reconciler's permanent-failure path. No
   * Phase-1 writer.
   */
  | 'blob_archival_failed'
  /**
   * Reserved for Phase 2 Filecoin deletes against providers that
   * support unpin-only semantics. No Phase-1 writer.
   */
  | 'blob_tombstoned'
  /**
   * Filecoin lifecycle refactor (Phase 5) — transient state during
   * the upload pipeline's α/β/β2/γ split. Phase α writes this with a
   * `raw_storage_claim_id` after seizing the slot; Phase γ flips it
   * to the final terminal state (`blob_stored` / `blob_pending` /
   * `blob_available`) once the adapter returns. A row that stays in
   * `blob_uploading` past a process restart is recoverable via
   * same-bytes idempotent retry of `uploadRaw`; the Phase 6
   * reconciler does NOT process `blob_uploading` rows.
   */
  | 'blob_uploading';

/**
 * Phase B (document-ingest hardening) — text-extraction layer status.
 * Mirrors the values in `raw_documents.extraction_status` (CHECK
 * constraint in `schema.sql`).
 */
export type ExtractionStatus =
  | 'not_required'
  | 'pending'
  | 'running'
  | 'complete'
  | 'unsupported'
  | 'failed';

/**
 * Phase B — semantic indexing layer status (chunk + embed + store).
 * Mirrors `raw_documents.semantic_index_status`. Note that `'running'`
 * is internally written inside the indexer's BEGIN..COMMIT
 * transaction; under READ COMMITTED isolation other connections do
 * NOT observe it. The state lives on the row only as a CAS marker;
 * UI rendering of "indexing in progress" requires a future
 * async-worker design that commits `'running'` before doing the
 * work, with a lease/heartbeat for crash recovery.
 */
export type SemanticIndexStatus =
  | 'not_required'
  | 'pending'
  | 'running'
  | 'complete'
  | 'failed'
  | 'stale';

/** Layer that produced the most-recent failure recorded on a row. */
export type LastErrorLayer = 'raw_storage' | 'extraction' | 'semantic_index';

/**
 * Phase B — most-recent failure envelope persisted on `raw_documents.last_error`.
 *
 * Single most-recent failure per row; cleared on the next successful
 * transition for that layer. Snake_case at the storage layer and on
 * the wire so JSONB columns and HTTP responses share one shape.
 */
export interface LastError {
  layer: LastErrorLayer;
  /** Bounded enum chosen by the producing layer (e.g. `'managed_storage_disabled'`, `'index_text_too_large'`). */
  code: string;
  /** Human-readable detail. Producers should truncate to a sensible cap. */
  message: string;
  /** ISO 8601 UTC timestamp. */
  occurred_at: string;
}

/**
 * Persisted shape of a `raw_sources` row. `account_id` is nullable for
 * sources that do not have a per-account scoping concept (e.g. manual
 * webapp uploads).
 */
export interface RawSourceRow {
  id: string;
  userId: string;
  sourceSite: string;
  provider: string;
  accountId: string | null;
  storageMode: RawStorageMode;
  retentionPolicy: Record<string, unknown>;
  consentPolicy: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertRawSourceInput {
  userId: string;
  sourceSite: string;
  provider: string;
  accountId?: string | null;
  storageMode?: RawStorageMode;
  retentionPolicy?: Record<string, unknown>;
  consentPolicy?: Record<string, unknown>;
}

/**
 * Persisted shape of a `raw_documents` row. Phase 1 callers see
 * `storageUri = null`, `storageProvider = null`, and
 * `rawStorageStatus = 'pointer_recorded'` for every active row.
 */
export interface RawDocumentRow {
  id: string;
  userId: string;
  rawSourceId: string;
  externalId: string;
  externalUri: string | null;
  displayName: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  contentHash: string | null;
  providerVersion: string | null;
  sourceModifiedAt: Date | null;
  storageMode: RawStorageMode;
  storageUri: string | null;
  storageProvider: string | null;
  registrationStatus: RegistrationStatus;
  rawStorageStatus: RawStorageStatus;
  /**
   * Provider-side identifiers for the managed blob — CID, piece CID,
   * deal id, onramp request id, gateway URL, etc. Set by the upload
   * service from `StoredRawContent.providerMetadata`. Opaque to the
   * upload pipeline; surfaced verbatim on the wire as
   * `raw_storage_metadata`. Defaults to `{}` for pointer-only rows
   * and for immediate providers (local_fs / s3) that don't yet
   * populate the field.
   */
  rawStorageMetadata: Record<string, unknown>;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  /**
   * Hash of the text last fed through `POST /v1/documents/:id/index`.
   * Distinct from `contentHash` (the upstream/provider raw-content
   * fingerprint). NULL until first indexed. Used by the Phase 2
   * indexer's idempotency check.
   */
  indexedContentHash: string | null;
  indexedAt: Date | null;
  /**
   * Phase B per-layer status fields. Default `'not_required'` for
   * legacy rows that predate the columns; new registrations
   * targeting the document pipeline set safe initial states
   * (`'pending'`) at registration time.
   */
  extractionStatus: ExtractionStatus;
  semanticIndexStatus: SemanticIndexStatus;
  /** Most-recent failure across any layer; null when no layer is currently failed. */
  lastError: LastError | null;
  /**
   * Phase 5 / Phase 6 private worker state. Holds the upload-pipeline
   * claim during α/β/β2/γ and the reconciler claim during the
   * blob_pending → blob_available promotion. These columns are
   * INTERNAL — `formatRawDocument` and `formatPublicRawStorageMetadata`
   * do NOT project them onto the wire; the upload service and the
   * reconciler are the only readers/writers.
   */
  rawStorageClaimId: string | null;
  rawStorageClaimedAt: Date | null;
  rawStorageLastCheckedAt: Date | null;
  rawStorageNextCheckAt: Date | null;
  rawStorageReconcileAttempts: number;
  /**
   * Durable "row entered blob_pending at" timestamp; the observability
   * layer reads this for the `pending_age_seconds` metric. Set by
   * Phase γ when writing `blob_pending`; cleared on terminal
   * transitions out of pending (blob_available, blob_archival_failed)
   * by the reconciler.
   */
  rawStoragePendingSince: Date | null;
  /**
   * Step 7 of the storage-sibling plan — FK to the row's paired
   * `storage_artifacts` entry. NULL for rows that pre-date Step 7
   * and for registration stubs (no `external_uri`, no managed
   * upload yet). The composite FK on
   * `(storage_artifact_id, user_id)` makes cross-user links
   * impossible at the persistence layer.
   */
  storageArtifactId: string | null;
}

export interface RegisterRawDocumentInput {
  userId: string;
  rawSourceId: string;
  externalId: string;
  externalUri?: string | null;
  displayName?: string | null;
  mimeType?: string | null;
  sizeBytes?: number | null;
  contentHash?: string | null;
  providerVersion?: string | null;
  sourceModifiedAt?: Date | null;
  storageMode?: RawStorageMode;
  metadata?: Record<string, unknown>;
  /**
   * Phase B — restricted-initial-state status fields. Clients may
   * declare `'pending'` (document pipeline expected to extract +
   * index this row), `'not_required'` (default; pointer-only flow),
   * or `'unsupported'` (extraction layer only — for known
   * non-extractable file types). Service-owned transitions handle
   * `'complete'` / `'failed'` / `'running'`; clients that supply
   * those values are rejected at the schema layer.
   */
  extractionStatus?: 'pending' | 'not_required' | 'unsupported';
  semanticIndexStatus?: 'pending' | 'not_required';
}

export interface ListRawDocumentsInput {
  userId: string;
  sourceSite?: string;
  limit?: number;
  offset?: number;
}
