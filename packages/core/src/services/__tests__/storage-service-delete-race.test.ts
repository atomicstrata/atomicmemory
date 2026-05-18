/**
 * Commit D regression tests for `deleteArtifact`:
 *   - claim runs BEFORE cascade (no soft-delete of linked documents
 *     on a lost or refused claim);
 *   - `delete_failed` retries re-check references (no silent
 *     bulldoze of links added between attempts);
 *   - `ArtifactInUseError` releases the claim cleanly so the row
 *     returns to its pre-delete status with its prior `last_error`
 *     restored;
 *   - the link-write guard refuses to attach a new document
 *     reference to an artifact whose delete lifecycle has already
 *     started, and `swapToManagedArtifact` honours the same guard.
 */

import { describe, expect, it } from 'vitest';
import { pool } from '../../db/pool.js';
import {
  registerRawDocument,
  upsertRawSource,
} from '../../db/raw-document-repository.js';
import {
  ArtifactNotLinkableError,
  assertArtifactLinkable,
} from '../../db/storage-artifact-repository.js';
import {
  ArtifactInUseError,
} from '../storage-service-errors.js';
import {
  seedLinkedPointerDocument,
  seedPointerArtifact as seedStoragePointerArtifact,
  useStorageServiceFixture,
} from './storage-service-test-helpers.js';

const USER = 'storage-svc-delete-race-user';

const fixture = useStorageServiceFixture({
  tempPrefix: 'storage-delete-race-',
  pointerSchemes: ['https'],
});

async function seedPointerArtifact(uri: string): Promise<string> {
  return seedStoragePointerArtifact(fixture.service, USER, uri);
}

async function seedLinkedDocument(artifactId: string, externalId: string): Promise<string> {
  return seedLinkedPointerDocument({
    artifactId,
    userId: USER,
    externalId,
    externalUri: `https://example.com/${externalId}`,
  });
}

describe('deleteArtifact — claim runs before cascade', () => {
  it('refuses (artifact_in_use) AFTER claim and releases the claim cleanly', async () => {
    const artifactId = await seedPointerArtifact('https://example.com/inuse-release');
    // Seed a prior `last_error` so we can prove the release path
    // restored it (claimDeleteAttempt clears `last_error`; release
    // must put it back).
    await pool.query(
      `UPDATE storage_artifacts SET last_error = $1::jsonb WHERE id = $2`,
      [JSON.stringify({ code: 'preexisting_warning', message: 'kept' }), artifactId],
    );
    const docId = await seedLinkedDocument(artifactId, 'release-1');
    await expect(
      fixture.service.deleteArtifact({ userId: USER, id: artifactId, policy: 'artifact_only' }),
    ).rejects.toBeInstanceOf(ArtifactInUseError);
    const row = await pool.query<{
      status: string; delete_attempt_id: string | null;
      last_error: Record<string, unknown> | null;
    }>(
      `SELECT status, delete_attempt_id, last_error FROM storage_artifacts WHERE id = $1`,
      [artifactId],
    );
    expect(row.rows[0].status).toBe('stored');
    expect(row.rows[0].delete_attempt_id).toBeNull();
    expect(row.rows[0].last_error).toMatchObject({
      code: 'preexisting_warning', message: 'kept',
    });
    // Document is unchanged — no soft-delete on a refused claim.
    const doc = await pool.query<{ deleted_at: Date | null }>(
      `SELECT deleted_at FROM raw_documents WHERE id = $1`,
      [docId],
    );
    expect(doc.rows[0].deleted_at).toBeNull();
  });

  it('with_documents cascade soft-deletes the doc + finalizes the artifact', async () => {
    const artifactId = await seedPointerArtifact('https://example.com/cascade-happy');
    const docId = await seedLinkedDocument(artifactId, 'cascade-happy-1');
    const result = await fixture.service.deleteArtifact({
      userId: USER, id: artifactId, policy: 'with_documents',
    });
    expect(result.artifact.status).toBe('deleted');
    expect(result.cascadedDocumentIds).toEqual([docId]);
    const doc = await pool.query<{ deleted_at: Date | null }>(
      `SELECT deleted_at FROM raw_documents WHERE id = $1`,
      [docId],
    );
    expect(doc.rows[0].deleted_at).not.toBeNull();
  });
});

describe('deleteArtifact — delete_failed retry rechecks references', () => {
  it('a new link added between attempts raises ArtifactInUseError on retry, never silent finalize', async () => {
    const artifactId = await seedPointerArtifact('https://example.com/retry-rerefcheck');
    // Park the artifact at `delete_failed` directly so the test
    // skips the failure-injection plumbing.
    await pool.query(
      `UPDATE storage_artifacts
          SET status = 'delete_failed',
              last_error = $1::jsonb
        WHERE id = $2`,
      [JSON.stringify({ code: 'simulated_prior_failure', message: 'old' }), artifactId],
    );
    // No references yet — `policy=artifact_only` would succeed.
    // Add a fresh link AFTER the prior delete attempt, mimicking
    // the race the reorder is supposed to surface.
    const docId = await seedLinkedDocument(artifactId, 'retry-rerefcheck-1');
    await expect(
      fixture.service.deleteArtifact({ userId: USER, id: artifactId, policy: 'artifact_only' }),
    ).rejects.toBeInstanceOf(ArtifactInUseError);
    // Row returns to `delete_failed` with its prior `last_error`
    // preserved — the release path doesn't blank operator state.
    const row = await pool.query<{ status: string; last_error: Record<string, unknown> | null }>(
      `SELECT status, last_error FROM storage_artifacts WHERE id = $1`,
      [artifactId],
    );
    expect(row.rows[0].status).toBe('delete_failed');
    expect(row.rows[0].last_error).toMatchObject({
      code: 'simulated_prior_failure',
    });
    // Document is unaffected.
    const doc = await pool.query<{ deleted_at: Date | null }>(
      `SELECT deleted_at FROM raw_documents WHERE id = $1`,
      [docId],
    );
    expect(doc.rows[0].deleted_at).toBeNull();
  });
});

describe('assertArtifactLinkable — link-write guard', () => {
  it('throws ArtifactNotLinkableError for status in {deleting, deleted, delete_failed}', async () => {
    const artifactId = await seedPointerArtifact('https://example.com/linkable-guard');
    for (const status of ['deleting', 'deleted', 'delete_failed'] as const) {
      await pool.query(
        `UPDATE storage_artifacts SET status = $1 WHERE id = $2`,
        [status, artifactId],
      );
      await expect(assertArtifactLinkable(pool, USER, artifactId))
        .rejects.toBeInstanceOf(ArtifactNotLinkableError);
    }
  });

  it('no-ops when the artifact is active or absent', async () => {
    const artifactId = await seedPointerArtifact('https://example.com/linkable-ok');
    await expect(assertArtifactLinkable(pool, USER, artifactId)).resolves.toBeUndefined();
    await expect(
      assertArtifactLinkable(pool, USER, '00000000-0000-0000-0000-000000000000'),
    ).resolves.toBeUndefined();
  });
});

describe('deleteBySource source-reset guard for in-flight delete claims', () => {
  it('leaves a claimed artifact untouched when a source reset runs concurrently', async () => {
    const artifactId = await seedPointerArtifact('https://example.com/source-reset-guard');
    await seedLinkedDocument(artifactId, 'source-reset-guard-doc');
    // Move the artifact into a claimed `deleting` state to mimic
    // an in-flight `StorageService.deleteArtifact` call.
    const claimId = '22222222-2222-4222-8222-222222222222';
    await pool.query(
      `UPDATE storage_artifacts
          SET status = 'deleting', delete_attempt_id = $1
        WHERE id = $2`,
      [claimId, artifactId],
    );
    const { deleteBySource } = await import('../../db/repository-document-delete.js');
    await deleteBySource(pool, USER, 'drive');
    const row = await pool.query<{
      status: string; delete_attempt_id: string | null;
    }>(
      `SELECT status, delete_attempt_id FROM storage_artifacts WHERE id = $1`,
      [artifactId],
    );
    // Both fields must be untouched: status stays `deleting`,
    // claim id stays exactly as we parked it. The storage
    // service's own finalize CAS (`markDeleteSuccess` /
    // `markDeleteFailed`) keeps its right to terminate the row.
    expect(row.rows[0].status).toBe('deleting');
    expect(row.rows[0].delete_attempt_id).toBe(claimId);
  });
});

describe('swapToManagedArtifact honours the linkable guard', () => {
  it('refuses to soft-delete a prior artifact whose delete is in progress', async () => {
    const priorArtifactId = await seedPointerArtifact('https://example.com/swap-blocker');
    const source = await upsertRawSource(pool, {
      userId: USER, sourceSite: 'drive', provider: 'google-drive',
    });
    const reg = await registerRawDocument(pool, {
      userId: USER, rawSourceId: source.id, externalId: 'swap-blocker-doc',
      storageMode: 'pointer_only', externalUri: 'https://example.com/swap-blocker-doc',
    });
    // Wire the doc into the `blob_uploading` claim window the swap
    // path expects, then link it to the prior artifact and move
    // the prior artifact into `deleting` to simulate the race.
    const claimId = '11111111-1111-4111-8111-111111111111';
    await pool.query(
      `UPDATE raw_documents
          SET storage_artifact_id = $1,
              raw_storage_status = 'blob_uploading',
              raw_storage_claim_id = $2
        WHERE id = $3`,
      [priorArtifactId, claimId, reg.document.id],
    );
    await pool.query(
      `UPDATE storage_artifacts SET status = 'deleting' WHERE id = $1`,
      [priorArtifactId],
    );
    const { recordUploadResultAndSwapArtifact } = await import(
      '../document-upload-artifact-sync.js'
    );
    await expect(
      recordUploadResultAndSwapArtifact(pool, {
        userId: USER,
        documentId: reg.document.id,
        claimId,
        storageUri: 'local-fs://swap-test.bin',
        storageProvider: 'local_fs',
        rawStorageMetadata: {},
        document: { id: reg.document.id, userId: USER, mimeType: null },
        contentHash: 'h',
        stored: {
          storageUri: 'local-fs://swap-test.bin',
          storageProvider: 'local_fs',
          contentHash: 'h',
          sizeBytes: 0,
          providerMetadata: {},
          status: 'stored',
        },
      }),
    ).rejects.toBeInstanceOf(ArtifactNotLinkableError);
    // The prior artifact stays at 'deleting' (the swap aborted in
    // the same TX, so its softDeleteArtifactByIdWithClient never
    // committed).
    const row = await pool.query<{ status: string }>(
      `SELECT status FROM storage_artifacts WHERE id = $1`, [priorArtifactId],
    );
    expect(row.rows[0].status).toBe('deleting');
  });
});
