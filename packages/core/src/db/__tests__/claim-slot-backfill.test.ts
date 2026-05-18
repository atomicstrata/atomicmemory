/**
 * Integration tests for deterministic claim-slot backfill on legacy claims.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setupTestSchema } from './test-fixtures.js';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../../config.js';
import { ClaimRepository } from '../claim-repository.js';
import { EntityRepository } from '../repository-entities.js';
import { pool } from '../pool.js';
import { MemoryRepository } from '../memory-repository.js';
import { MemoryService } from '../../services/memory-service.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_USER = 'claim-slot-backfill-user';

describe('claim slot backfill', () => {
  const repo = new MemoryRepository(pool);
  const claimRepo = new ClaimRepository(pool);
  const entityRepo = new EntityRepository(pool);
  const service = new MemoryService(repo, claimRepo, entityRepo);

  beforeAll(async () => {
    await setupTestSchema(pool);
  });

  beforeEach(async () => {
    await entityRepo.deleteAll();
    await claimRepo.deleteAll();
    await repo.deleteAll();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('fills relation-backed slot metadata for active legacy claims', async () => {
    const memoryId = await repo.storeMemory({
      userId: TEST_USER,
      content: 'Jake works at OpenAI',
      embedding: unitVector(11),
      importance: 0.8,
      sourceSite: 'test',
    });
    const personId = await entityRepo.resolveEntity({
      userId: TEST_USER,
      name: 'Jake',
      entityType: 'person',
      embedding: unitVector(12),
    });
    const orgId = await entityRepo.resolveEntity({
      userId: TEST_USER,
      name: 'OpenAI',
      entityType: 'organization',
      embedding: unitVector(13),
    });
    await entityRepo.upsertRelation({
      userId: TEST_USER,
      sourceEntityId: personId,
      targetEntityId: orgId,
      relationType: 'works_at',
      sourceMemoryId: memoryId,
    });
    await entityRepo.linkMemoryToEntity(memoryId, personId);
    await entityRepo.linkMemoryToEntity(memoryId, orgId);

    const claimId = await claimRepo.createClaim(TEST_USER, 'person');
    const versionId = await claimRepo.createClaimVersion({
      claimId,
      userId: TEST_USER,
      memoryId,
      content: 'Jake works at OpenAI',
      embedding: unitVector(11),
      importance: 0.8,
      sourceSite: 'test',
    });
    await claimRepo.setClaimCurrentVersion(claimId, versionId);

    const result = await service.backfillClaimSlots(TEST_USER);
    const claim = await claimRepo.getClaim(claimId, TEST_USER);

    expect(result).toEqual({ scanned: 1, updated: 1 });
    expect(claim?.slot_key).toBe(`relation:${personId}:works_at:${orgId}`);
    expect(claim?.subject_entity_id).toBe(personId);
    expect(claim?.relation_type).toBe('works_at');
    expect(claim?.object_entity_id).toBe(orgId);
  });
});

function unitVector(seed: number): number[] {
  const values = Array.from({ length: config.embeddingDimensions }, (_, i) => Math.sin(seed * (i + 1)));
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  return values.map((value) => value / norm);
}
