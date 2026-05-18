/**
 * Route-level coverage for Commit E: a concurrent DELETE while
 * another caller holds an active `delete_attempt_id` returns 409
 * `delete_in_flight` with `retryable: true` — and crucially does
 * NOT release or finalize the sibling caller's claim. Pairs with
 * `storage-service-delete-in-flight.test.ts` (service-layer
 * assertions); this file only covers the wire envelope + the
 * sibling-claim invariant.
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

const SYNTHETIC_OTHER_CLAIM_ID = '44444444-4444-4444-8444-444444444444';

let storageRoot: string;
let handle: SuiteHandle;

beforeAll(async () => {
  await setupTestSchema(pool);
  const setup = await createLocalFsStorageService({
    pool,
    tmpPrefix: 'storage-routes-in-flight-',
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

async function createPointerArtifact(): Promise<string> {
  const res = await fetch(`${handle.baseUrl}/v1/storage/artifacts`, {
    method: 'POST',
    headers: {
      ...authHeader(),
      'content-type': 'application/json',
      'x-atomicmemory-user-id': ROUTE_USER_A,
    },
    body: JSON.stringify({
      mode: 'pointer',
      uri: 'https://example.com/in-flight-route',
      content_type: 'text/plain',
    }),
  });
  if (res.status !== 201) {
    throw new Error(
      `createPointerArtifact: expected 201, got ${res.status}: ${await res.text()}`,
    );
  }
  const body = (await res.json()) as { artifact_id: string };
  return body.artifact_id;
}

describe('DELETE /v1/storage/artifacts/:id — claim-null in-flight semantics', () => {
  it('returns 409 delete_in_flight without releasing the sibling caller`s claim', async () => {
    const id = await createPointerArtifact();
    await pool.query(
      `UPDATE storage_artifacts SET status = 'deleting', delete_attempt_id = $1 WHERE id = $2`,
      [SYNTHETIC_OTHER_CLAIM_ID, id],
    );
    const res = await fetch(
      `${handle.baseUrl}/v1/storage/artifacts/${id}`,
      { method: 'DELETE', headers: authHeaderWithUser(ROUTE_USER_A) },
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error_code: string; artifact_id: string; current_status: string; retryable: boolean;
    };
    expect(body.error_code).toBe('delete_in_flight');
    expect(body.artifact_id).toBe(id);
    expect(body.current_status).toBe('deleting');
    expect(body.retryable).toBe(true);
    const row = await pool.query<{ status: string; delete_attempt_id: string | null }>(
      `SELECT status, delete_attempt_id FROM storage_artifacts WHERE id = $1`,
      [id],
    );
    expect(row.rows[0].status).toBe('deleting');
    expect(row.rows[0].delete_attempt_id).toBe(SYNTHETIC_OTHER_CLAIM_ID);
  });
});
