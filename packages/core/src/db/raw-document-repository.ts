/**
 * Postgres queries for the document pipeline (Phase 1 — pointer-only).
 *
 * Function-style module mirroring `repository-write.ts`. The split
 * `*WithClient` variants exist so `deleteBySource` can include
 * document soft-deletion inside its existing transaction.
 *
 * Phase 1 contract: callers only ever pass `storageMode = 'pointer_only'`.
 * The CHECK constraint on `raw_documents.storage_mode` accepts
 * `managed_blob` and `inline_small_text` as well, but the service layer
 * rejects them until those phases land. No raw content is ever written
 * by this module — `storage_uri` and `storage_provider` are NEVER set
 * in Phase 1.
 */

import pg from 'pg';
import type {
  ListRawDocumentsInput,
  RawDocumentRow,
  RawSourceRow,
  RegisterRawDocumentInput,
  UpsertRawSourceInput,
} from './raw-document-types.js';
import { createStorageArtifact } from './storage-artifact-repository.js';
import { EXTERNAL_POINTER_PROVIDER } from './storage-artifact-providers.js';

const RAW_SOURCE_COLUMNS =
  'id, user_id, source_site, provider, account_id, storage_mode, retention_policy, consent_policy, created_at, updated_at';

/**
 * Full column set on `raw_documents`. Exported so the Phase D list /
 * recovery / passport-feed repositories (which moved to focused
 * modules to keep this file under the 400 LOC rule) can build their
 * SELECT lists from the same canonical source.
 */
export const RAW_DOCUMENT_COLUMNS =
  'id, user_id, raw_source_id, external_id, external_uri, display_name, mime_type, size_bytes, content_hash, provider_version, source_modified_at, storage_mode, storage_uri, storage_provider, registration_status, raw_storage_status, raw_storage_metadata, metadata, created_at, updated_at, deleted_at, indexed_content_hash, indexed_at, extraction_status, semantic_index_status, last_error, raw_storage_claim_id, raw_storage_claimed_at, raw_storage_last_checked_at, raw_storage_next_check_at, raw_storage_reconcile_attempts, raw_storage_pending_since, storage_artifact_id';

// ---------------------------------------------------------------------------
// raw_sources
// ---------------------------------------------------------------------------

/**
 * Idempotently insert (or update) a `raw_sources` row keyed on
 * `(user_id, source_site, provider, COALESCE(account_id, ''))`. Returns
 * the persisted row.
 *
 * On conflict the storage_mode + retention/consent policies are
 * **overwritten** with the input values — those describe the caller's
 * current intent, and silently keeping a stale policy on the existing
 * row would mask configuration drift.
 */
export async function upsertRawSource(
  pool: pg.Pool,
  input: UpsertRawSourceInput,
): Promise<RawSourceRow> {
  const accountId = input.accountId ?? null;
  const storageMode = input.storageMode ?? 'pointer_only';
  const retentionPolicy = input.retentionPolicy ?? {};
  const consentPolicy = input.consentPolicy ?? {};

  const result = await pool.query(
    `INSERT INTO raw_sources (user_id, source_site, provider, account_id, storage_mode, retention_policy, consent_policy)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)
     ON CONFLICT (user_id, source_site, provider, COALESCE(account_id, ''))
     DO UPDATE SET
       storage_mode = EXCLUDED.storage_mode,
       retention_policy = EXCLUDED.retention_policy,
       consent_policy = EXCLUDED.consent_policy,
       updated_at = NOW()
     RETURNING ${RAW_SOURCE_COLUMNS}`,
    [
      input.userId,
      input.sourceSite,
      input.provider,
      accountId,
      storageMode,
      JSON.stringify(retentionPolicy),
      JSON.stringify(consentPolicy),
    ],
  );
  return rowToRawSource(result.rows[0]);
}

// ---------------------------------------------------------------------------
// raw_documents
// ---------------------------------------------------------------------------

/**
 * Idempotently register a `raw_documents` row. Returns
 * `{ document, created: true }` when a fresh row was inserted, or
 * `{ document, created: false }` when an active row already existed
 * (matched on `idx_raw_documents_active_unique`).
 *
 * Implemented as a single atomic `INSERT ... ON CONFLICT DO NOTHING
 * RETURNING ...` followed by a fallback SELECT when no row was
 * inserted. Two concurrent calls for the same namespace see exactly
 * one INSERT win and one fallback SELECT — neither caller observes
 * the unique-violation error that the previous find-then-insert
 * pattern could surface.
 *
 * Soft-deleted rows are excluded by the partial unique index, so a
 * re-registration after `softDeleteRawDocument` always inserts a new id.
 */
export async function registerRawDocument(
  pool: pg.Pool,
  input: RegisterRawDocumentInput,
): Promise<{ document: RawDocumentRow; created: boolean }> {
  // Step 7 of the storage-sibling plan: when the caller supplies an
  // `external_uri`, this insert ALSO writes a paired pointer-mode
  // `storage_artifacts` row and links `raw_documents.storage_artifact_id`
  // in the same transaction. Documents registered without an
  // `external_uri` remain pure registration stubs (NULL link). A
  // later managed upload (Phase β2 in `document-upload.ts`) is the
  // first place the row gets a managed artifact.
  if (input.externalUri) return registerWithPointerArtifact(pool, input);
  return registerWithoutArtifact(pool, input);
}

async function registerWithoutArtifact(
  pool: pg.Pool,
  input: RegisterRawDocumentInput,
): Promise<{ document: RawDocumentRow; created: boolean }> {
  const inserted = await tryInsertRawDocument(pool, input);
  if (inserted) return { document: inserted, created: true };
  const existing = await findActiveDocumentRow(pool, input);
  if (existing) return { document: existing, created: false };
  throw new Error('raw_documents: concurrent soft-delete observed during registration');
}

/**
 * Registration that pairs the new document with a pointer-mode
 * `storage_artifacts` row in one transaction. On idempotent re-
 * registration (the partial-unique index already has an active row),
 * the caller's external_uri is ignored and the existing artifact
 * link is preserved.
 */
async function registerWithPointerArtifact(
  pool: pg.Pool,
  input: RegisterRawDocumentInput,
): Promise<{ document: RawDocumentRow; created: boolean }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await tryInsertRawDocumentWithClient(client, input);
    if (inserted === null) {
      await client.query('COMMIT');
      const existing = await findActiveDocumentRow(pool, input);
      if (existing) return { document: existing, created: false };
      throw new Error('raw_documents: concurrent soft-delete observed during registration');
    }
    const artifact = await createStorageArtifact(client, {
      userId: input.userId,
      provider: EXTERNAL_POINTER_PROVIDER,
      mode: 'pointer',
      uri: input.externalUri!,
      status: 'stored',
      sizeBytes: input.sizeBytes ?? null,
      contentType: input.mimeType ?? null,
      contentEncoding: 'identity',
      discloseContentHash: false,
      identifiers: input.contentHash ? { contentHash: input.contentHash } : {},
      metadata: {},
    });
    const linked = await client.query(
      `UPDATE raw_documents SET storage_artifact_id = $1, updated_at = NOW()
         WHERE id = $2 RETURNING ${RAW_DOCUMENT_COLUMNS}`,
      [artifact.id, inserted.id],
    );
    await client.query('COMMIT');
    return { document: rowToRawDocument(linked.rows[0]), created: true };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

const INSERT_RAW_DOCUMENT_COLUMNS =
  'user_id, raw_source_id, external_id, external_uri, display_name, mime_type, size_bytes, content_hash, provider_version, source_modified_at, storage_mode, metadata, extraction_status, semantic_index_status';

const INSERT_RAW_DOCUMENT_PLACEHOLDERS =
  '$1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14';

/**
 * Treat `undefined` as `null` at the wire-to-SQL boundary. Tiny helper so
 * the param builder doesn't fan out one `?? null` branch per nullable
 * column — keeping the builder's cyclomatic complexity at one path.
 */
function nullify<T>(value: T | null | undefined): T | null {
  return value ?? null;
}

function buildInsertRawDocumentParams(input: RegisterRawDocumentInput): unknown[] {
  return [
    input.userId,
    input.rawSourceId,
    input.externalId,
    nullify(input.externalUri),
    nullify(input.displayName),
    nullify(input.mimeType),
    nullify(input.sizeBytes),
    nullify(input.contentHash),
    nullify(input.providerVersion),
    nullify(input.sourceModifiedAt),
    input.storageMode ?? 'pointer_only',
    JSON.stringify(input.metadata ?? {}),
    // Phase B — restricted-initial-state writes. Default
    // `'not_required'` matches the column default; clients that opt
    // into the document pipeline pass `'pending'` (see
    // `RegisterDocumentBodySchema` for the wire-side guard).
    input.extractionStatus ?? 'not_required',
    input.semanticIndexStatus ?? 'not_required',
  ];
}

/**
 * Atomic INSERT on the active-unique partial index. Returns the
 * persisted row when this call won the insert; null when an active
 * row already exists (a concurrent caller, or this was a re-register
 * with the same namespace).
 */
async function tryInsertRawDocument(
  pool: pg.Pool,
  input: RegisterRawDocumentInput,
): Promise<RawDocumentRow | null> {
  return tryInsertRawDocumentWithClient(pool, input);
}

async function tryInsertRawDocumentWithClient(
  q: pg.Pool | pg.PoolClient,
  input: RegisterRawDocumentInput,
): Promise<RawDocumentRow | null> {
  const result = await q.query(
    `INSERT INTO raw_documents (${INSERT_RAW_DOCUMENT_COLUMNS})
     VALUES (${INSERT_RAW_DOCUMENT_PLACEHOLDERS})
     ON CONFLICT (user_id, raw_source_id, external_id, COALESCE(provider_version, ''))
     WHERE deleted_at IS NULL DO NOTHING
     RETURNING ${RAW_DOCUMENT_COLUMNS}`,
    buildInsertRawDocumentParams(input),
  );
  if (result.rows.length === 0) return null;
  return rowToRawDocument(result.rows[0]);
}

async function findActiveDocumentRow(
  pool: pg.Pool,
  input: RegisterRawDocumentInput,
): Promise<RawDocumentRow | null> {
  const result = await pool.query(
    `SELECT ${RAW_DOCUMENT_COLUMNS}
       FROM raw_documents
      WHERE user_id = $1
        AND raw_source_id = $2
        AND external_id = $3
        AND COALESCE(provider_version, '') = COALESCE($4, '')
        AND deleted_at IS NULL`,
    [input.userId, input.rawSourceId, input.externalId, input.providerVersion ?? null],
  );
  if (result.rows.length === 0) return null;
  return rowToRawDocument(result.rows[0]);
}

/**
 * Fetch one active document by id, scoped to a user. Returns null when
 * the row is missing, deleted, or owned by a different user.
 */
export async function getRawDocumentById(
  q: pg.Pool | pg.PoolClient,
  userId: string,
  id: string,
): Promise<RawDocumentRow | null> {
  const result = await q.query(
    `SELECT ${RAW_DOCUMENT_COLUMNS}
       FROM raw_documents
      WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
    [id, userId],
  );
  if (result.rows.length === 0) return null;
  return rowToRawDocument(result.rows[0]);
}

/**
 * List active documents for a user, optionally filtered by source_site.
 * Limit is clamped to [1, 100]; offset is non-negative.
 */
export async function listRawDocuments(
  pool: pg.Pool,
  input: ListRawDocumentsInput,
): Promise<RawDocumentRow[]> {
  const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 20)));
  const offset = Math.max(0, Math.floor(input.offset ?? 0));
  const params: unknown[] = [input.userId, limit, offset];
  let where = `d.user_id = $1 AND d.deleted_at IS NULL`;
  if (input.sourceSite) {
    params.push(input.sourceSite);
    where += ` AND s.source_site = $${params.length}`;
  }
  const result = await pool.query(
    `SELECT ${RAW_DOCUMENT_COLUMNS.split(', ').map(c => `d.${c}`).join(', ')}
       FROM raw_documents d
       JOIN raw_sources s ON s.id = d.raw_source_id
      WHERE ${where}
      ORDER BY d.created_at DESC
      LIMIT $2 OFFSET $3`,
    params,
  );
  return result.rows.map(rowToRawDocument);
}

/**
 * Soft-delete one document by id, scoped to a user. Returns true when
 * a row transitioned from active to deleted; false when the row was
 * missing, already deleted, or owned by a different user.
 */
export async function softDeleteRawDocument(
  q: pg.Pool | pg.PoolClient,
  userId: string,
  id: string,
): Promise<boolean> {
  const result = await q.query(
    `UPDATE raw_documents
        SET deleted_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
    [id, userId],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Fetch one active document together with its parent source's
 * `source_site`. The Phase 2 indexer uses `source_site` to populate the
 * `memories.source_site` column on derived memories without needing a
 * second round-trip.
 */
export async function getDocumentWithSourceSite(
  q: pg.Pool | pg.PoolClient,
  userId: string,
  id: string,
): Promise<{ document: RawDocumentRow; sourceSite: string } | null> {
  const result = await q.query(
    `SELECT ${RAW_DOCUMENT_COLUMNS.split(', ').map((c) => `d.${c}`).join(', ')}, s.source_site
       FROM raw_documents d
       JOIN raw_sources s ON s.id = d.raw_source_id
      WHERE d.id = $1 AND d.user_id = $2 AND d.deleted_at IS NULL`,
    [id, userId],
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    document: rowToRawDocument(row),
    sourceSite: row.source_site as string,
  };
}

/**
 * Update the indexed-text fingerprint on an active document. Called by
 * the Phase 2 indexer on a successful re-chunk pass so subsequent index
 * calls can short-circuit on byte-identical input.
 *
 * Writes only `indexed_content_hash` + `indexed_at` (and `updated_at`).
 * `content_hash` is reserved for the upstream/provider raw-content
 * fingerprint and must not be touched by the indexer.
 */
export async function setRawDocumentIndexedHashWithClient(
  client: pg.PoolClient | pg.Pool,
  userId: string,
  id: string,
  indexedContentHash: string,
): Promise<void> {
  await client.query(
    `UPDATE raw_documents
        SET indexed_content_hash = $1,
            indexed_at = NOW(),
            updated_at = NOW()
      WHERE id = $2 AND user_id = $3 AND deleted_at IS NULL`,
    [indexedContentHash, id, userId],
  );
}

/**
 * Soft-delete every active document whose source_site matches.
 * Joins through `raw_sources` so callers don't need to know
 * `raw_source_id`. Used by `deleteBySource` to keep document deletion
 * inside the same transactional reset.
 */
export async function deleteDocumentsBySourceWithClient(
  client: pg.PoolClient,
  userId: string,
  sourceSite: string,
): Promise<number> {
  const result = await client.query(
    `UPDATE raw_documents d
        SET deleted_at = NOW(), updated_at = NOW()
       FROM raw_sources s
      WHERE d.raw_source_id = s.id
        AND d.user_id = $1
        AND s.source_site = $2
        AND d.deleted_at IS NULL`,
    [userId, sourceSite],
  );
  return result.rowCount ?? 0;
}

// ---------------------------------------------------------------------------
// Row mappers — accept the snake_case shape Postgres returns and emit
// the camelCase TypeScript types the rest of the codebase consumes.
// ---------------------------------------------------------------------------

function rowToRawSource(row: Record<string, unknown>): RawSourceRow {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    sourceSite: row.source_site as string,
    provider: row.provider as string,
    accountId: (row.account_id as string | null) ?? null,
    storageMode: row.storage_mode as RawSourceRow['storageMode'],
    retentionPolicy: (row.retention_policy as Record<string, unknown>) ?? {},
    consentPolicy: (row.consent_policy as Record<string, unknown>) ?? {},
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

function nullableString(value: unknown): string | null {
  return (value as string | null) ?? null;
}

function nullableDate(value: unknown): Date | null {
  return (value as Date | null) ?? null;
}

function nullableBigInt(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

/** Identifying fields shared by every active raw_documents row. */
function rowToRawDocumentIdentity(row: Record<string, unknown>) {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    rawSourceId: row.raw_source_id as string,
    externalId: row.external_id as string,
  };
}

/** Provider/source-side metadata fields. */
function rowToRawDocumentSourceMeta(row: Record<string, unknown>) {
  return {
    externalUri: nullableString(row.external_uri),
    displayName: nullableString(row.display_name),
    mimeType: nullableString(row.mime_type),
    sizeBytes: nullableBigInt(row.size_bytes),
    contentHash: nullableString(row.content_hash),
    providerVersion: nullableString(row.provider_version),
    sourceModifiedAt: nullableDate(row.source_modified_at),
  };
}

/** Storage + lifecycle status fields. */
function rowToRawDocumentStatus(row: Record<string, unknown>) {
  return {
    storageMode: row.storage_mode as RawDocumentRow['storageMode'],
    storageUri: nullableString(row.storage_uri),
    storageProvider: nullableString(row.storage_provider),
    registrationStatus: row.registration_status as RawDocumentRow['registrationStatus'],
    rawStorageStatus: row.raw_storage_status as RawDocumentRow['rawStorageStatus'],
    rawStorageMetadata:
      (row.raw_storage_metadata as Record<string, unknown> | null) ?? {},
  };
}

/**
 * Phase 5 / Phase 6 private worker columns. Read into RawDocumentRow
 * so the upload service and the reconciler can drive their state
 * machines off typed fields; never projected to the wire.
 */
function rowToRawDocumentWorkerState(row: Record<string, unknown>) {
  return {
    rawStorageClaimId: nullableString(row.raw_storage_claim_id),
    rawStorageClaimedAt: nullableDate(row.raw_storage_claimed_at),
    rawStorageLastCheckedAt: nullableDate(row.raw_storage_last_checked_at),
    rawStorageNextCheckAt: nullableDate(row.raw_storage_next_check_at),
    rawStorageReconcileAttempts:
      typeof row.raw_storage_reconcile_attempts === 'number'
        ? row.raw_storage_reconcile_attempts
        : 0,
    rawStoragePendingSince: nullableDate(row.raw_storage_pending_since),
  };
}

/** Phase B — per-layer status fields + last_error envelope. */
function rowToRawDocumentLayerStatus(row: Record<string, unknown>) {
  return {
    extractionStatus: row.extraction_status as RawDocumentRow['extractionStatus'],
    semanticIndexStatus: row.semantic_index_status as RawDocumentRow['semanticIndexStatus'],
    lastError: (row.last_error as RawDocumentRow['lastError']) ?? null,
  };
}

/**
 * Map a flat Postgres row into the typed `RawDocumentRow` shape.
 * Exported so the Phase D list / recovery / passport-feed
 * repositories can reuse it without re-implementing the column-by-
 * column projection.
 */
export function rowToRawDocument(row: Record<string, unknown>): RawDocumentRow {
  return {
    ...rowToRawDocumentIdentity(row),
    ...rowToRawDocumentSourceMeta(row),
    ...rowToRawDocumentStatus(row),
    ...rowToRawDocumentLayerStatus(row),
    ...rowToRawDocumentWorkerState(row),
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
    deletedAt: nullableDate(row.deleted_at),
    indexedContentHash: nullableString(row.indexed_content_hash),
    indexedAt: nullableDate(row.indexed_at),
    storageArtifactId: nullableString(row.storage_artifact_id),
  };
}
