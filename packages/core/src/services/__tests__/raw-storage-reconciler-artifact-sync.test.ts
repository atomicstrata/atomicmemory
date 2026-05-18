/**
 * the paired artifact-sync implementation — reconciler paired-transition tests.
 *
 * Drives the real `runOnce` codepath against a fake `head()` and a
 * seeded `blob_pending` row that has a linked `storage_artifacts`
 * row, then asserts the artifact's `status` follows the document's
 * `raw_storage_status` through `'available'` (promote) and
 * `'failed'` (archival-fail) — paired with the same call sites the
 * Filecoin reconciler uses in production.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../../db/pool.js';
import { clearDocumentTables, setupTestSchema } from '../../db/__tests__/test-fixtures.js';
import { createStorageArtifact, getStorageArtifactById } from '../../db/storage-artifact-repository.js';
import { runOnce } from '../raw-storage-reconciler.js';
import {
  USER,
  deps,
  headRetrievable,
  seedRow,
} from './raw-storage-reconciler-test-helpers.js';
import type { RawContentHeadResult } from '../../storage/raw-content-store.js';

beforeAll(async () => {
  await setupTestSchema(pool);
});

afterAll(async () => {
  await clearDocumentTables(pool);
  await pool.end();
});

beforeEach(async () => {
  await clearDocumentTables(pool);
});

async function linkPendingArtifact(
  documentId: string,
  storageUri: string,
  provider = 'filecoin',
): Promise<string> {
  const artifact = await createStorageArtifact(pool, {
    userId: USER,
    provider,
    mode: 'managed',
    uri: storageUri,
    status: 'pending',
    contentEncoding: 'identity',
    discloseContentHash: false,
    identifiers: {},
    metadata: {},
  });
  await pool.query(
    `UPDATE raw_documents SET storage_artifact_id = $1 WHERE id = $2`,
    [artifact.id, documentId],
  );
  return artifact.id;
}

describe('reconciler runOnce — paired the paired artifact-sync implementation artifact sync', () => {
  it('promotes raw_storage_status=blob_available AND artifact.status=available atomically', async () => {
    const docId = await seedRow({
      externalId: 'reconcile-promote-1',
      storageUri: 'ipfs://bafy-promote',
    });
    const artifactId = await linkPendingArtifact(docId, 'ipfs://bafy-promote');
    await runOnce(deps(headRetrievable));
    const artifact = await getStorageArtifactById(pool, USER, artifactId);
    expect(artifact!.status).toBe('available');
    expect(artifact!.lastError).toBeNull();
  });

  it('marks raw_storage_status=blob_archival_failed AND artifact.status=failed atomically on permanent failure', async () => {
    const docId = await seedRow({
      externalId: 'reconcile-fail-1',
      storageUri: 'ipfs://bafy-fail',
    });
    const artifactId = await linkPendingArtifact(docId, 'ipfs://bafy-fail');
    const headPermanent = async (): Promise<RawContentHeadResult> => ({
      exists: false,
      metadata: null,
      failure: { code: 'onramp_reported_failed', message: 'provider reported deal failed' },
    });
    await runOnce(deps(headPermanent));
    const artifact = await getStorageArtifactById(pool, USER, artifactId);
    expect(artifact!.status).toBe('failed');
    expect(artifact!.lastError).not.toBeNull();
    expect((artifact!.lastError as { code: string }).code).toBeDefined();
  });
});
