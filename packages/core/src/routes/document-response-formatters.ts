/**
 * Wire-format formatters for /v1/documents/* responses.
 *
 * Mirrors the snake_case envelope the rest of the API uses: handlers
 * emit camelCase shapes from the service layer, this module flattens
 * them to the on-the-wire JSON.
 */

import type { RawDocumentRow } from '../db/raw-document-types.js';
import type {
  ListPassportFeedResult,
  PassportFeedRow,
} from '../db/passport-feed-repository.js';
import { formatPublicRawStorageMetadata } from './public-raw-storage-metadata.js';
import {
  getDeleteSemantics,
  type RawContentStoreRegistry,
} from '../storage/store-registry.js';

export function formatRawDocument(
  row: RawDocumentRow,
  registry: RawContentStoreRegistry,
): Record<string, unknown> {
  return {
    id: row.id,
    user_id: row.userId,
    raw_source_id: row.rawSourceId,
    external_id: row.externalId,
    external_uri: row.externalUri,
    display_name: row.displayName,
    mime_type: row.mimeType,
    size_bytes: row.sizeBytes,
    content_hash: row.contentHash,
    provider_version: row.providerVersion,
    source_modified_at:
      row.sourceModifiedAt instanceof Date ? row.sourceModifiedAt.toISOString() : null,
    storage_mode: row.storageMode,
    storage_uri: row.storageUri,
    storage_provider: row.storageProvider,
    registration_status: row.registrationStatus,
    raw_storage_status: row.rawStorageStatus,
    // Public allowlist: `upload_result` (internal upload sidecar)
    // + AES-GCM internals (`nonce`/`tag`/`key_id`/`encoded_*`) +
    // unknown filecoin fields are stripped. The internal Filecoin
    // sidecar `{ipfs_cid?, piece_cid, copies:[{provider_id, status}], ...}`
    // is projected through the shared
    // `projectFilecoinPublicMetadata` helper to the Synapse
    // public shape `{ipfs_cid?, piece_cid, copy_count,
    // provider_ids, copy_statuses}` (Phase 4 renamed the legacy
    // `cid` slot to `ipfs_cid`).
    raw_storage_metadata: formatPublicRawStorageMetadata(row.rawStorageMetadata),
    // Per-row capability advertisement for the UI delete-confirm
    // dialog. Resolved from the row's own
    // `storage_provider` via the registry — supports mixed-provider
    // deployments where legacy local_fs rows coexist with new
    // filecoin rows. NULL for pointer-only rows or
    // providers the deployment doesn't have registered.
    delete_semantics: getDeleteSemantics(registry, row.storageProvider),
    metadata: row.metadata,
    created_at: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
    updated_at: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt),
    indexed_content_hash: row.indexedContentHash,
    indexed_at: row.indexedAt instanceof Date ? row.indexedAt.toISOString() : null,
    // Per-layer status + last_error envelope. Snake_case
    // matches the wire and the JSONB column shape; the UI layer
    // converts to camelCase at the React Query boundary.
    extraction_status: row.extractionStatus,
    semantic_index_status: row.semanticIndexStatus,
    last_error: sanitizeLastErrorForWire(row.lastError),
    // Additive link to the row's paired `storage_artifacts` entry.
    // NULL for pointer-only registration stubs and older rows.
    // The existing `raw_storage_status`/`storage_provider`/
    // `raw_storage_metadata`/`delete_semantics` fields stay
    // populated unchanged; artifact-native data can be read from the
    // storage API.
    storage_artifact_id: row.storageArtifactId,
  };
}

export function formatRegisterDocumentResponse(
  result: { document: RawDocumentRow; created: boolean },
  registry: RawContentStoreRegistry,
): Record<string, unknown> {
  return {
    document: formatRawDocument(result.document, registry),
    created: result.created,
  };
}

export function formatListDocumentsResponse(
  documents: RawDocumentRow[],
  registry: RawContentStoreRegistry,
): Record<string, unknown> {
  return {
    documents: documents.map((d) => formatRawDocument(d, registry)),
    count: documents.length,
  };
}

/**
 * Cursor-paginated document list. Mirrors
 * `DocumentListRootResponseSchema` in `schemas/responses.ts`.
 */
export function formatDocumentListRootResponse(
  result: { documents: RawDocumentRow[]; nextCursor: string | null },
  registry: RawContentStoreRegistry,
): Record<string, unknown> {
  return {
    documents: result.documents.map((d) => formatRawDocument(d, registry)),
    next_cursor: result.nextCursor,
  };
}

/**
 * Public passport-feed row formatter. Strips internal
 * fields the repository never returns; renames camelCase to
 * snake_case for the wire; ISO-encodes timestamp instances. The
 * discriminated union on `kind` is preserved verbatim so consumers
 * branch on it.
 */
function formatPassportFeedRow(
  row: PassportFeedRow,
  registry: RawContentStoreRegistry,
): Record<string, unknown> {
  if (row.kind === 'document_grouped') {
    return formatPassportFeedGroupedRow(row, registry);
  }
  return formatPassportFeedStandaloneRow(row);
}

function formatPassportFeedGroupedRow(
  row: Extract<PassportFeedRow, { kind: 'document_grouped' }>,
  registry: RawContentStoreRegistry,
): Record<string, unknown> {
  return {
    kind: 'document_grouped',
    document_id: row.documentId,
    sort_at: isoOf(row.sortAt),
    sort_id: row.sortId,
    representative: {
      id: row.representative.id,
      content: row.representative.content,
      created_at: isoOf(row.representative.createdAt),
      source_site: row.representative.sourceSite,
    },
    chunk_count: row.chunkCount,
    raw_storage_status: row.rawStorageStatus,
    extraction_status: row.extractionStatus,
    semantic_index_status: row.semanticIndexStatus,
    last_error: sanitizeLastErrorForWire(row.lastError),
    display_name: row.displayName,
    mime_type: row.mimeType,
    // Grouped rows carry the row-specific `storage_provider` +
    // public-allowlisted `raw_storage_metadata` + per-row
    // `delete_semantics`. Standalone-memory rows stay status-only
    // because they have no backing document.
    storage_provider: row.storageProvider,
    raw_storage_metadata: formatPublicRawStorageMetadata(row.rawStorageMetadata),
    delete_semantics: getDeleteSemantics(registry, row.storageProvider),
  };
}

function formatPassportFeedStandaloneRow(
  row: Extract<PassportFeedRow, { kind: 'standalone_memory' }>,
): Record<string, unknown> {
  return {
    kind: 'standalone_memory',
    sort_at: isoOf(row.sortAt),
    sort_id: row.sortId,
    memory: {
      id: row.memory.id,
      content: row.memory.content,
      created_at: isoOf(row.memory.createdAt),
      source_site: row.memory.sourceSite,
    },
  };
}

/**
 * Passport-feed envelope formatter. Maps the discriminated
 * repository result to the public snake_case wire shape.
 */
export function formatPassportFeedResponse(
  result: ListPassportFeedResult,
  registry: RawContentStoreRegistry,
): Record<string, unknown> {
  return {
    rows: result.rows.map((r) => formatPassportFeedRow(r, registry)),
    next_cursor: result.nextCursor,
  };
}

function isoOf(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

/**
 * Strip server-only keys (currently `internal_recovery_hint`) from
 * the `last_error` envelope before it leaves the trust boundary.
 *
 * The `runPhaseBeta2` orphan-recovery path embeds the failed
 * `store.delete` URI + provider under `internal_recovery_hint` so
 * a reconciler / ops can find abandoned bytes — but those values
 * (especially the storage URI) reveal internal storage layout
 * and must not surface on the public API. Add new
 * `internal_*` keys to the deny-list here as they appear.
 */
function sanitizeLastErrorForWire(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (key.startsWith('internal_')) continue;
    out[key] = val;
  }
  return out;
}

export function formatDeleteDocumentResponse(
  result: { success: true; alreadyDeleted: boolean },
): Record<string, unknown> {
  return {
    success: true,
    already_deleted: result.alreadyDeleted,
  };
}

export function formatUploadRawDocumentResponse(
  result: {
    documentId: string;
    storageProvider: string;
    storageUri: string;
    contentHash: string;
    sizeBytes: number;
    // Filecoin's `stored.status='stored'`
    // resolves to `blob_available` (gateway-confirmed retrievable)
    // via `deriveFinalRawStorageStatus`; immediate providers stay
    // `blob_stored`; `pending` provider acceptances land
    // `blob_pending` for the reconciler to promote.
    rawStorageStatus: 'blob_stored' | 'blob_pending' | 'blob_available';
    storageMode: 'managed_blob';
    /**
     * INTERNAL metadata shape `{ codec, filecoin?, upload_result }`
     * — the wire response strips `upload_result` and AES-GCM
     * internals via `formatPublicRawStorageMetadata`. The Filecoin
     * sidecar is projected through the shared
     * `projectFilecoinPublicMetadata` helper into the Synapse-backed
     * public shape (`copy_count` / `provider_ids` / `copy_statuses`).
     */
    rawStorageMetadata: Record<string, unknown>;
    idempotentSkip: boolean;
  },
  registry: RawContentStoreRegistry,
): Record<string, unknown> {
  return {
    document_id: result.documentId,
    storage_provider: result.storageProvider,
    storage_uri: result.storageUri,
    content_hash: result.contentHash,
    size_bytes: result.sizeBytes,
    raw_storage_status: result.rawStorageStatus,
    storage_mode: result.storageMode,
    raw_storage_metadata: formatPublicRawStorageMetadata(result.rawStorageMetadata),
    // Per-row capability advertisement (same as `formatRawDocument`).
    // Resolved from the upload's
    // `storageProvider` so a Filecoin upload emits
    // `delete_semantics: 'tombstone'` end-to-end even when the
    // deployment also has legacy local_fs adapters registered.
    delete_semantics: getDeleteSemantics(registry, result.storageProvider),
    idempotent_skip: result.idempotentSkip,
  };
}

export function formatIndexDocumentResponse(
  result: {
    documentId: string;
    indexedContentHash: string;
    chunksCreated: number;
    memoriesCreated: number;
    idempotentSkip: boolean;
    chunkerVersion: string;
    parserVersion: string;
  },
): Record<string, unknown> {
  return {
    document_id: result.documentId,
    indexed_content_hash: result.indexedContentHash,
    chunks_created: result.chunksCreated,
    memories_created: result.memoriesCreated,
    idempotent_skip: result.idempotentSkip,
    chunker_version: result.chunkerVersion,
    parser_version: result.parserVersion,
  };
}

export function formatDocumentFailureMarkerResponse(
  result: { document: RawDocumentRow; idempotent: boolean },
  registry: RawContentStoreRegistry,
): Record<string, unknown> {
  return {
    document: formatRawDocument(result.document, registry),
    idempotent: result.idempotent,
  };
}

/**
 * Filecoin lifecycle refactor (Slice 4): `capabilities` is the
 * internal camelCase shape `RawContentStore.capabilities`
 * advertises. The snapshot composition root (`create-app.ts`)
 * sources it from the active store; this formatter is the ONLY
 * place that flips the four capability keys
 * (`addressing`, `retrievalConsistency`, `deleteSemantics`,
 * `supportsHead`, `supportsGet`) to their snake_case wire form.
 * Internal code MUST NOT receive the snake_case names; wire code
 * MUST NOT see the camelCase names.
 *
 * `provider` echoes `RawContentStore.provider` (`local_fs`, `s3`,
 * `filecoin`, ...). Omitted alongside `capabilities` when
 * `mode = 'pointer_only'` (no store).
 */
export interface DocumentLimitsSnapshot {
  rawUploadMaxBytes: number;
  indexMaxTextBytes: number;
  rawStorage: {
    enabled: boolean;
    mode: 'pointer_only' | 'managed_blob';
    reason?: string;
    provider?: string;
    capabilities?: {
      addressing: 'location' | 'content';
      retrievalConsistency: 'immediate' | 'eventual';
      deleteSemantics: 'delete' | 'unpin' | 'tombstone';
      supportsHead: boolean;
      supportsGet: boolean;
    };
  };
}

export function formatDocumentLimitsResponse(
  snapshot: DocumentLimitsSnapshot,
): Record<string, unknown> {
  const rawStorage: Record<string, unknown> = {
    enabled: snapshot.rawStorage.enabled,
    mode: snapshot.rawStorage.mode,
  };
  if (snapshot.rawStorage.reason !== undefined) {
    rawStorage.reason = snapshot.rawStorage.reason;
  }
  if (snapshot.rawStorage.provider !== undefined) {
    rawStorage.provider = snapshot.rawStorage.provider;
  }
  if (snapshot.rawStorage.capabilities !== undefined) {
    const c = snapshot.rawStorage.capabilities;
    rawStorage.addressing = c.addressing;
    rawStorage.retrieval_consistency = c.retrievalConsistency;
    rawStorage.delete_semantics = c.deleteSemantics;
    rawStorage.supports_head = c.supportsHead;
    rawStorage.supports_get = c.supportsGet;
  }
  return {
    raw_upload_max_bytes: snapshot.rawUploadMaxBytes,
    index_max_text_bytes: snapshot.indexMaxTextBytes,
    raw_storage: rawStorage,
  };
}
