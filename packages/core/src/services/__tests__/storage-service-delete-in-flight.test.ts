/**
 * Commit E regression tests for `deleteArtifact`'s claim-null
 * disambiguation:
 *
 *   - row in `status='deleting'` with an active `delete_attempt_id`
 *     → throws `ArtifactDeleteInFlightError`. The caller never ran
 *     the cascade or backend.delete, so reporting success would
 *     falsely promise a delete this caller didn't perform.
 *   - row in `status='deleted'` → idempotent terminal envelope
 *     (the plan's idempotency contract).
 *
 * Determinism: the in-flight state is set up by directly parking a
 * row at `status='deleting'` with a synthetic `delete_attempt_id`
 * — no timing / no fake clocks. Mirrors the same approach used by
 * `storage-service-delete-race.test.ts` for source-reset guards.
 */

import { describe, expect, it } from 'vitest';
import { pool } from '../../db/pool.js';
import { ArtifactDeleteInFlightError } from '../storage-service-errors.js';
import {
  seedPointerArtifact,
  useStorageServiceFixture,
} from './storage-service-test-helpers.js';

const USER = 'storage-svc-delete-in-flight-user';
const SYNTHETIC_CLAIM_ID = '33333333-3333-4333-8333-333333333333';

const fixture = useStorageServiceFixture({
  tempPrefix: 'storage-delete-in-flight-',
  pointerSchemes: ['https'],
});

async function seedArtifact(uri: string): Promise<string> {
  return seedPointerArtifact(fixture.service, USER, uri);
}

async function parkArtifactInDeleting(artifactId: string): Promise<void> {
  await pool.query(
    `UPDATE storage_artifacts
        SET status = 'deleting', delete_attempt_id = $1, updated_at = NOW()
      WHERE id = $2`,
    [SYNTHETIC_CLAIM_ID, artifactId],
  );
}

describe('deleteArtifact — claim-null in-flight semantics', () => {
  it('throws ArtifactDeleteInFlightError when the row is mid-delete (status=deleting + active claim)', async () => {
    const artifactId = await seedArtifact('https://example.com/in-flight-1');
    await parkArtifactInDeleting(artifactId);
    let caught: unknown = undefined;
    try {
      await fixture.service.deleteArtifact({ userId: USER, id: artifactId, policy: 'artifact_only' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ArtifactDeleteInFlightError);
    const e = caught as ArtifactDeleteInFlightError;
    expect(e.artifactId).toBe(artifactId);
    expect(e.currentStatus).toBe('deleting');
    // The other caller's claim is intact — the in-flight rejection
    // must not have run release/finalize on someone else's claim.
    const row = await pool.query<{ status: string; delete_attempt_id: string | null }>(
      `SELECT status, delete_attempt_id FROM storage_artifacts WHERE id = $1`,
      [artifactId],
    );
    expect(row.rows[0].status).toBe('deleting');
    expect(row.rows[0].delete_attempt_id).toBe(SYNTHETIC_CLAIM_ID);
  });

  it('returns the terminal envelope (idempotent) when the row is already deleted', async () => {
    const artifactId = await seedArtifact('https://example.com/idem-after-delete');
    await fixture.service.deleteArtifact({ userId: USER, id: artifactId, policy: 'artifact_only' });
    // Second call follows the same code path — `claimDeleteAttempt`
    // refuses (status='deleted'); the in-flight gate must NOT fire.
    const second = await fixture.service.deleteArtifact({
      userId: USER, id: artifactId, policy: 'artifact_only',
    });
    expect(second.artifact.status).toBe('deleted');
    expect(second.cascadedDocumentIds).toEqual([]);
  });
});
