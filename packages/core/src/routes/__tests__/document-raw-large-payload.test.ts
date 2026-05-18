/**
 * Phase 8.6 — large-payload boundary test for `PUT /v1/documents/:id/raw`.
 *
 * Plan §Phase 8.6 calls for explicit coverage of the
 * `RAW_UPLOAD_MAX_BYTES` boundary: a body whose length is exactly
 * the cap MUST succeed, a body one byte over the cap MUST return
 * 413 WITHOUT reaching the handler — so the row never claims a slot
 * or writes any partial state. The existing raw-route test
 * exercises happy paths + 404/400/409/503; Phase 8.6 adds the
 * missing 413 branch.
 *
 * The cap is enforced by Express's `express.raw({ limit })` body
 * parser mounted in `registerUploadRoute`; the route handler does
 * not see the body when the limit fires. A 1 KiB cap keeps test
 * payloads small + fast. The managed-blob app + lifecycle live in
 * `useManagedBlobApp` (shared with the existing raw-route file).
 */

import { describe, expect, it } from 'vitest';
import { pool } from '../../db/pool.js';
import { getRawDocumentById } from '../../db/raw-document-repository.js';
import { useManagedBlobApp } from './document-router-test-fixtures.js';

const TEST_USER = 'doc-raw-large-payload-user';
const CAP_BYTES = 1024;

const server = useManagedBlobApp(pool, {
  rawUploadMaxBytes: CAP_BYTES,
  storagePrefix: 'p86',
});

async function registerDoc(externalId: string): Promise<string> {
  const res = await fetch(`${server.baseUrl()}/documents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      user_id: TEST_USER, source_site: 'webapp-file',
      provider: 'manual-upload', external_id: externalId,
    }),
  });
  const body = (await res.json()) as { document: { id: string } };
  return body.document.id;
}

async function putRaw(id: string, body: Buffer): Promise<number> {
  const res = await fetch(
    `${server.baseUrl()}/documents/${id}/raw?user_id=${TEST_USER}`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: body as unknown as BodyInit,
    },
  );
  // Drain the body so the connection closes cleanly; we only need
  // the status for the 413 boundary assertion.
  await res.text();
  return res.status;
}

describe('PUT /v1/documents/:id/raw — large-payload boundary (Phase 8.6)', () => {
  it('accepts a body exactly at RAW_UPLOAD_MAX_BYTES (CAP_BYTES)', async () => {
    const id = await registerDoc('large-payload-cap');
    const atCap = Buffer.alloc(CAP_BYTES, 0x61);
    expect(await putRaw(id, atCap)).toBe(200);
    const row = await getRawDocumentById(pool, TEST_USER, id);
    expect(row?.rawStorageStatus).toBe('blob_stored');
    expect(row?.sizeBytes).toBe(CAP_BYTES);
  });

  it('returns 413 for a body one byte over the cap; row stays pointer_recorded', async () => {
    const id = await registerDoc('large-payload-over');
    const oversize = Buffer.alloc(CAP_BYTES + 1, 0x62);
    expect(await putRaw(id, oversize)).toBe(413);
    // Body-parser limit fires BEFORE the handler runs, so the row's
    // raw_storage_status MUST NOT have advanced. Phase 5 α never
    // claimed a slot.
    const row = await getRawDocumentById(pool, TEST_USER, id);
    expect(row?.rawStorageStatus).toBe('pointer_recorded');
    expect(row?.storageUri).toBeNull();
    expect(row?.sizeBytes).toBeNull();
  });

  it('returns 413 for a body well over the cap; no claim, no managed-blob state', async () => {
    const id = await registerDoc('large-payload-far-over');
    const far = Buffer.alloc(CAP_BYTES * 4, 0x63);
    expect(await putRaw(id, far)).toBe(413);
    const row = await getRawDocumentById(pool, TEST_USER, id);
    expect(row?.rawStorageStatus).toBe('pointer_recorded');
    expect(row?.rawStorageClaimId).toBeNull();
  });
});
