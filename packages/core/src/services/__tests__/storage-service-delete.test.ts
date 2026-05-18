/**
 * Service-level integration tests for `StorageService.deleteArtifact`
 * — the delete-policy state machine plus the with_documents cascade.
 *
 * Sibling to `storage-service.test.ts`; split out to keep both files
 * under the 400-non-comment-LOC test cap. Covers:
 *
 *   - `artifact_only` happy path,
 *   - reference-gate (`ArtifactInUseError` when documents link),
 *   - `with_documents` cascade (managed + pointer modes),
 *   - paired-tx propagation of `raw_storage_status` onto cascaded
 *     docs on both backend success and backend failure,
 *   - idempotent second-delete.
 */

import { describe, expect, it } from 'vitest';
import { pool } from '../../db/pool.js';
import {
  registerRawDocument,
  upsertRawSource,
} from '../../db/raw-document-repository.js';
import { type DeleteArtifactPolicy } from '../storage-service.js';
import {
  CascadedRawDocumentMismatchError,
  finalizeArtifactDeleteSuccessTx,
} from '../../db/storage-artifact-delete-tx.js';
import { claimDeleteAttempt } from '../../db/storage-artifact-repository.js';
import {
  createStorageService,
  makeStubStorageBackend,
  seedLinkedPointerDocument,
  useStorageServiceFixture,
} from './storage-service-test-helpers.js';

const USER_A = 'storage-svc-delete-user-a';

const fixture = useStorageServiceFixture({ tempPrefix: 'storage-svc-delete-' });

async function seedManagedDocLinkedToArtifact(
  userId: string, externalId: string,
): Promise<{ docId: string; artifactId: string }> {
  const source = await upsertRawSource(pool, {
    userId, sourceSite: 'drive', provider: 'google-drive',
  });
  const reg = await registerRawDocument(pool, {
    userId, rawSourceId: source.id, externalId,
    storageMode: 'pointer_only', externalUri: 'https://example.com/' + externalId,
  });
  const artifact = await pool.query<{ id: string }>(
    `INSERT INTO storage_artifacts (
       user_id, provider, mode, uri, status, content_encoding,
       disclose_content_hash, identifiers, lifecycle, metadata
     ) VALUES ($1, 'local_fs', 'managed', $2, 'stored', 'identity',
       FALSE, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb)
     RETURNING id`,
    [userId, `local-fs://${externalId}.bin`],
  );
  await pool.query(
    `UPDATE raw_documents
        SET storage_mode = 'managed_blob',
            raw_storage_status = 'blob_stored',
            storage_uri = $1,
            storage_provider = 'local_fs',
            storage_artifact_id = $2
      WHERE id = $3`,
    [`local-fs://${externalId}.bin`, artifact.rows[0].id, reg.document.id],
  );
  return { docId: reg.document.id, artifactId: artifact.rows[0].id };
}

async function linkArtifactToDocument(artifactId: string, userId: string): Promise<string> {
  return seedLinkedPointerDocument({
    artifactId,
    userId,
    externalId: `ext-${artifactId.slice(0, 8)}`,
    externalUri: 'https://example.com/doc.pdf',
  });
}

describe('StorageService — delete-policy state machine', () => {
  it('default policy with no references soft-deletes the artifact and reports status=deleted', async () => {
    const row = await fixture.service.putPointer({
      userId: USER_A,
      uri: 'https://example.com/a',
      contentType: 'text/plain',
    });
    const result = await fixture.service.deleteArtifact({
      userId: USER_A,
      id: row.id,
      policy: 'artifact_only',
    });
    expect(result.artifact.status).toBe('deleted');
    expect(result.cascadedDocumentIds).toEqual([]);
  });

  it('default policy with active references throws ArtifactInUseError', async () => {
    const artifact = await fixture.service.putPointer({
      userId: USER_A,
      uri: 'https://example.com/a',
      contentType: 'text/plain',
    });
    await linkArtifactToDocument(artifact.id, USER_A);
    await expect(
      fixture.service.deleteArtifact({
        userId: USER_A,
        id: artifact.id,
        policy: 'artifact_only',
      }),
    ).rejects.toMatchObject({
      name: 'ArtifactInUseError',
      referencedByDocumentCount: 1,
    });
  });

  it('policy=with_documents cascades the referencing documents then deletes the artifact', async () => {
    const artifact = await fixture.service.putPointer({
      userId: USER_A,
      uri: 'https://example.com/a',
      contentType: 'text/plain',
    });
    const docId = await linkArtifactToDocument(artifact.id, USER_A);
    const result = await fixture.service.deleteArtifact({
      userId: USER_A,
      id: artifact.id,
      policy: 'with_documents' as DeleteArtifactPolicy,
    });
    expect(result.cascadedDocumentIds).toEqual([docId]);
    expect(result.artifact.status).toBe('deleted');
  });

  it('managed artifact delete with_documents propagates raw_storage_status to cascaded docs on success', async () => {
    const { docId, artifactId } = await seedManagedDocLinkedToArtifact(USER_A, 'cascade-success-1');
    const result = await fixture.service.deleteArtifact({
      userId: USER_A,
      id: artifactId,
      policy: 'with_documents' as DeleteArtifactPolicy,
    });
    expect(result.artifact.status).toBe('deleted');
    expect(result.cascadedDocumentIds).toEqual([docId]);
    const docRow = await pool.query<{ raw_storage_status: string; deleted_at: Date | null }>(
      `SELECT raw_storage_status, deleted_at FROM raw_documents WHERE id = $1`,
      [docId],
    );
    expect(docRow.rows[0].raw_storage_status).toBe('blob_deleted');
    expect(docRow.rows[0].deleted_at).not.toBeNull();
  });

  it('managed artifact delete with_documents marks cascaded docs raw_storage_failed when backend.delete throws', async () => {
    // Force backend.delete to throw on a single artifact id by
    // wrapping a real local_fs backend. The DB row remains active
    // until claimDeleteAttempt fires; cascade leaves the linked
    // artifact alone for managed docs (blobs.length > 0 → no
    // preflip), claim succeeds, backend.delete throws, the paired
    // failure path runs.
    const failingBackend = makeStubStorageBackend({
      provider: 'local_fs',
      deleteError: 'simulated backend outage',
    });
    const svc = createStorageService(failingBackend, ['https']);
    const { docId, artifactId } = await seedManagedDocLinkedToArtifact(USER_A, 'cascade-fail-1');
    const result = await svc.deleteArtifact({
      userId: USER_A,
      id: artifactId,
      policy: 'with_documents' as DeleteArtifactPolicy,
    });
    expect(result.artifact.status).toBe('delete_failed');
    const docRow = await pool.query<{ raw_storage_status: string; last_error: unknown }>(
      `SELECT raw_storage_status, last_error FROM raw_documents WHERE id = $1`,
      [docId],
    );
    expect(docRow.rows[0].raw_storage_status).toBe('raw_storage_failed');
    expect(docRow.rows[0].last_error).not.toBeNull();
  });

  it('refuses to finalize when cascaded raw_documents UPDATE matches fewer rows than expected', async () => {
    // Seed: one real soft-deleted linked managed doc + artifact in
    // `deleting` (claimed). Then call the tx helper directly with a
    // stale extra UUID alongside the real id. The propagation
    // UPDATE matches 1 row, not 2 — rowCount mismatch must roll the
    // whole tx back: artifact stays `deleting`, real doc stays at
    // `blob_stored`. Without the assertion the artifact would
    // silently finalize as `deleted` while the stale id never
    // existed and the artifact's claim would never recover.
    const { docId, artifactId } = await seedManagedDocLinkedToArtifact(USER_A, 'mismatch-1');
    await pool.query(
      `UPDATE raw_documents SET deleted_at = NOW() WHERE id = $1`,
      [docId],
    );
    const claim = await claimDeleteAttempt(pool, USER_A, artifactId);
    expect(claim).not.toBeNull();
    const staleId = '00000000-0000-0000-0000-000000000000';
    await expect(
      finalizeArtifactDeleteSuccessTx(pool, {
        userId: USER_A,
        artifactId,
        claimId: claim!.claimId,
        cascadedDocumentIds: [docId, staleId],
        semantics: 'deleted',
      }),
    ).rejects.toBeInstanceOf(CascadedRawDocumentMismatchError);
    const artifactRow = await pool.query<{ status: string; deleted_at: Date | null }>(
      `SELECT status, deleted_at FROM storage_artifacts WHERE id = $1`,
      [artifactId],
    );
    expect(artifactRow.rows[0].status).toBe('deleting');
    expect(artifactRow.rows[0].deleted_at).toBeNull();
    const docRow = await pool.query<{ raw_storage_status: string }>(
      `SELECT raw_storage_status FROM raw_documents WHERE id = $1`,
      [docId],
    );
    expect(docRow.rows[0].raw_storage_status).toBe('blob_stored');
  });

  it('a second delete on an already-deleted artifact is idempotent', async () => {
    const row = await fixture.service.putPointer({
      userId: USER_A,
      uri: 'https://example.com/idem',
      contentType: 'text/plain',
    });
    await fixture.service.deleteArtifact({ userId: USER_A, id: row.id, policy: 'artifact_only' });
    // Second call should not throw and should report the same terminal state.
    const second = await fixture.service.deleteArtifact({
      userId: USER_A,
      id: row.id,
      policy: 'artifact_only',
    });
    expect(second.artifact.status).toBe('deleted');
  });
});
