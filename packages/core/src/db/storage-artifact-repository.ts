/**
 * @file Postgres queries for the `storage_artifacts` table.
 *
 * Step 4 of the storage-sibling plan. Single DB seam for everything
 * artifact-shaped. No HTTP routes, no business logic, no response
 * formatters — those land in Step 5.
 *
 * Owner-scoping rule: every public method except `createStorageArtifact`
 * takes `userId` and routes it into the WHERE clause. Cross-user reads
 * and writes return `null` / zero / no rows; they never throw. The
 * route layer (Step 5) is responsible for translating that into the
 * correct 404 envelope.
 *
 * Internal columns:
 *   * `plaintext_hash` / `stored_hash` — visible on the repository's
 *     row type for diagnostic queries. The Step-5 response formatter
 *     is the only call site that decides whether to expose them on
 *     the wire (gated by `discloseContentHash`).
 *   * `last_error` — internal failure envelope; same story.
 *
 * The repo writes a closed set of `status` values:
 *
 *   stored | pending | available | unavailable | deleting | deleted
 *   | delete_failed | failed
 *
 * Mirrors the SDK's `StorageArtifactStatus` and is enforced by the
 * `storage_artifacts_status_check` constraint in `schema.sql`.
 */

import pg from 'pg';
import { randomUUID } from 'node:crypto';

/** Internal lifecycle state — closed enum mirrored from the SDK. */
export type StorageArtifactStatus =
  | 'stored'
  | 'pending'
  | 'available'
  | 'unavailable'
  | 'deleting'
  | 'deleted'
  | 'delete_failed'
  | 'failed';

export type StorageArtifactMode = 'pointer' | 'managed';
export type StorageContentEncoding = 'identity' | 'aes_gcm';

/**
 * Full column projection. Carries the internal-only columns
 * (`plaintext_hash`, `stored_hash`, `last_error`) — Step-5 wire
 * projection is responsible for redaction.
 */
export interface StorageArtifactRow {
  id: string;
  userId: string;
  orgId: string | null;
  projectId: string | null;
  provider: string;
  mode: StorageArtifactMode;
  /**
   * Adapter URI. NULL while a managed row is in `pending` (the
   * backend hasn't returned a URI yet) or `failed` (backend.put
   * threw). Always set on `pointer` rows and on managed rows that
   * reached `stored` / `available`.
   */
  uri: string | null;
  status: StorageArtifactStatus;
  sizeBytes: number | null;
  contentType: string | null;
  plaintextHash: string | null;
  storedHash: string | null;
  contentEncoding: StorageContentEncoding;
  discloseContentHash: boolean;
  identifiers: Record<string, unknown>;
  lifecycle: Record<string, unknown>;
  replication: Record<string, unknown> | null;
  verification: Record<string, unknown> | null;
  retrieval: Record<string, unknown> | null;
  providerDetails: Record<string, unknown> | null;
  metadata: Record<string, unknown>;
  lastError: Record<string, unknown> | null;
  /** CAS token for the upload pipeline (pending → stored / failed). */
  putAttemptId: string | null;
  deleteAttemptId: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface CreateStorageArtifactInput {
  userId: string;
  orgId?: string | null;
  projectId?: string | null;
  provider: string;
  mode: StorageArtifactMode;
  uri: string;
  status: StorageArtifactStatus;
  sizeBytes?: number | null;
  contentType?: string | null;
  plaintextHash?: string | null;
  storedHash?: string | null;
  contentEncoding?: StorageContentEncoding;
  discloseContentHash?: boolean;
  identifiers?: Record<string, unknown>;
  lifecycle?: Record<string, unknown>;
  replication?: Record<string, unknown> | null;
  verification?: Record<string, unknown> | null;
  retrieval?: Record<string, unknown> | null;
  providerDetails?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
}

export interface StorageArtifactListCursor {
  createdAt: string;
  id: string;
}

export interface ListArtifactsOptions {
  limit: number;
  cursor?: StorageArtifactListCursor;
}

export interface ListArtifactsResult {
  rows: StorageArtifactRow[];
  nextCursor: StorageArtifactListCursor | null;
}

export interface MarkDeleteSuccessInput {
  userId: string;
  id: string;
  claimId: string;
}

export interface MarkDeleteFailedInput {
  userId: string;
  id: string;
  claimId: string;
  lastError: Record<string, unknown>;
}

/** Closed allowlist of statuses that a fresh claim can transition from. */
const CLAIMABLE_FROM_STATUSES: readonly StorageArtifactStatus[] = [
  'stored',
  'pending',
  'available',
  'unavailable',
  'failed',
  'delete_failed',
];

const COLUMNS =
  'id, user_id, org_id, project_id, provider, mode, uri, status, ' +
  'size_bytes, content_type, plaintext_hash, stored_hash, content_encoding, ' +
  'disclose_content_hash, identifiers, lifecycle, replication, verification, ' +
  'retrieval, provider_details, metadata, last_error, ' +
  'put_attempt_id, delete_attempt_id, ' +
  'created_at, updated_at, deleted_at';

/**
 * Insert a new artifact row. Status, provider, and mode must already
 * be validated by the caller — the DB-level CHECKs are a backstop, not
 * a substitute for service-layer input validation.
 */
export async function createStorageArtifact(
  q: pg.Pool | pg.PoolClient,
  input: CreateStorageArtifactInput,
): Promise<StorageArtifactRow> {
  const result = await q.query(
    `INSERT INTO storage_artifacts (
       user_id, org_id, project_id, provider, mode, uri, status,
       size_bytes, content_type, plaintext_hash, stored_hash,
       content_encoding, disclose_content_hash,
       identifiers, lifecycle, replication, verification,
       retrieval, provider_details, metadata
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7,
       $8, $9, $10, $11,
       $12, $13,
       $14::jsonb, $15::jsonb, $16::jsonb, $17::jsonb,
       $18::jsonb, $19::jsonb, $20::jsonb
     )
     RETURNING ${COLUMNS}`,
    buildInsertParams(input),
  );
  return mapRow(result.rows[0]);
}

/**
 * Serialize a `CreateStorageArtifactInput` into the positional
 * parameter array `createStorageArtifact` passes to `pool.query`.
 * Extracted so the INSERT itself stays under the workspace
 * complexity ceiling; the `nullify` / `nullableJson` helpers keep
 * each column's null-collapse logic to a single path instead of
 * fanning out one ternary per nullable column.
 */
function buildInsertParams(input: CreateStorageArtifactInput): unknown[] {
  return [
    input.userId,
    nullify(input.orgId),
    nullify(input.projectId),
    input.provider,
    input.mode,
    input.uri,
    input.status,
    nullify(input.sizeBytes),
    nullify(input.contentType),
    nullify(input.plaintextHash),
    nullify(input.storedHash),
    input.contentEncoding ?? 'identity',
    input.discloseContentHash ?? false,
    JSON.stringify(input.identifiers ?? {}),
    JSON.stringify(input.lifecycle ?? {}),
    nullableJson(input.replication),
    nullableJson(input.verification),
    nullableJson(input.retrieval),
    nullableJson(input.providerDetails),
    JSON.stringify(input.metadata ?? {}),
  ];
}

/** Collapse `undefined` / `null` into `null` at the SQL boundary. */
function nullify<T>(value: T | null | undefined): T | null {
  return value ?? null;
}

/** `JSON.stringify` when present; pass-through `null` for absent inputs. */
function nullableJson(value: Record<string, unknown> | null | undefined): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

/**
 * Pending-row-first upload helpers — see
 * `StorageService.putManaged` for the full lifecycle. The flow:
 *
 *   1. `claimPendingArtifact` inserts `status='pending'`, `uri=NULL`,
 *      `put_attempt_id=<fresh uuid>`. Returns the row + claim id.
 *   2. Service calls `backend.put(...)` OUTSIDE the DB.
 *   3a. On success: `recordUploadedArtifact` CAS-flips the row to
 *       `status='stored'`, sets `uri` + hashes + size, clears
 *       `put_attempt_id`. Returns the updated row.
 *   3b. On `backend.put` failure: `markPutFailed` CAS-flips the row
 *       to `status='failed'`, records `last_error`, clears
 *       `put_attempt_id`.
 *   3c. On post-put DB failure: the service's recovery path runs
 *       backend cleanup and writes a durable failed marker on the
 *       row (`put_post_persist_failed_cleaned_up` envelope) so ops
 *       sees `status='failed'`. When cleanup also fails, a durable
 *       `put_post_persist_unrecoverable` envelope captures the
 *       orphan URI on `last_error` server-side so the reconciler
 *       can find and delete the abandoned bytes later. See
 *       `services/storage-put-recovery.ts` for the full branch tree.
 */

export interface ClaimPendingArtifactInput {
  userId: string;
  orgId?: string | null;
  projectId?: string | null;
  provider: string;
  contentType?: string | null;
  contentEncoding?: StorageContentEncoding;
  discloseContentHash?: boolean;
  metadata?: Record<string, unknown>;
}

export interface ClaimPendingArtifactResult {
  row: StorageArtifactRow;
  claimId: string;
}

/**
 * Insert a `status='pending'` managed artifact row with a fresh
 * `put_attempt_id`. The URI is NULL — set by `recordUploadedArtifact`
 * after the backend put succeeds.
 */
export async function claimPendingArtifact(
  q: pg.Pool | pg.PoolClient,
  input: ClaimPendingArtifactInput,
): Promise<ClaimPendingArtifactResult> {
  const claimId = randomUUID();
  const result = await q.query(
    `INSERT INTO storage_artifacts (
       user_id, org_id, project_id, provider, mode, uri, status,
       content_type, content_encoding, disclose_content_hash,
       identifiers, lifecycle, metadata, put_attempt_id
     ) VALUES (
       $1, $2, $3, $4, 'managed', NULL, 'pending',
       $5, $6, $7,
       '{}'::jsonb, '{}'::jsonb, $8::jsonb, $9::uuid
     )
     RETURNING ${COLUMNS}`,
    [
      input.userId,
      nullify(input.orgId),
      nullify(input.projectId),
      input.provider,
      nullify(input.contentType),
      input.contentEncoding ?? 'identity',
      input.discloseContentHash ?? false,
      JSON.stringify(input.metadata ?? {}),
      claimId,
    ],
  );
  return { row: mapRow(result.rows[0]), claimId };
}

export interface RecordUploadedArtifactInput {
  userId: string;
  artifactId: string;
  putAttemptId: string;
  uri: string;
  sizeBytes: number;
  plaintextHash: string;
  storedHash: string;
  identifiers?: Record<string, unknown>;
  providerDetails?: Record<string, unknown> | null;
}

/**
 * CAS-flip a pending row to `status='stored'`. Matches on
 * `(id, user_id, put_attempt_id, status='pending')` so a stale
 * caller cannot finalize someone else's claim. Returns the updated
 * row when the CAS succeeded; `null` when it lost the race.
 */
export async function recordUploadedArtifact(
  q: pg.Pool | pg.PoolClient,
  input: RecordUploadedArtifactInput,
): Promise<StorageArtifactRow | null> {
  const result = await q.query(
    `UPDATE storage_artifacts
       SET status = 'stored',
           uri = $4,
           size_bytes = $5,
           plaintext_hash = $6,
           stored_hash = $7,
           identifiers = $8::jsonb,
           provider_details = $9::jsonb,
           put_attempt_id = NULL,
           updated_at = NOW()
       WHERE id = $1
         AND user_id = $2
         AND put_attempt_id = $3
         AND status = 'pending'
       RETURNING ${COLUMNS}`,
    [
      input.artifactId,
      input.userId,
      input.putAttemptId,
      input.uri,
      input.sizeBytes,
      input.plaintextHash,
      input.storedHash,
      JSON.stringify(input.identifiers ?? {}),
      nullableJson(input.providerDetails),
    ],
  );
  if (result.rowCount === 0) return null;
  return mapRow(result.rows[0]);
}

export interface MarkPutFailedInput {
  userId: string;
  artifactId: string;
  putAttemptId: string;
  lastError: Record<string, unknown>;
}

/**
 * CAS-flip a pending row to `status='failed'` with the supplied
 * `last_error` envelope. Same CAS shape as `recordUploadedArtifact`.
 * Returns the failed row when the CAS succeeded; `null` when it
 * lost the race (claim already cleared by another caller).
 */
export async function markPutFailed(
  q: pg.Pool | pg.PoolClient,
  input: MarkPutFailedInput,
): Promise<StorageArtifactRow | null> {
  const result = await q.query(
    `UPDATE storage_artifacts
       SET status = 'failed',
           last_error = $4::jsonb,
           put_attempt_id = NULL,
           updated_at = NOW()
       WHERE id = $1
         AND user_id = $2
         AND put_attempt_id = $3
         AND status = 'pending'
       RETURNING ${COLUMNS}`,
    [input.artifactId, input.userId, input.putAttemptId, JSON.stringify(input.lastError)],
  );
  if (result.rowCount === 0) return null;
  return mapRow(result.rows[0]);
}

/** Owner-scoped lookup. Returns `null` for cross-user / missing / deleted rows. */
export async function getStorageArtifactById(
  pool: pg.Pool,
  userId: string,
  id: string,
): Promise<StorageArtifactRow | null> {
  const result = await pool.query(
    `SELECT ${COLUMNS} FROM storage_artifacts
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
    [id, userId],
  );
  if (result.rowCount === 0) return null;
  return mapRow(result.rows[0]);
}

/**
 * Owner-scoped lookup that DOES return soft-deleted rows. Used by
 * the delete-policy state machine so a second `DELETE` on an
 * already-deleted artifact can return the prior terminal envelope
 * (the plan's idempotency contract) instead of a 404.
 */
export async function getStorageArtifactByIdIncludingDeleted(
  pool: pg.Pool,
  userId: string,
  id: string,
): Promise<StorageArtifactRow | null> {
  const result = await pool.query(
    `SELECT ${COLUMNS} FROM storage_artifacts
       WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  if (result.rowCount === 0) return null;
  return mapRow(result.rows[0]);
}

/**
 * Mark an artifact `status='deleted'` + stamp `deleted_at`. Used by
 * Step 7's document-ingestion refactor when a managed upload
 * replaces a previously-linked pointer artifact (or when a managed
 * artifact's bytes are cleaned up post-document-delete). Owner-
 * scoped + idempotent: a row that is already `deleted` stays so.
 *
 * Distinct from `markDeleteSuccess` because there is no claim id
 * to CAS on — the caller has already confirmed the row should be
 * tombstoned (e.g. the upload service holds the document-row
 * advisory lock).
 */
export async function softDeleteArtifactByIdWithClient(
  q: pg.Pool | pg.PoolClient,
  userId: string,
  id: string,
): Promise<void> {
  await q.query(
    `UPDATE storage_artifacts
       SET status = 'deleted',
           deleted_at = COALESCE(deleted_at, NOW()),
           delete_attempt_id = NULL,
           updated_at = NOW()
       WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
}

/**
 * Count active `raw_documents` rows that reference this artifact for
 * the supplied owner. The Step-5 delete route uses this to enforce
 * the `artifact_in_use` 409 envelope when callers omit
 * `policy=with_documents`.
 *
 * Owner-scope invariant: the count includes a row only when BOTH the
 * artifact and the referencing document belong to `$userId`. The
 * schema-level composite FK on `raw_documents(storage_artifact_id,
 * user_id) -> storage_artifacts(id, user_id)` makes the cross-user
 * row impossible, but this join restates the invariant explicitly so
 * the query is unambiguous against any DB that pre-dates the
 * composite FK.
 */
export async function countReferencingDocuments(
  pool: pg.Pool,
  userId: string,
  artifactId: string,
): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM raw_documents AS rd
       INNER JOIN storage_artifacts AS sa
         ON sa.id = rd.storage_artifact_id
       WHERE sa.id = $1
         AND sa.user_id = $2
         AND sa.deleted_at IS NULL
         AND rd.user_id = $2
         AND rd.deleted_at IS NULL`,
    [artifactId, userId],
  );
  return Number(result.rows[0].count);
}

/**
 * Return the ids of active `raw_documents` rows that reference this
 * artifact for the supplied owner. Same owner-scope invariant as
 * `countReferencingDocuments`. Used by the delete `with_documents`
 * cascade path so the service can soft-delete each referencing
 * document before flipping the artifact's status.
 */
export async function listReferencingDocumentIds(
  pool: pg.Pool,
  userId: string,
  artifactId: string,
): Promise<string[]> {
  const result = await pool.query<{ id: string }>(
    `SELECT rd.id
       FROM raw_documents AS rd
       INNER JOIN storage_artifacts AS sa
         ON sa.id = rd.storage_artifact_id
       WHERE sa.id = $1
         AND sa.user_id = $2
         AND sa.deleted_at IS NULL
         AND rd.user_id = $2
         AND rd.deleted_at IS NULL`,
    [artifactId, userId],
  );
  return result.rows.map((r) => r.id);
}

/**
 * Atomically transition an artifact into `status='deleting'` and stamp
 * a fresh `delete_attempt_id`. Returns the new claim id on success,
 * `null` when the row is missing, cross-user, or already in a state
 * that forbids a new claim (`deleting` / `deleted`).
 *
 * `delete_failed` rows ARE re-claimable so the delete-retry path can
 * make forward progress; the plan defines the second `DELETE` on a
 * `delete_failed` row as a retry, not an error. The retry path also
 * clears the prior `last_error` so the in-flight artifact never
 * reports `status='deleting'` alongside a stale provider error — the
 * field is repopulated only if THIS attempt fails.
 */
export async function claimDeleteAttempt(
  pool: pg.Pool,
  userId: string,
  id: string,
): Promise<{ claimId: string } | null> {
  const claimId = randomUUID();
  const result = await pool.query<{ delete_attempt_id: string }>(
    `UPDATE storage_artifacts
       SET status = 'deleting',
           delete_attempt_id = $3,
           last_error = NULL,
           updated_at = NOW()
       WHERE id = $1
         AND user_id = $2
         AND deleted_at IS NULL
         AND status = ANY($4::text[])
       RETURNING delete_attempt_id`,
    [id, userId, claimId, CLAIMABLE_FROM_STATUSES],
  );
  if (result.rowCount === 0) return null;
  return { claimId: result.rows[0].delete_attempt_id };
}

/**
 * Finalize a successful delete. The row's `status` flips to `deleted`,
 * `deleted_at` is stamped, and the `delete_attempt_id` is cleared.
 * The CAS condition (matching claim id + current `status='deleting'`)
 * means a stale caller cannot finalize someone else's claim.
 *
 * Throws when no row matches — callers MUST hold a current claim.
 */
export async function markDeleteSuccess(
  q: pg.Pool | pg.PoolClient,
  args: MarkDeleteSuccessInput,
): Promise<StorageArtifactRow> {
  const result = await q.query(
    `UPDATE storage_artifacts
       SET status = 'deleted',
           deleted_at = NOW(),
           delete_attempt_id = NULL,
           last_error = NULL,
           updated_at = NOW()
       WHERE id = $1
         AND user_id = $2
         AND delete_attempt_id = $3
         AND status = 'deleting'
       RETURNING ${COLUMNS}`,
    [args.id, args.userId, args.claimId],
  );
  if (result.rowCount === 0) {
    throw new Error(
      `markDeleteSuccess: no matching claim (id=${args.id} claim=${args.claimId})`,
    );
  }
  return mapRow(result.rows[0]);
}

/**
 * Record a provider-cleanup failure. Same CAS guard as
 * `markDeleteSuccess`; `last_error` is replaced with the supplied
 * envelope so the caller can retry against a clean state. Status
 * lands on `delete_failed`, which is re-claimable by a subsequent
 * `claimDeleteAttempt`.
 */
export async function markDeleteFailed(
  q: pg.Pool | pg.PoolClient,
  args: MarkDeleteFailedInput,
): Promise<StorageArtifactRow> {
  const result = await q.query(
    `UPDATE storage_artifacts
       SET status = 'delete_failed',
           delete_attempt_id = NULL,
           last_error = $4::jsonb,
           updated_at = NOW()
       WHERE id = $1
         AND user_id = $2
         AND delete_attempt_id = $3
         AND status = 'deleting'
       RETURNING ${COLUMNS}`,
    [args.id, args.userId, args.claimId, JSON.stringify(args.lastError)],
  );
  if (result.rowCount === 0) {
    throw new Error(
      `markDeleteFailed: no matching claim (id=${args.id} claim=${args.claimId})`,
    );
  }
  return mapRow(result.rows[0]);
}

export interface ReleaseDeleteClaimInput {
  userId: string;
  id: string;
  claimId: string;
  /** Status the row must revert to (typically the pre-claim status). */
  restoreStatus: StorageArtifactStatus;
  /** `last_error` the row had before the claim cleared it. */
  restoreLastError: Record<string, unknown> | null;
}

/**
 * Release a `deleting` claim without finalizing. Used by the
 * delete-cascade race fix (Commit D): claim runs BEFORE the
 * reference-count gate so concurrent INSERTs cannot slip in a new
 * link, but if the gate then throws `ArtifactInUseError` we must
 * revert the row from `deleting` back to its pre-claim status
 * (and restore the pre-claim `last_error`, since `claimDeleteAttempt`
 * cleared it). CAS-scoped to the row's `(user_id, delete_attempt_id,
 * status='deleting')` so a stale caller cannot revert someone
 * else's claim. Returns true on a real revert, false on CAS miss
 * (e.g., concurrent recovery already finalized the row).
 */
export async function releaseDeleteClaim(
  pool: pg.Pool,
  args: ReleaseDeleteClaimInput,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE storage_artifacts
       SET status = $4,
           last_error = $5::jsonb,
           delete_attempt_id = NULL,
           updated_at = NOW()
       WHERE id = $1
         AND user_id = $2
         AND delete_attempt_id = $3
         AND status = 'deleting'`,
    [
      args.id, args.userId, args.claimId, args.restoreStatus,
      args.restoreLastError === null ? null : JSON.stringify(args.restoreLastError),
    ],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Closed set of statuses that refuse a new link to the artifact.
 * Used by `assertArtifactLinkable`. The only relink site today is
 * `swapToManagedArtifact` (which observes an existing prior
 * artifact); `registerWithPointerArtifact` ALWAYS creates a fresh
 * artifact in the same transaction and never re-links to an
 * existing row, so the guard is not load-bearing there. The check
 * stays callable from any future path that links to an existing
 * artifact.
 */
const UNLINKABLE_STATUSES: readonly StorageArtifactStatus[] = [
  'deleting',
  'deleted',
  'delete_failed',
];

/**
 * Sentinel thrown by `assertArtifactLinkable` when a caller tries
 * to link a `raw_documents.storage_artifact_id` to an artifact
 * that has already entered (or completed) its delete lifecycle.
 * The link-write sites surface this so a concurrent delete cannot
 * race with a fresh link and end up with a document pointing at
 * deleted content.
 */
export class ArtifactNotLinkableError extends Error {
  readonly artifactId: string;
  readonly status: StorageArtifactStatus;
  constructor(artifactId: string, status: StorageArtifactStatus) {
    super(
      `storage artifact ${artifactId} is not linkable (status='${status}'); ` +
        'delete has already started or completed',
    );
    this.name = 'ArtifactNotLinkableError';
    this.artifactId = artifactId;
    this.status = status;
  }
}

/**
 * Refuse to link a `raw_documents` row to an artifact whose status
 * is in `UNLINKABLE_STATUSES`. Throws `ArtifactNotLinkableError`
 * on a hit; no-ops otherwise. Takes a `PoolClient` so the caller
 * can scope the check to its own transaction.
 */
export async function assertArtifactLinkable(
  q: pg.Pool | pg.PoolClient,
  userId: string,
  artifactId: string,
): Promise<void> {
  const result = await q.query<{ status: StorageArtifactStatus }>(
    `SELECT status FROM storage_artifacts
       WHERE id = $1 AND user_id = $2`,
    [artifactId, userId],
  );
  if (result.rowCount === 0) return;
  const status = result.rows[0].status;
  if (UNLINKABLE_STATUSES.includes(status)) {
    throw new ArtifactNotLinkableError(artifactId, status);
  }
}

/**
 * List a user's artifacts in `(created_at DESC, id DESC)` order with
 * keyset pagination. The cursor encodes the last row of the previous
 * page; pass `undefined` for the first page. Returns `nextCursor=null`
 * when the caller has reached the end of the user's rows.
 *
 * Soft-deleted rows (`deleted_at IS NOT NULL`) are excluded from the
 * listing — the Step-5 list endpoint does NOT show tombstones by
 * default.
 */
export async function listArtifactsForUser(
  pool: pg.Pool,
  userId: string,
  opts: ListArtifactsOptions,
): Promise<ListArtifactsResult> {
  if (!Number.isInteger(opts.limit) || opts.limit <= 0) {
    throw new Error(`listArtifactsForUser: limit must be a positive integer (got ${opts.limit})`);
  }
  const cursorClause = opts.cursor
    ? 'AND (created_at, id) < ($2::timestamptz, $3::uuid)'
    : '';
  const params: unknown[] = [userId];
  if (opts.cursor) {
    params.push(opts.cursor.createdAt, opts.cursor.id);
  }
  params.push(opts.limit + 1);
  const limitPlaceholder = `$${params.length}`;
  const result = await pool.query(
    `SELECT ${COLUMNS} FROM storage_artifacts
       WHERE user_id = $1 AND deleted_at IS NULL ${cursorClause}
       ORDER BY created_at DESC, id DESC
       LIMIT ${limitPlaceholder}`,
    params,
  );
  const allRows = result.rows.map(mapRow);
  const rows = allRows.slice(0, opts.limit);
  const nextCursor =
    allRows.length > opts.limit && rows.length > 0
      ? { createdAt: rows[rows.length - 1].createdAt.toISOString(), id: rows[rows.length - 1].id }
      : null;
  return { rows, nextCursor };
}

interface StorageArtifactColumnRow {
  id: string;
  user_id: string;
  org_id: string | null;
  project_id: string | null;
  provider: string;
  mode: StorageArtifactMode;
  uri: string | null;
  status: StorageArtifactStatus;
  size_bytes: string | null;
  content_type: string | null;
  plaintext_hash: string | null;
  stored_hash: string | null;
  content_encoding: StorageContentEncoding;
  disclose_content_hash: boolean;
  identifiers: Record<string, unknown> | null;
  lifecycle: Record<string, unknown> | null;
  replication: Record<string, unknown> | null;
  verification: Record<string, unknown> | null;
  retrieval: Record<string, unknown> | null;
  provider_details: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  last_error: Record<string, unknown> | null;
  put_attempt_id: string | null;
  delete_attempt_id: string | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

function mapRow(row: StorageArtifactColumnRow): StorageArtifactRow {
  return {
    id: row.id,
    userId: row.user_id,
    orgId: row.org_id,
    projectId: row.project_id,
    provider: row.provider,
    mode: row.mode,
    uri: row.uri,
    status: row.status,
    sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
    contentType: row.content_type,
    plaintextHash: row.plaintext_hash,
    storedHash: row.stored_hash,
    contentEncoding: row.content_encoding,
    discloseContentHash: row.disclose_content_hash,
    identifiers: row.identifiers ?? {},
    lifecycle: row.lifecycle ?? {},
    replication: row.replication,
    verification: row.verification,
    retrieval: row.retrieval,
    providerDetails: row.provider_details,
    metadata: row.metadata ?? {},
    lastError: row.last_error,
    putAttemptId: row.put_attempt_id,
    deleteAttemptId: row.delete_attempt_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}
