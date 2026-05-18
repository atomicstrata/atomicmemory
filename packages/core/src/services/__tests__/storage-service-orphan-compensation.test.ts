/**
 * Commit D regression tests for the Phase β2 orphan-bytes
 * compensation path:
 *   - on `ArtifactNotLinkableError`, `store.delete` runs and the
 *     raw_document flips from `blob_uploading` to
 *     `raw_storage_failed` with a typed `artifact_not_linkable`
 *     envelope (so public status surfaces stop saying "upload in
 *     progress" for a doc whose upload actually failed);
 *   - when the compensating `store.delete` itself fails, the
 *     orphan URI + provider are persisted on
 *     `raw_documents.last_error.internal_recovery_hint` so a
 *     reconciler / ops can find the abandoned bytes. The wire
 *     formatter strips `internal_*` keys before exposing
 *     `last_error` on the public response.
 */

import { describe, expect, it } from 'vitest';
import { pool } from '../../db/pool.js';
import {
  registerRawDocument,
  upsertRawSource,
} from '../../db/raw-document-repository.js';
import { LocalFsRawContentStore } from '../../storage/local-fs-store.js';
import { ArtifactNotLinkableError } from '../../db/storage-artifact-repository.js';
import { DocumentService } from '../document-service.js';
import { TEST_STORAGE_KEY_HMAC_SECRET } from '../../__tests__/helpers/storage-key-test-secret.js';
import { useStorageRootFixture } from './storage-service-test-helpers.js';

const USER = 'storage-svc-orphan-compensation-user';

const fixture = useStorageRootFixture('storage-orphan-comp-');

interface OrphanScenario {
  docService: DocumentService;
  documentId: string;
  priorArtifactId: string;
  deleteCalls: string[];
}

async function buildOrphanScenario(
  externalId: string,
  opts: { failDelete?: boolean } = {},
): Promise<OrphanScenario> {
  const deleteCalls: string[] = [];
  const baseStore = new LocalFsRawContentStore({ root: fixture.storageRoot });
  const trackingStore: LocalFsRawContentStore = Object.assign(
    Object.create(LocalFsRawContentStore.prototype),
    baseStore,
  );
  const realDelete = trackingStore.delete.bind(trackingStore);
  trackingStore.delete = async (uri: string) => {
    deleteCalls.push(uri);
    if (opts.failDelete) throw new Error('synthetic backend delete failure');
    return realDelete(uri);
  };
  const docService = new DocumentService(pool, {
    rawContentStore: trackingStore,
    config: { rawStorageMode: 'managed_blob', storageKeyHmacSecret: TEST_STORAGE_KEY_HMAC_SECRET, rawStoragePrefix: 'phase3' },
  });
  const source = await upsertRawSource(pool, {
    userId: USER, sourceSite: 'drive', provider: 'google-drive',
  });
  const reg = await registerRawDocument(pool, {
    userId: USER, rawSourceId: source.id, externalId,
    storageMode: 'pointer_only', externalUri: `https://example.com/${externalId}`,
  });
  const priorArtifactId = reg.document.storageArtifactId;
  if (priorArtifactId === null) throw new Error('test setup: expected pointer artifact link');
  await pool.query(
    `UPDATE storage_artifacts SET status = 'deleting' WHERE id = $1`,
    [priorArtifactId],
  );
  return { docService, documentId: reg.document.id, priorArtifactId, deleteCalls };
}

interface RawDocRow {
  raw_storage_status: string;
  raw_storage_claim_id: string | null;
  last_error: Record<string, unknown> | null;
}

async function readRawDoc(documentId: string): Promise<RawDocRow> {
  const r = await pool.query<RawDocRow>(
    `SELECT raw_storage_status, raw_storage_claim_id, last_error
       FROM raw_documents WHERE id = $1`,
    [documentId],
  );
  return r.rows[0];
}

describe('uploadRaw orphan-bytes compensation — happy cleanup', () => {
  it('flips raw_doc to raw_storage_failed with artifact_not_linkable envelope after store.delete', async () => {
    const scenario = await buildOrphanScenario('orphan-happy-cleanup');
    await expect(
      scenario.docService.uploadRaw({
        documentId: scenario.documentId, userId: USER,
        body: Buffer.from('orphan-payload'), contentType: 'text/plain',
      }),
    ).rejects.toBeInstanceOf(ArtifactNotLinkableError);
    expect(scenario.deleteCalls.length).toBe(1);
    expect(scenario.deleteCalls[0].length).toBeGreaterThan(0);
    const row = await readRawDoc(scenario.documentId);
    expect(row.raw_storage_status).toBe('raw_storage_failed');
    expect(row.raw_storage_claim_id).toBeNull();
    expect(row.last_error).toMatchObject({
      layer: 'raw_storage', code: 'artifact_not_linkable',
    });
    expect(row.last_error).not.toHaveProperty('internal_recovery_hint');
  });
});

describe('uploadRaw orphan-bytes compensation — cleanup failure persists recovery hint', () => {
  it('embeds orphan URI/provider in last_error.internal_recovery_hint when store.delete throws', async () => {
    const scenario = await buildOrphanScenario('orphan-cleanup-fail', { failDelete: true });
    await expect(
      scenario.docService.uploadRaw({
        documentId: scenario.documentId, userId: USER,
        body: Buffer.from('orphan-payload'), contentType: 'text/plain',
      }),
    ).rejects.toBeInstanceOf(ArtifactNotLinkableError);
    expect(scenario.deleteCalls.length).toBe(1);
    const row = await readRawDoc(scenario.documentId);
    expect(row.raw_storage_status).toBe('raw_storage_failed');
    expect(row.last_error).toMatchObject({
      layer: 'raw_storage', code: 'artifact_not_linkable',
    });
    const envelope = row.last_error as Record<string, unknown>;
    const hint = envelope.internal_recovery_hint as Record<string, unknown> | undefined;
    expect(hint).toBeDefined();
    expect(typeof hint!.storage_uri).toBe('string');
    expect((hint!.storage_uri as string).length).toBeGreaterThan(0);
    expect(hint!.storage_provider).toBe('local_fs');
    expect(typeof hint!.cleanup_error).toBe('string');
  });
});
