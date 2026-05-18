/**
 * Repository-level deletion + cross-cutting tests for the document
 * pipeline (Phase 1). Split from `raw-document-repository.test.ts` to
 * keep both files under the 40-lines-per-test cap.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearDocumentTables, setupTestSchema } from './test-fixtures.js';
import { pool } from '../pool.js';
import {
  getRawDocumentById,
  listRawDocuments,
  registerRawDocument,
  softDeleteRawDocument,
  upsertRawSource,
} from '../raw-document-repository.js';
import { deleteAll } from '../repository-write.js';
import { deleteBySource } from '../repository-document-delete.js';

const USER_A = 'doc-del-user-a';
const USER_B = 'doc-del-user-b';

async function makeDoc(userId: string, sourceSite: string, externalId: string) {
  const source = await upsertRawSource(pool, {
    userId,
    sourceSite,
    provider: sourceSite,
  });
  const result = await registerRawDocument(pool, {
    userId,
    rawSourceId: source.id,
    externalId,
  });
  return result.document;
}

describe('raw-document deletion + isolation (Phase 1)', () => {
  beforeAll(async () => {
    await setupTestSchema(pool);
  });

  beforeEach(async () => {
    await clearDocumentTables(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('softDeleteRawDocument is idempotent (true once, false thereafter)', async () => {
    const doc = await makeDoc(USER_A, 'drive', 'file-1');
    expect(await softDeleteRawDocument(pool, USER_A, doc.id)).toBe(true);
    expect(await softDeleteRawDocument(pool, USER_A, doc.id)).toBe(false);
  });

  it('getRawDocumentById returns null for soft-deleted rows and cross-user lookups', async () => {
    const doc = await makeDoc(USER_A, 'drive', 'file-1');
    expect((await getRawDocumentById(pool, USER_A, doc.id))?.id).toBe(doc.id);
    expect(await getRawDocumentById(pool, USER_B, doc.id)).toBeNull();
    await softDeleteRawDocument(pool, USER_A, doc.id);
    expect(await getRawDocumentById(pool, USER_A, doc.id)).toBeNull();
  });

  it('listRawDocuments excludes soft-deleted rows and filters by source_site', async () => {
    await makeDoc(USER_A, 'drive', 'file-drive-1');
    await makeDoc(USER_A, 'drive', 'file-drive-2');
    const upload = await makeDoc(USER_A, 'webapp-file', 'file-upload-1');
    await softDeleteRawDocument(pool, USER_A, upload.id);

    const driveOnly = await listRawDocuments(pool, { userId: USER_A, sourceSite: 'drive' });
    expect(driveOnly).toHaveLength(2);
    const all = await listRawDocuments(pool, { userId: USER_A });
    expect(all).toHaveLength(2);
  });

  it('deleteBySource tombstones documents and returns the count', async () => {
    await makeDoc(USER_A, 'drive', 'file-drive-1');
    await makeDoc(USER_A, 'drive', 'file-drive-2');
    await makeDoc(USER_A, 'webapp-file', 'file-upload-1');

    const result = await deleteBySource(pool, USER_A, 'drive');
    expect(result.deletedDocuments).toBe(2);
    const remaining = await listRawDocuments(pool, { userId: USER_A });
    expect(remaining.map(d => d.externalId)).toEqual(['file-upload-1']);
  });

  it('pointer-only invariant: storage_uri and storage_provider are NEVER set on register', async () => {
    const doc = await makeDoc(USER_A, 'drive', 'file-1');
    expect(doc.storageMode).toBe('pointer_only');
    expect(doc.storageUri).toBeNull();
    expect(doc.storageProvider).toBeNull();
    expect(doc.rawStorageStatus).toBe('pointer_recorded');
  });

  it('deleteBySource is cross-user-safe', async () => {
    await makeDoc(USER_A, 'drive', 'file-1');
    const userBDoc = await makeDoc(USER_B, 'drive', 'file-1');

    const result = await deleteBySource(pool, USER_A, 'drive');
    expect(result.deletedDocuments).toBe(1);
    expect((await getRawDocumentById(pool, USER_B, userBDoc.id))?.id).toBe(userBDoc.id);
  });

  it('deleteAll(userId) hard-deletes that user\'s documents only (cross-user isolated)', async () => {
    const aDoc = await makeDoc(USER_A, 'drive', 'file-1');
    const bDoc = await makeDoc(USER_B, 'drive', 'file-1');

    await deleteAll(pool, USER_A);

    // USER_A documents and sources are hard-gone.
    const aRow = await pool.query('SELECT 1 FROM raw_documents WHERE id = $1', [aDoc.id]);
    expect(aRow.rowCount).toBe(0);
    const aSourceRow = await pool.query('SELECT 1 FROM raw_sources WHERE user_id = $1', [USER_A]);
    expect(aSourceRow.rowCount).toBe(0);
    // USER_B is untouched.
    expect((await getRawDocumentById(pool, USER_B, bDoc.id))?.id).toBe(bDoc.id);
  });

  it('deleteAll() (no userId) hard-deletes every document + source row', async () => {
    await makeDoc(USER_A, 'drive', 'file-1');
    await makeDoc(USER_B, 'webapp-file', 'doc-2');

    await deleteAll(pool);

    const docs = await pool.query('SELECT COUNT(*)::int AS n FROM raw_documents');
    const srcs = await pool.query('SELECT COUNT(*)::int AS n FROM raw_sources');
    expect(docs.rows[0].n).toBe(0);
    expect(srcs.rows[0].n).toBe(0);
  });
});
