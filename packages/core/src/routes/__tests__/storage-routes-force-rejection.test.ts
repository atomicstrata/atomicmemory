/**
 * Commit G regression tests — every variant of `?force` on the
 * storage delete route returns 400 `force_not_supported` and
 * leaves both the artifact and any linked document untouched.
 *
 * `force` was the pre-Step-5 cascade bypass; the new contract
 * requires explicit `policy=with_documents`. Silently coercing
 * the parameter to `policy=artifact_only` would mask a caller
 * bug, so the rejection is stable and typed.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import { pool } from '../../db/pool.js';
import { clearDocumentTables, setupTestSchema } from '../../db/__tests__/test-fixtures.js';
import {
  authHeader,
  authHeaderWithUser,
} from '../../__tests__/helpers/auth-headers.js';
import {
  ROUTE_USER_A,
  bootStorageRouter,
  closeHandle,
  createLocalFsStorageService,
  type SuiteHandle,
} from './storage-routes-fixtures.js';
import {
  registerRawDocument,
  upsertRawSource,
} from '../../db/raw-document-repository.js';

let storageRoot: string;
let handle: SuiteHandle;

beforeAll(async () => {
  await setupTestSchema(pool);
  const setup = await createLocalFsStorageService({
    pool,
    tmpPrefix: 'storage-routes-force-',
    pointerSchemes: ['https'],
  });
  storageRoot = setup.storageRoot;
  handle = await bootStorageRouter(setup.service, 'local_fs');
});

beforeEach(async () => {
  await clearDocumentTables(pool);
});

afterAll(async () => {
  await closeHandle(handle);
  await rm(storageRoot, { recursive: true, force: true });
  await pool.end();
});

async function seedPointerLinkedToDoc(): Promise<{ artifactId: string; documentId: string }> {
  const post = await fetch(`${handle.baseUrl}/v1/storage/artifacts`, {
    method: 'POST',
    headers: { ...authHeader(), 'content-type': 'application/json', 'x-atomicmemory-user-id': ROUTE_USER_A },
    body: JSON.stringify({ mode: 'pointer', uri: 'https://example.com/force-test', content_type: 'text/plain' }),
  });
  if (post.status !== 201) throw new Error(`seed failed: ${post.status} ${await post.text()}`);
  const body = (await post.json()) as { artifact_id: string };
  const source = await upsertRawSource(pool, {
    userId: ROUTE_USER_A, sourceSite: 'drive', provider: 'google-drive',
  });
  const reg = await registerRawDocument(pool, {
    userId: ROUTE_USER_A, rawSourceId: source.id, externalId: 'force-doc',
    storageMode: 'pointer_only', externalUri: 'https://example.com/force-doc',
  });
  await pool.query(
    `UPDATE raw_documents SET storage_artifact_id = $1 WHERE id = $2`,
    [body.artifact_id, reg.document.id],
  );
  return { artifactId: body.artifact_id, documentId: reg.document.id };
}

interface ArtifactSnapshot { status: string; deleted_at: Date | null }
interface DocSnapshot { deleted_at: Date | null }

async function snapshot(artifactId: string, documentId: string): Promise<{
  artifact: ArtifactSnapshot; doc: DocSnapshot;
}> {
  const a = await pool.query<ArtifactSnapshot>(
    `SELECT status, deleted_at FROM storage_artifacts WHERE id = $1`, [artifactId],
  );
  const d = await pool.query<DocSnapshot>(
    `SELECT deleted_at FROM raw_documents WHERE id = $1`, [documentId],
  );
  return { artifact: a.rows[0], doc: d.rows[0] };
}

describe('GET /v1/storage/artifacts/:id — public metadata projection drops malformed values', () => {
  it('does NOT leak nested-object / array / null entries planted via direct SQL', async () => {
    const { artifactId } = await seedPointerLinkedToDoc();
    // Plant a hostile metadata payload directly on the row,
    // bypassing the route's `validateArtifactMetadata` write gate.
    // This mimics an ops fix / pre-validation migration leftover.
    const hostile = {
      keep_str: 'safe', keep_num: 7, keep_bool: true,
      leaked_obj: { secret: 'x' },
      leaked_arr: [1, 2, 3],
      leaked_null: null,
    };
    await pool.query(
      `UPDATE storage_artifacts SET metadata = $1::jsonb WHERE id = $2`,
      [JSON.stringify(hostile), artifactId],
    );
    const res = await fetch(
      `${handle.baseUrl}/v1/storage/artifacts/${artifactId}`,
      { headers: authHeaderWithUser(ROUTE_USER_A) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { metadata: Record<string, unknown> };
    expect(body.metadata).toEqual({ keep_str: 'safe', keep_num: 7, keep_bool: true });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('leaked_obj');
    expect(serialized).not.toContain('leaked_arr');
    expect(serialized).not.toContain('leaked_null');
  });
});

describe('DELETE /v1/storage/artifacts/:id — `?force` rejection', () => {
  it.each([
    ['?force=true', 'force=true'],
    ['?force=false', 'force=false'],
    ['?force', 'bare ?force'],
    ['?force=&policy=with_documents', 'force with companion policy'],
  ])('rejects %s (%s) with 400 force_not_supported and no state changes', async (query) => {
    const { artifactId, documentId } = await seedPointerLinkedToDoc();
    const before = await snapshot(artifactId, documentId);
    const res = await fetch(
      `${handle.baseUrl}/v1/storage/artifacts/${artifactId}${query}`,
      { method: 'DELETE', headers: authHeaderWithUser(ROUTE_USER_A) },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error_code: string; error: string };
    expect(body.error_code).toBe('force_not_supported');
    const after = await snapshot(artifactId, documentId);
    expect(after.artifact.status).toBe(before.artifact.status);
    expect(after.artifact.deleted_at).toEqual(before.artifact.deleted_at);
    expect(after.doc.deleted_at).toEqual(before.doc.deleted_at);
  });
});
