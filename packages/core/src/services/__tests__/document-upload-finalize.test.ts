/**
 * Focused coverage for the upload finalization transaction.
 *
 * The end-to-end upload tests cover the happy finalize path. This
 * file pins the compare-and-set failure branch directly: if the
 * claim changed after bytes were recorded, Phase gamma must refuse
 * to finalize and must leave the row in the in-flight state for the
 * active owner.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../../db/pool.js';
import { clearDocumentTables, setupTestSchema } from '../../db/__tests__/test-fixtures.js';
import { registerRawDocument, upsertRawSource } from '../../db/raw-document-repository.js';
import { finalizeUploadAndSyncArtifact } from '../document-upload-artifact-sync.js';

const USER = 'upload-finalize-user';

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

describe('finalizeUploadAndSyncArtifact — claim CAS failure', () => {
  it('returns 0 and preserves the active claim when the caller lost ownership', async () => {
    const documentId = await seedUploadingDoc();
    const rowCount = await finalizeUploadAndSyncArtifact(pool, {
      userId: USER,
      documentId,
      claimId: 'stale-claim',
      finalStatus: 'blob_stored',
    });
    expect(rowCount).toBe(0);
    const row = await pool.query<{
      raw_storage_status: string;
      raw_storage_claim_id: string | null;
    }>(
      `SELECT raw_storage_status, raw_storage_claim_id FROM raw_documents WHERE id = $1`,
      [documentId],
    );
    expect(row.rows[0]).toEqual({
      raw_storage_status: 'blob_uploading',
      raw_storage_claim_id: 'active-claim',
    });
  });
});

async function seedUploadingDoc(): Promise<string> {
  const src = await upsertRawSource(pool, {
    userId: USER,
    sourceSite: 'drive',
    provider: 'drive',
  });
  const reg = await registerRawDocument(pool, {
    userId: USER,
    rawSourceId: src.id,
    externalId: 'finalize-cas',
  });
  await pool.query(
    `UPDATE raw_documents
        SET raw_storage_status = 'blob_uploading',
            raw_storage_claim_id = 'active-claim',
            raw_storage_claimed_at = NOW(),
            storage_mode = 'managed_blob',
            storage_uri = 'local_fs://finalize-cas.bin',
            storage_provider = 'local_fs'
      WHERE id = $1`,
    [reg.document.id],
  );
  return reg.document.id;
}
