/**
 * Repository-level integration tests for `storage_artifacts`.
 *
 * Exercises the Step-4 persistence seam against a real Postgres test
 * database. Covers owner scoping, the FK-based reference count from
 * `raw_documents.storage_artifact_id`, the idempotent delete-claim
 * state machine, status transitions on success/failure, and basic
 * cursor pagination.
 *
 * Requires DATABASE_URL in .env.test.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearDocumentTables, setupTestSchema } from './test-fixtures.js';
import { pool } from '../pool.js';
import {
  claimDeleteAttempt,
  countReferencingDocuments,
  createStorageArtifact,
  getStorageArtifactById,
  listArtifactsForUser,
  markDeleteFailed,
  markDeleteSuccess,
  type CreateStorageArtifactInput,
  type StorageArtifactRow,
} from '../storage-artifact-repository.js';
import { upsertRawSource, registerRawDocument } from '../raw-document-repository.js';

const USER_A = 'storage-repo-user-a';
const USER_B = 'storage-repo-user-b';

function pointerInput(
  overrides: Partial<CreateStorageArtifactInput> = {},
): CreateStorageArtifactInput {
  return {
    userId: USER_A,
    provider: 'local_fs',
    mode: 'pointer',
    uri: 'https://example.com/doc.pdf',
    status: 'stored',
    contentType: 'application/pdf',
    ...overrides,
  };
}

async function createArtifact(
  overrides: Partial<CreateStorageArtifactInput> = {},
): Promise<StorageArtifactRow> {
  return createStorageArtifact(pool, pointerInput(overrides));
}

async function createLinkedDocument(args: {
  userId: string;
  storageArtifactId: string;
  externalId: string;
}): Promise<void> {
  const source = await upsertRawSource(pool, {
    userId: args.userId,
    sourceSite: 'drive',
    provider: 'google-drive',
  });
  const registered = await registerRawDocument(pool, {
    userId: args.userId,
    rawSourceId: source.id,
    externalId: args.externalId,
    storageMode: 'pointer_only',
    externalUri: 'https://example.com/doc.pdf',
  });
  await pool.query(
    `UPDATE raw_documents SET storage_artifact_id = $1 WHERE id = $2`,
    [args.storageArtifactId, registered.document.id],
  );
}

async function expectClaimable(id: string): Promise<string> {
  const claim = await claimDeleteAttempt(pool, USER_A, id);
  expect(claim).not.toBeNull();
  return claim!.claimId;
}

describe('storage-artifact repository', () => {
  beforeAll(async () => {
    await setupTestSchema(pool);
  });

  beforeEach(async () => {
    await clearDocumentTables(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('createStorageArtifact persists the row and getStorageArtifactById returns it for the owner', async () => {
    const created = await createArtifact({
      identifiers: { ipfsCid: 'baf' },
      metadata: { source: 'drive', filename: 'a.pdf' },
    });
    const fetched = await getStorageArtifactById(pool, USER_A, created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(created.id);
    expect(fetched!.provider).toBe('local_fs');
    expect(fetched!.mode).toBe('pointer');
    expect(fetched!.identifiers).toEqual({ ipfsCid: 'baf' });
    expect(fetched!.metadata).toEqual({ source: 'drive', filename: 'a.pdf' });
  });

  it('getStorageArtifactById returns null for a different user (cross-user isolation)', async () => {
    const created = await createArtifact({ userId: USER_A });
    const fetchedAsB = await getStorageArtifactById(pool, USER_B, created.id);
    expect(fetchedAsB).toBeNull();
  });

  it('countReferencingDocuments returns the count of active referencing rows for the owner only', async () => {
    const artifact = await createArtifact({ userId: USER_A });
    expect(await countReferencingDocuments(pool, USER_A, artifact.id)).toBe(0);
    await createLinkedDocument({
      userId: USER_A,
      storageArtifactId: artifact.id,
      externalId: 'ext-1',
    });
    expect(await countReferencingDocuments(pool, USER_A, artifact.id)).toBe(1);
    await createLinkedDocument({
      userId: USER_A,
      storageArtifactId: artifact.id,
      externalId: 'ext-2',
    });
    expect(await countReferencingDocuments(pool, USER_A, artifact.id)).toBe(2);
    // Cross-user query returns 0 even though documents exist for user A.
    expect(await countReferencingDocuments(pool, USER_B, artifact.id)).toBe(0);
  });

  it('schema rejects a cross-user raw_document -> storage_artifact link via the composite FK', async () => {
    // The composite FK on raw_documents(storage_artifact_id, user_id)
    // -> storage_artifacts(id, user_id) makes cross-user FK leaks
    // impossible at the persistence layer: a USER_B raw_document
    // referencing a USER_A artifact does not satisfy the composite
    // (id, user_id) target. Postgres must reject the UPDATE.
    const artifact = await createArtifact({ userId: USER_A });
    await expect(
      createLinkedDocument({
        userId: USER_B,
        storageArtifactId: artifact.id,
        externalId: 'ext-cross-user',
      }),
    ).rejects.toThrow(/foreign key constraint|raw_documents_storage_artifact_owner_fkey/);
    // The legitimate USER_A reference still counts correctly.
    await createLinkedDocument({
      userId: USER_A,
      storageArtifactId: artifact.id,
      externalId: 'ext-owner',
    });
    expect(await countReferencingDocuments(pool, USER_A, artifact.id)).toBe(1);
    expect(await countReferencingDocuments(pool, USER_B, artifact.id)).toBe(0);
  });

  it('claimDeleteAttempt is idempotent: a second claim while the first is in flight returns null', async () => {
    const artifact = await createArtifact({ status: 'stored' });
    const first = await expectClaimable(artifact.id);
    const second = await claimDeleteAttempt(pool, USER_A, artifact.id);
    expect(second).toBeNull();
    const row = await getStorageArtifactById(pool, USER_A, artifact.id);
    expect(row!.status).toBe('deleting');
    expect(row!.deleteAttemptId).toBe(first);
  });

  it('claimDeleteAttempt re-claims a delete_failed row (retry path) and clears stale last_error', async () => {
    const artifact = await createArtifact({ status: 'stored' });
    const firstClaim = await expectClaimable(artifact.id);
    await markDeleteFailed(pool, {
      userId: USER_A,
      id: artifact.id,
      claimId: firstClaim,
      lastError: { code: 'provider_unavailable', message: 'transient' },
    });
    const retry = await claimDeleteAttempt(pool, USER_A, artifact.id);
    expect(retry).not.toBeNull();
    expect(retry!.claimId).not.toBe(firstClaim);
    // The in-flight retry must NOT surface the prior failure: the
    // Step-5 API would otherwise emit status='deleting' alongside a
    // stale provider error.
    const row = await getStorageArtifactById(pool, USER_A, artifact.id);
    expect(row!.status).toBe('deleting');
    expect(row!.lastError).toBeNull();
  });

  it('markDeleteSuccess CAS rejects a stale claim id and accepts the current one', async () => {
    const artifact = await createArtifact({ status: 'stored' });
    const claimId = await expectClaimable(artifact.id);
    const staleClaim = '00000000-0000-0000-0000-000000000000';
    await expect(
      markDeleteSuccess(pool, { userId: USER_A, id: artifact.id, claimId: staleClaim }),
    ).rejects.toThrow(/no matching claim/);
    const success = await markDeleteSuccess(pool, {
      userId: USER_A,
      id: artifact.id,
      claimId,
    });
    expect(success.status).toBe('deleted');
    expect(success.deletedAt).not.toBeNull();
    expect(success.deleteAttemptId).toBeNull();
  });

  it('markDeleteFailed records last_error and leaves the row in delete_failed', async () => {
    const artifact = await createArtifact({ status: 'stored' });
    const claimId = await expectClaimable(artifact.id);
    const failure = await markDeleteFailed(pool, {
      userId: USER_A,
      id: artifact.id,
      claimId,
      lastError: { code: 'backend_error', message: 'connection refused' },
    });
    expect(failure.status).toBe('delete_failed');
    expect(failure.deleteAttemptId).toBeNull();
    expect(failure.lastError).toEqual({ code: 'backend_error', message: 'connection refused' });
  });

  it('claimDeleteAttempt and the mark transitions reject cross-user callers', async () => {
    const artifact = await createArtifact({ userId: USER_A, status: 'stored' });
    // USER_B cannot claim USER_A's artifact.
    expect(await claimDeleteAttempt(pool, USER_B, artifact.id)).toBeNull();
    // USER_A's row is still untouched.
    const beforeClaim = await getStorageArtifactById(pool, USER_A, artifact.id);
    expect(beforeClaim!.status).toBe('stored');
    expect(beforeClaim!.deleteAttemptId).toBeNull();
    // USER_A claims successfully, then a cross-user mark fails CAS.
    const claimId = await expectClaimable(artifact.id);
    await expect(
      markDeleteSuccess(pool, { userId: USER_B, id: artifact.id, claimId }),
    ).rejects.toThrow(/no matching claim/);
    await expect(
      markDeleteFailed(pool, {
        userId: USER_B,
        id: artifact.id,
        claimId,
        lastError: { code: 'attempt', message: 'cross-user' },
      }),
    ).rejects.toThrow(/no matching claim/);
    // Row is still in `deleting` under USER_A's claim — no leakage.
    const afterMarks = await getStorageArtifactById(pool, USER_A, artifact.id);
    expect(afterMarks!.status).toBe('deleting');
    expect(afterMarks!.deleteAttemptId).toBe(claimId);
  });

  it('listArtifactsForUser excludes artifacts owned by other users', async () => {
    const ownedA = await createArtifact({ userId: USER_A, uri: 'https://e/owned-a' });
    await createArtifact({ userId: USER_B, uri: 'https://e/owned-b' });
    const page = await listArtifactsForUser(pool, USER_A, { limit: 10 });
    const ids = page.rows.map((r) => r.id);
    expect(ids).toContain(ownedA.id);
    for (const row of page.rows) {
      expect(row.userId).toBe(USER_A);
    }
  });

  it('listArtifactsForUser paginates with a created_at/id cursor and excludes soft-deleted rows', async () => {
    const first = await createArtifact({ uri: 'https://e/a' });
    const second = await createArtifact({ uri: 'https://e/b' });
    const third = await createArtifact({ uri: 'https://e/c' });
    // Assign fixed, distinct timestamps so the ordering is fully
    // deterministic and not clock-derived. (created_at DESC, id DESC)
    // resolves to third → second → first regardless of insert order.
    await pool.query(`UPDATE storage_artifacts SET created_at = '2024-01-01T00:00:01Z' WHERE id = $1`, [first.id]);
    await pool.query(`UPDATE storage_artifacts SET created_at = '2024-01-01T00:00:02Z' WHERE id = $1`, [second.id]);
    await pool.query(`UPDATE storage_artifacts SET created_at = '2024-01-01T00:00:03Z' WHERE id = $1`, [third.id]);

    const page1 = await listArtifactsForUser(pool, USER_A, { limit: 2 });
    expect(page1.rows).toHaveLength(2);
    expect(page1.rows[0].id).toBe(third.id);
    expect(page1.rows[1].id).toBe(second.id);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await listArtifactsForUser(pool, USER_A, {
      limit: 2,
      cursor: page1.nextCursor!,
    });
    expect(page2.rows).toHaveLength(1);
    expect(page2.rows[0].id).toBe(first.id);
    expect(page2.nextCursor).toBeNull();

    // Soft-delete `first` via a successful delete claim and confirm it
    // drops out of the listing.
    const claimId = await expectClaimable(first.id);
    await markDeleteSuccess(pool, { userId: USER_A, id: first.id, claimId });
    const afterDelete = await listArtifactsForUser(pool, USER_A, { limit: 10 });
    expect(afterDelete.rows.map((r) => r.id)).not.toContain(first.id);
  });
});
