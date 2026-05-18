/**
 * @file Integration tests for `recordStorageUploadRecoveryHint`.
 *
 * Requires DATABASE_URL in `.env.test`. Exercises the CAS guard,
 * envelope shape, owner-scoping, and the no-raw-documents-row
 * requirement (recovery hints work against direct-storage rows that
 * never get a backing raw_documents row).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearDocumentTables, setupTestSchema } from './test-fixtures.js';
import { pool } from '../pool.js';
import {
  claimPendingArtifact,
  getStorageArtifactById,
  recordUploadedArtifact,
} from '../storage-artifact-repository.js';
import {
  buildRecoveryHintEnvelope,
  recordStorageUploadRecoveryHint,
} from '../storage-artifact-recovery-repository.js';

const USER_A = 'recovery-hint-user-a';
const USER_B = 'recovery-hint-user-b';
const FIXED_NOW = (): Date => new Date('2026-05-13T12:34:56.000Z');

beforeAll(async () => {
  await setupTestSchema(pool);
});

beforeEach(async () => {
  await clearDocumentTables(pool);
});

afterAll(async () => {
  await pool.end();
});

async function claimRow(provider = 'local_fs'): Promise<{ id: string; putAttemptId: string }> {
  const { row, claimId } = await claimPendingArtifact(pool, {
    userId: USER_A,
    provider,
    contentType: 'application/pdf',
  });
  return { id: row.id, putAttemptId: claimId };
}

describe('buildRecoveryHintEnvelope', () => {
  it('produces the documented closed envelope shape', () => {
    const envelope = buildRecoveryHintEnvelope(
      {
        artifactId: 'a',
        userId: USER_A,
        putAttemptId: 'p',
        hint: 'awaiting_provider_readiness',
        message: 'filecoin readiness gate not ready',
        storageProvider: 'filecoin',
      },
      FIXED_NOW,
    );
    expect(envelope).toEqual({
      layer: 'raw_storage',
      code: 'internal_recovery_hint',
      internal_recovery_hint: 'awaiting_provider_readiness',
      message: 'filecoin readiness gate not ready',
      storage_provider: 'filecoin',
      occurred_at: '2026-05-13T12:34:56.000Z',
    });
  });

  it('defaults message to the hint code when none is supplied', () => {
    const envelope = buildRecoveryHintEnvelope(
      { artifactId: 'a', userId: USER_A, putAttemptId: 'p', hint: 'manual_delete_required' },
      FIXED_NOW,
    );
    expect(envelope.message).toBe('manual_delete_required');
    expect(envelope).not.toHaveProperty('storage_provider');
  });
});

describe('recordStorageUploadRecoveryHint — CAS write', () => {
  it('writes the envelope onto last_error when CAS matches', async () => {
    const { id, putAttemptId } = await claimRow();
    const matched = await recordStorageUploadRecoveryHint(
      pool,
      {
        artifactId: id,
        userId: USER_A,
        putAttemptId,
        hint: 'manual_delete_required',
        message: 'operator action required',
        storageProvider: 'local_fs',
      },
      FIXED_NOW,
    );
    expect(matched).toBe(true);
    const row = await getStorageArtifactById(pool, USER_A, id);
    expect(row!.lastError).toEqual({
      layer: 'raw_storage',
      code: 'internal_recovery_hint',
      internal_recovery_hint: 'manual_delete_required',
      message: 'operator action required',
      storage_provider: 'local_fs',
      occurred_at: '2026-05-13T12:34:56.000Z',
    });
  });

  it('leaves status=pending and put_attempt_id unchanged', async () => {
    const { id, putAttemptId } = await claimRow();
    await recordStorageUploadRecoveryHint(pool, {
      artifactId: id,
      userId: USER_A,
      putAttemptId,
      hint: 'manual_delete_required',
    });
    const row = await getStorageArtifactById(pool, USER_A, id);
    expect(row!.status).toBe('pending');
    expect(row!.putAttemptId).toBe(putAttemptId);
  });

  it('returns false when the put_attempt_id does not match (stale claim)', async () => {
    const { id } = await claimRow();
    const matched = await recordStorageUploadRecoveryHint(pool, {
      artifactId: id,
      userId: USER_A,
      putAttemptId: '00000000-0000-0000-0000-000000000000',
      hint: 'manual_delete_required',
    });
    expect(matched).toBe(false);
    const row = await getStorageArtifactById(pool, USER_A, id);
    expect(row!.lastError).toBeNull();
  });

  it('returns false for a cross-user caller and leaves the row untouched', async () => {
    const { id, putAttemptId } = await claimRow();
    const matched = await recordStorageUploadRecoveryHint(pool, {
      artifactId: id,
      userId: USER_B,
      putAttemptId,
      hint: 'manual_delete_required',
    });
    expect(matched).toBe(false);
    const row = await getStorageArtifactById(pool, USER_A, id);
    expect(row!.lastError).toBeNull();
  });

  it('returns false once the row has been finalized (status != pending)', async () => {
    const { id, putAttemptId } = await claimRow();
    const finalized = await recordUploadedArtifact(pool, {
      userId: USER_A,
      artifactId: id,
      putAttemptId,
      uri: 'local-fs:///x/y.bin',
      sizeBytes: 5,
      plaintextHash: 'h'.repeat(64),
      storedHash: 'h'.repeat(64),
      identifiers: {},
      providerDetails: null,
    });
    expect(finalized!.status).toBe('stored');
    const matched = await recordStorageUploadRecoveryHint(pool, {
      artifactId: id,
      userId: USER_A,
      putAttemptId,
      hint: 'manual_delete_required',
    });
    expect(matched).toBe(false);
  });

  it('writes a hint without requiring any raw_documents row', async () => {
    // The setup never inserts into raw_documents; the CAS targets
    // storage_artifacts directly. The plan's no-raw_documents pin is
    // implicit here — claimPendingArtifact + recordStorageUploadRecoveryHint
    // both operate on storage_artifacts alone.
    const { id, putAttemptId } = await claimRow();
    const matched = await recordStorageUploadRecoveryHint(pool, {
      artifactId: id,
      userId: USER_A,
      putAttemptId,
      hint: 'awaiting_provider_readiness',
    });
    expect(matched).toBe(true);
    const rawDocs = await pool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM raw_documents',
    );
    expect(Number.parseInt(rawDocs.rows[0].count, 10)).toBe(0);
  });
});
