/**
 * @file Document-route response schemas.
 *
 * Extracted from `schemas/responses.ts` (which was at 435 non-comment
 * LOC after Slice 3, over the workspace's 400 rule). The shapes are
 * unchanged — this is a pure relocation. `responses.ts` re-exports
 * each symbol so existing imports through `import * as R from
 * './responses'` keep working.
 *
 * Field naming follows the wire contract (snake_case). Per-layer
 * per-layer status enums + `last_error` envelope come from the
 * shared `document-status-envelope` module so the same definitions
 * back both `RawDocumentResponseSchema` (full row) and the
 * passport-feed grouped-row schema.
 */

import { z } from './zod-setup.js';
import {
  ExtractionStatusEnumSchema,
  LastErrorEnvelopeSchema,
  RawStorageStatusEnumSchema,
  SemanticIndexStatusEnumSchema,
} from './document-status-envelope.js';

/**
 * Wire shape for `raw_storage_metadata`. Strict allowlist:
 *   - `codec`: `{ name, version }` only. AES-GCM internals
 *     (`nonce`/`tag`/`key_id`/`encoded_*`) NEVER reach the wire.
 *   - `filecoin`: public projection
 *     `{ ipfs_cid?, piece_cid?, copy_count, provider_ids,
 *     copy_statuses }` (Phase 4 renamed the legacy ambiguous
 *     `cid` slot to `ipfs_cid`). The structured internal
 *     `copies: [{provider_id, status}]` blob is flattened by
 *     `projectFilecoinPublicMetadata` at the formatter; legacy
 *     onramp fields (`onramp`, `gateway_url`, `deal_ids`,
 *     `onramp_status`, `deal_status`, `retrieval_verified_at`,
 *     `last_verified_at`) and the legacy `cid` slot are NOT
 *     emitted — the strict schema rejects them at the wire.
 *   - `upload_result` (internal upload sidecar) is NOT declared,
 *     so any leak fails the response-shape validator.
 *
 * The formatter (`formatPublicRawStorageMetadata`) is the single
 * source of redaction; this schema is the deny-by-default lock at
 * the route boundary. Every nested object is `.strict()` so a
 * formatter regression that lets ANY unknown key through fails the
 * `validateResponse` middleware instead of silently shipping.
 */
export const PublicRawStorageMetadataSchema = z.object({
  codec: z.object({
    name: z.enum(['none', 'aes_gcm']),
    version: z.number(),
  }).strict().optional(),
  filecoin: z.object({
    ipfs_cid: z.string().optional(),
    piece_cid: z.string().optional(),
    copy_count: z.number().int().nonnegative().optional(),
    provider_ids: z.array(z.string()).optional(),
    copy_statuses: z.array(z.string()).optional(),
  }).strict().optional(),
}).strict().openapi({
  description:
    'Public-facing raw_storage_metadata. STRICTLY allowlisted: codec ' +
    'emits only name+version (AES-GCM internals never reach the wire); ' +
    'filecoin emits public fields ' +
    '(ipfs_cid, piece_cid, copy_count, provider_ids, copy_statuses) — ' +
    '`ipfs_cid` is an optional CIDv1 IPFS / CAR-root identity hint ' +
    'populated by drivers that derive one alongside the PieceCID; the ' +
    'canonical storage URI stays `filecoin://piece/<piece_cid>` ' +
    'regardless. The internal structured copies[{provider_id,status}] ' +
    'shape is flattened at the formatter; upload_result and other ' +
    'internal sidecars are NEVER emitted. The schema is deny-by-default ' +
    '(`.strict()`) at every level — a formatter regression that lets ' +
    'unknown keys through fails response-shape validation.',
});

/** Wire enum for per-row delete semantics. */
export const DeleteSemanticsEnumSchema = z.enum(['delete', 'unpin', 'tombstone']).nullable()
  .openapi({
    description:
      "What AtomicMemory's DELETE call does at the provider boundary " +
      "for this row's storage_provider. `'delete'` = adapter issues the " +
      "provider's removal operation; `'unpin'` = removes AtomicMemory's " +
      "pin but the provider's other peers may continue to serve; " +
      "`'tombstone'` = AtomicMemory stops managing the bytes but the " +
      "decentralized network may still serve. `null` for pointer-only " +
      "rows or providers not registered for cleanup.",
  });

/**
 * Wire-format shape of a document record. Mirrors `RawDocumentRow`
 * with snake_case keys. `storage_uri` and `storage_provider` are
 * always null until managed-blob storage is configured.
 */
export const RawDocumentResponseSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  raw_source_id: z.string(),
  external_id: z.string(),
  external_uri: z.string().nullable(),
  display_name: z.string().nullable(),
  mime_type: z.string().nullable(),
  size_bytes: z.number().nullable(),
  content_hash: z.string().nullable(),
  provider_version: z.string().nullable(),
  source_modified_at: z.string().nullable(),
  storage_mode: z.enum(['pointer_only', 'managed_blob', 'inline_small_text']),
  storage_uri: z.string().nullable(),
  storage_provider: z.string().nullable(),
  registration_status: z.enum(['registered', 'registration_failed']),
  raw_storage_status: RawStorageStatusEnumSchema,
  // Public allowlist: `PublicRawStorageMetadata` projects
  // through `formatPublicRawStorageMetadata` so AES-GCM internals,
  // `upload_result`, and any unknown filecoin fields can never reach
  // the wire. Internal structured `copies: [{ provider_id, status }]`
  // flattens to `copy_count` / `provider_ids` / `copy_statuses` via
  // the shared `projectFilecoinPublicMetadata` helper.
  raw_storage_metadata: PublicRawStorageMetadataSchema,
  // Per-row delete-semantics capability. NULL
  // for pointer-only rows and providers the deployment doesn't have
  // registered for cleanup.
  delete_semantics: DeleteSemanticsEnumSchema,
  metadata: z.record(z.string(), z.unknown()),
  created_at: z.string(),
  updated_at: z.string(),
  indexed_content_hash: z.string().nullable(),
  indexed_at: z.string().nullable(),
  // Per-layer status envelope. Sub-schemas in
  // `document-status-envelope.ts`. `'running'` is internal in the
  // synchronous indexer: readers under READ COMMITTED do
  // not observe it because the write lives inside the
  // BEGIN..COMMIT transaction.
  extraction_status: ExtractionStatusEnumSchema,
  semantic_index_status: SemanticIndexStatusEnumSchema,
  last_error: LastErrorEnvelopeSchema,
  // Additive link to the paired `storage_artifacts` row. NULL for
  // pointer-only stubs without `external_uri` and older rows.
  storage_artifact_id: z.string().uuid().nullable(),
}).openapi({ description: 'Document registry record. snake_case wire format.' });

export const RegisterDocumentResponseSchema = z.object({
  document: RawDocumentResponseSchema,
  created: z.boolean(),
}).openapi({
  description:
    'Document registration result. `created: true` when a new row was inserted; ' +
    '`false` when an active row with the same (user, source, external_id, version) ' +
    'already existed.',
});

export const ListDocumentsResponseSchema = z.object({
  documents: z.array(RawDocumentResponseSchema),
  count: z.number(),
}).openapi({ description: 'Paginated document list.' });

/**
 * Cursor-paginated user-scoped document list. Distinct from
 * `ListDocumentsResponseSchema` (the legacy `/list` shape) because it
 * carries an opaque cursor instead of `count`, matching the
 * "fetch-next-page" UX the document-detail / recovery surfaces
 * need. `next_cursor: null` means the stream is exhausted.
 */
export const DocumentListRootResponseSchema = z.object({
  documents: z.array(RawDocumentResponseSchema),
  next_cursor: z.string().nullable(),
}).openapi({ description: 'Cursor-paginated document list.' });

export const DeleteDocumentResponseSchema = z.object({
  success: z.literal(true),
  already_deleted: z.boolean(),
}).openapi({
  description:
    'Document soft-delete acknowledgement. `already_deleted: true` when the row was ' +
    'missing or previously tombstoned (idempotent on repeat calls).',
});

export const UploadRawDocumentResponseSchema = z.object({
  document_id: z.string(),
  storage_provider: z.string(),
  storage_uri: z.string(),
  // PLAINTEXT content hash — the bytes the caller passed in, not
  // the encoded bytes the adapter stored.
  content_hash: z.string(),
  size_bytes: z.number(),
  // Filecoin uses `'blob_available'` once gateway retrieval is
  // confirmed, immediate providers use `'blob_stored'`, and pending
  // provider acceptances use `'blob_pending'` for the reconciler to
  // promote. `'blob_archival_failed'` is written by the reconciler,
  // never returned from this endpoint.
  raw_storage_status: z.enum(['blob_stored', 'blob_pending', 'blob_available']),
  storage_mode: z.literal('managed_blob'),
  // Public allowlist (same as `RawDocumentResponseSchema`).
  // Internal `upload_result` sidecar + AES-GCM internals NEVER reach
  // the wire; internal `copies: [{ provider_id, status }]` flattens
  // to public scalar `copy_count` / `provider_ids` / `copy_statuses`.
  raw_storage_metadata: PublicRawStorageMetadataSchema,
  // Per-row delete_semantics — resolved from the just-uploaded row's
  // `storage_provider` via the registry.
  delete_semantics: DeleteSemanticsEnumSchema,
  idempotent_skip: z.boolean(),
}).openapi({
  description:
    'Managed-blob upload result. The document row is now ' +
    "`storage_mode='managed_blob'` with `raw_storage_status` set to " +
    "`'blob_stored'` (immediate providers — local_fs, s3), " +
    "`'blob_pending'` (eventual providers awaiting the " +
    "reconciler), or `'blob_available'` (gateway-confirmed " +
    "retrievable on Filecoin). `content_hash` is the SHA-256 of the " +
    'PLAINTEXT bytes (distinct from `indexed_content_hash` and from ' +
    'the encoded-byte hash the codec writes under ' +
    '`raw_storage_metadata.codec`, which is internal). ' +
    '`raw_storage_metadata` is the public allowlist ' +
    '(codec name+version + Synapse filecoin allowlist with ' +
    'flattened copy_count/provider_ids/copy_statuses — internal ' +
    'sidecars stripped). `delete_semantics` advertises what ' +
    "AtomicMemory's DELETE call will do at the provider boundary for " +
    'this row. `idempotent_skip: true` when the same bytes were ' +
    'already attached to this document.',
});

export const IndexDocumentResponseSchema = z.object({
  document_id: z.string(),
  indexed_content_hash: z.string(),
  chunks_created: z.number(),
  memories_created: z.number(),
  idempotent_skip: z.boolean(),
  chunker_version: z.string(),
  parser_version: z.string(),
}).openapi({
  description:
    'Text indexing result. `indexed_content_hash` is the SHA-256 ' +
    'of the indexed text and is stored on the document as ' +
    '`indexed_content_hash` (distinct from the upstream/provider ' +
    '`content_hash`). `idempotent_skip: true` when the input matched the ' +
    'prior indexed text under the current chunker_version (no fresh ' +
    'chunks or memories created); otherwise the prior generation was ' +
    'soft-deleted and the counts reflect the new generation.',
});

export const DocumentLimitsResponseSchema = z.object({
  raw_upload_max_bytes: z.number().int().positive(),
  index_max_text_bytes: z.number().int().positive(),
  raw_storage: z.object({
    enabled: z.boolean(),
    mode: z.enum(['pointer_only', 'managed_blob']),
    reason: z.string().optional(),
    // Filecoin lifecycle refactor (Slice 4): when `mode = 'managed_blob'`
    // and an adapter is configured, the active store's
    // `capabilities` surface here. snake_case on the wire; the route
    // formatter is the only camelCase→snake_case mapper. All five
    // capability fields are optional so a `pointer_only` deployment
    // (no store) still validates.
    provider: z.string().optional(),
    addressing: z.enum(['location', 'content']).optional(),
    retrieval_consistency: z.enum(['immediate', 'eventual']).optional(),
    delete_semantics: z.enum(['delete', 'unpin', 'tombstone']).optional(),
    supports_head: z.boolean().optional(),
    supports_get: z.boolean().optional(),
  }),
}).openapi({
  description:
    'Document upload/index limits and raw-storage capability. Public ' +
    'preflight surface — clients read this to size requests and decide ' +
    'whether to attempt a managed-blob upload. When a managed-blob ' +
    'adapter is configured, `raw_storage` additionally advertises the ' +
    "active store's `provider` + capability triple " +
    '(`addressing`, `retrieval_consistency`, `delete_semantics`) so ' +
    'clients can render honest copy for eventual-provider flows. ' +
    'No PII, no per-user state.',
});

/**
 * failure-transition - response shape for `POST /v1/documents/:id/extraction-failure`
 * and `POST /v1/documents/:id/index-failure`. Both endpoints return the
 * row in its post-transition state so the caller can read back the
 * `extraction_status` / `semantic_index_status` / `last_error` they
 * just persisted without a round-trip to `GET /:id`. `idempotent` is
 * `true` when the call hit the already-failed-row idempotent retry
 * branch (no state change beyond `last_error.occurred_at`/`message`).
 */
export const DocumentFailureMarkerResponseSchema = z.object({
  document: RawDocumentResponseSchema,
  idempotent: z.boolean(),
}).openapi({
  description:
    'Constrained-transition acknowledgement. The persisted row is ' +
    'echoed so callers can read back the durable status they just ' +
    'wrote. `idempotent: true` when the row was already in the ' +
    'failed state and the call only refreshed `last_error`.',
});
