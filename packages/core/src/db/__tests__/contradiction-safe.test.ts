/**
 * Acceptance tests for supersession-first contradiction-safe memory.
 * Uses deterministic vectors and repository calls only; no LLM access required.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../pool.js';
import type { MemoryRepository } from '../memory-repository.js';
import type { ClaimRepository } from '../claim-repository.js';
import { createIntegrationTestContext, unitVector, offsetVector } from './test-fixtures.js';

const TEST_USER = 'contradiction-safe-user';

describe('contradiction-safe memory acceptance', () => {
  const { repo, claimRepo } = createIntegrationTestContext(pool, { beforeAll, beforeEach, afterAll });

  it('suppresses stale contradicted facts from current search', async () => {
    const scenario = await seedSupersededClaim(repo, claimRepo);
    const query = offsetVector(scenario.newEmbedding, 31, 0.002);
    const results = await repo.searchSimilar(TEST_USER, query, 5, 'test');

    expect(results[0].content).toContain('dark mode');
    expect(results.some((row) => row.content.includes('light mode'))).toBe(false);
  });

  it('returns the correct version for explicit historical recall', async () => {
    const scenario = await seedSupersededClaim(repo, claimRepo);
    const query = offsetVector(scenario.newEmbedding, 47, 0.003);
    const beforeUpdate = await claimRepo.searchClaimVersions(TEST_USER, query, 5, '2026-02-01T00:00:00.000Z', 'test');
    const afterUpdate = await claimRepo.searchClaimVersions(TEST_USER, query, 5, '2026-04-01T00:00:00.000Z', 'test');

    expect(beforeUpdate[0].content).toContain('light mode');
    expect(afterUpdate[0].content).toContain('dark mode');
  });

  it('records supersession history without deleting the old version record', async () => {
    const scenario = await seedSupersededClaim(repo, claimRepo);
    const claim = await claimRepo.getClaim(scenario.claimId, TEST_USER);
    const versions = await claimRepo.listClaimVersions(scenario.claimId);

    expect(claim?.current_version_id).toBe(scenario.newVersionId);
    expect(claim?.valid_at.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(claim?.invalid_at).toBeNull();
    expect(claim?.invalidated_at).toBeNull();
    expect(claim?.invalidated_by_version_id).toBeNull();
    expect(versions).toHaveLength(2);
    expect(versions[0].valid_to?.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(versions[0].superseded_by_version_id).toBe(scenario.newVersionId);
    expect(versions[1].valid_to).toBeNull();
  });

  it('marks deleted claims invalid without removing their prior history', async () => {
    const scenario = await seedDeletedClaim(repo, claimRepo);
    const claim = await claimRepo.getClaim(scenario.claimId, TEST_USER);
    const beforeDelete = await claimRepo.getClaimVersionAtTime(
      scenario.claimId,
      TEST_USER,
      '2026-02-15T00:00:00.000Z',
    );
    const afterDelete = await claimRepo.getClaimVersionAtTime(
      scenario.claimId,
      TEST_USER,
      '2026-04-01T00:00:00.000Z',
    );

    expect(claim?.current_version_id).toBeNull();
    expect(claim?.status).toBe('deleted');
    expect(claim?.invalid_at?.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(claim?.invalidated_at).not.toBeNull();
    expect(claim?.invalidated_by_version_id).toBe(scenario.deleteVersionId);
    expect(beforeDelete?.id).toBe(scenario.activeVersionId);
    expect(afterDelete).toBeNull();
  });

  it('caps duplicate inflation at one active projection per claim', async () => {
    const embedding = unitVector(91);
    const memoryId = await repo.storeMemory({
      userId: TEST_USER,
      content: 'User prefers Rust for systems programming',
      embedding,
      importance: 0.9,
      sourceSite: 'test',
    });
    const claimId = await claimRepo.createClaim(TEST_USER, 'preference');
    const versionId = await claimRepo.createClaimVersion({
      claimId,
      userId: TEST_USER,
      memoryId,
      content: 'User prefers Rust for systems programming',
      embedding,
      importance: 0.9,
      sourceSite: 'test',
      validFrom: new Date('2026-01-10T00:00:00.000Z'),
    });

    await claimRepo.setClaimCurrentVersion(claimId, versionId);
    await claimRepo.addEvidence({ claimVersionId: versionId, memoryId, quoteText: 'First mention' });
    await claimRepo.addEvidence({ claimVersionId: versionId, memoryId, quoteText: 'Second paraphrase' });
    await claimRepo.addEvidence({ claimVersionId: versionId, memoryId, quoteText: 'Third paraphrase' });

    const activeMemories = await repo.countMemories(TEST_USER);
    const claimCount = await claimRepo.countClaims(TEST_USER);
    const openVersions = await claimRepo.countOpenClaimVersions(claimId);

    expect(activeMemories).toBe(1);
    expect(claimCount).toBe(1);
    expect(openVersions).toBe(1);
    expect(activeMemories / claimCount).toBeLessThanOrEqual(1.1);
  });

  it('retrieves the active claim target by deterministic relation slot', async () => {
    const embedding = unitVector(93);
    const memoryId = await repo.storeMemory({
      userId: TEST_USER,
      content: 'Jake works at OpenAI',
      embedding,
      importance: 0.8,
      sourceSite: 'test',
    });
    const slot = {
      slotKey: 'relation:11111111-1111-4111-8111-111111111111:works_at:22222222-2222-4222-8222-222222222222',
      subjectEntityId: '11111111-1111-4111-8111-111111111111',
      relationType: 'works_at' as const,
      objectEntityId: '22222222-2222-4222-8222-222222222222',
    };
    const claimId = await claimRepo.createClaim(TEST_USER, 'person', new Date('2026-01-15T00:00:00.000Z'), slot);
    const versionId = await claimRepo.createClaimVersion({
      claimId,
      userId: TEST_USER,
      memoryId,
      content: 'Jake works at OpenAI',
      embedding,
      importance: 0.8,
      sourceSite: 'test',
      validFrom: new Date('2026-01-15T00:00:00.000Z'),
    });

    await claimRepo.setClaimCurrentVersion(claimId, versionId);
    const target = await claimRepo.getActiveClaimTargetBySlot(TEST_USER, slot.slotKey);

    expect(target).toEqual({
      claimId,
      versionId,
      memoryId,
    });
  });

  describe('mutation provenance', () => {
    it('records ADD provenance on initial claim version', async () => {
      const embedding = unitVector(51);
      const memoryId = await repo.storeMemory({
        userId: TEST_USER, content: 'User likes TypeScript', embedding, importance: 0.7, sourceSite: 'test',
      });
      const claimId = await claimRepo.createClaim(TEST_USER, 'preference');
      const versionId = await claimRepo.createClaimVersion({
        claimId, userId: TEST_USER, memoryId, content: 'User likes TypeScript', embedding,
        importance: 0.7, sourceSite: 'test',
        provenance: { mutationType: 'add', actorModel: 'gpt-4o-mini' },
      });

      const versions = await claimRepo.getMutationHistory(claimId);
      expect(versions).toHaveLength(1);
      expect(versions[0].mutation_type).toBe('add');
      expect(versions[0].actor_model).toBe('gpt-4o-mini');
      expect(versions[0].mutation_reason).toBeNull();
      expect(versions[0].previous_version_id).toBeNull();
    });

    it('createUpdateVersion preserves old version with provenance chain', async () => {
      const oldEmbed = unitVector(61);
      const newEmbed = offsetVector(oldEmbed, 23, 0.01);
      const memoryId = await repo.storeMemory({
        userId: TEST_USER, content: 'User prefers VS Code', embedding: oldEmbed, importance: 0.7, sourceSite: 'test',
      });
      const claimId = await claimRepo.createClaim(TEST_USER, 'preference');
      const oldVersionId = await claimRepo.createClaimVersion({
        claimId, userId: TEST_USER, memoryId, content: 'User prefers VS Code', embedding: oldEmbed,
        importance: 0.7, sourceSite: 'test', validFrom: new Date('2026-01-01'),
        provenance: { mutationType: 'add', actorModel: 'gpt-4o-mini' },
      });
      await claimRepo.setClaimCurrentVersion(claimId, oldVersionId);

      const newVersionId = await claimRepo.createUpdateVersion({
        oldVersionId, claimId, userId: TEST_USER, memoryId,
        content: 'User prefers Cursor over VS Code', embedding: newEmbed,
        importance: 0.8, sourceSite: 'test',
        mutationReason: 'User switched editors', actorModel: 'gpt-4o-mini',
      });

      const versions = await claimRepo.getMutationHistory(claimId);
      expect(versions).toHaveLength(2);

      const old = versions[0];
      expect(old.content).toBe('User prefers VS Code');
      expect(old.valid_to).not.toBeNull();
      expect(old.superseded_by_version_id).toBe(newVersionId);
      expect(old.memory_id).toBeNull();

      const updated = versions[1];
      expect(updated.id).toBe(newVersionId);
      expect(updated.content).toBe('User prefers Cursor over VS Code');
      expect(updated.mutation_type).toBe('update');
      expect(updated.mutation_reason).toBe('User switched editors');
      expect(updated.previous_version_id).toBe(oldVersionId);
      expect(updated.actor_model).toBe('gpt-4o-mini');
      expect(updated.valid_to).toBeNull();
      expect(updated.memory_id).toBe(memoryId);

      const claim = await claimRepo.getClaim(claimId, TEST_USER);
      expect(claim?.current_version_id).toBe(newVersionId);
    });

    it('findClaimByMemoryId traces back through version history', async () => {
      const embedding = unitVector(71);
      const memoryId = await repo.storeMemory({
        userId: TEST_USER, content: 'User lives in NYC', embedding, importance: 0.8, sourceSite: 'test',
      });
      const claimId = await claimRepo.createClaim(TEST_USER, 'fact');
      const versionId = await claimRepo.createClaimVersion({
        claimId, userId: TEST_USER, memoryId, content: 'User lives in NYC', embedding,
        importance: 0.8, sourceSite: 'test',
        provenance: { mutationType: 'add', actorModel: 'gpt-4o-mini' },
      });
      await claimRepo.setClaimCurrentVersion(claimId, versionId);

      const found = await claimRepo.findClaimByMemoryId(TEST_USER, memoryId);
      expect(found).not.toBeNull();
      expect(found!.claimId).toBe(claimId);
      expect(found!.versions).toHaveLength(1);
      expect(found!.versions[0].content).toBe('User lives in NYC');
    });

    it('supersede provenance records contradiction confidence', async () => {
      const oldEmbed = unitVector(81);
      const newEmbed = offsetVector(oldEmbed, 37, 0.01);
      const oldMemoryId = await repo.storeMemory({
        userId: TEST_USER, content: 'User is vegetarian', embedding: oldEmbed, importance: 0.9, sourceSite: 'test',
      });
      const claimId = await claimRepo.createClaim(TEST_USER, 'fact');
      const oldVersionId = await claimRepo.createClaimVersion({
        claimId, userId: TEST_USER, memoryId: oldMemoryId, content: 'User is vegetarian', embedding: oldEmbed,
        importance: 0.9, sourceSite: 'test', validFrom: new Date('2026-01-01'),
        provenance: { mutationType: 'add', actorModel: 'gpt-4o-mini' },
      });
      await claimRepo.setClaimCurrentVersion(claimId, oldVersionId);

      const newMemoryId = await repo.storeMemory({
        userId: TEST_USER, content: 'User is now vegan', embedding: newEmbed, importance: 0.9, sourceSite: 'test',
      });
      const newVersionId = await claimRepo.createClaimVersion({
        claimId, userId: TEST_USER, memoryId: newMemoryId, content: 'User is now vegan', embedding: newEmbed,
        importance: 0.9, sourceSite: 'test', validFrom: new Date('2026-03-01'),
        provenance: {
          mutationType: 'supersede',
          mutationReason: 'Diet changed from vegetarian to vegan',
          previousVersionId: oldVersionId,
          actorModel: 'gpt-4o-mini',
          contradictionConfidence: 0.92,
        },
      });
      await claimRepo.supersedeClaimVersion(TEST_USER, oldVersionId, newVersionId, new Date('2026-03-01'));
      await claimRepo.setClaimCurrentVersion(claimId, newVersionId);

      const versions = await claimRepo.getMutationHistory(claimId);
      expect(versions).toHaveLength(2);

      const superseded = versions[1];
      expect(superseded.mutation_type).toBe('supersede');
      expect(superseded.contradiction_confidence).toBeCloseTo(0.92);
      expect(superseded.previous_version_id).toBe(oldVersionId);
      expect(superseded.mutation_reason).toBe('Diet changed from vegetarian to vegan');
    });
  });
});

async function seedSupersededClaim(repo: MemoryRepository, claimRepo: ClaimRepository) {
  const oldEmbedding = unitVector(11);
  const newEmbedding = offsetVector(oldEmbedding, 19, 0.01);
  const claimId = await claimRepo.createClaim(TEST_USER, 'preference');
  const oldMemoryId = await repo.storeMemory({
    userId: TEST_USER,
    content: 'User prefers light mode',
    embedding: oldEmbedding,
    importance: 0.7,
    sourceSite: 'test',
  });
  const oldVersionId = await claimRepo.createClaimVersion({
    claimId,
    userId: TEST_USER,
    memoryId: oldMemoryId,
    content: 'User prefers light mode',
    embedding: oldEmbedding,
    importance: 0.7,
    sourceSite: 'test',
    validFrom: new Date('2026-01-01T00:00:00.000Z'),
  });

  await claimRepo.setClaimCurrentVersion(claimId, oldVersionId);
  await repo.expireMemory(TEST_USER, oldMemoryId);

  const newMemoryId = await repo.storeMemory({
    userId: TEST_USER,
    content: 'User prefers dark mode',
    embedding: newEmbedding,
    importance: 0.8,
    sourceSite: 'test',
  });
  const newVersionId = await claimRepo.createClaimVersion({
    claimId,
    userId: TEST_USER,
    memoryId: newMemoryId,
    content: 'User prefers dark mode',
    embedding: newEmbedding,
    importance: 0.8,
    sourceSite: 'test',
    validFrom: new Date('2026-03-01T00:00:00.000Z'),
  });

  await claimRepo.supersedeClaimVersion(TEST_USER, oldVersionId, newVersionId, new Date('2026-03-01T00:00:00.000Z'));
  await claimRepo.setClaimCurrentVersion(claimId, newVersionId);

  return { claimId, newEmbedding, newVersionId };
}

async function seedDeletedClaim(repo: MemoryRepository, claimRepo: ClaimRepository) {
  const embedding = unitVector(29);
  const deletionTime = new Date('2026-03-01T00:00:00.000Z');
  const memoryId = await repo.storeMemory({
    userId: TEST_USER,
    content: 'User works from the office on Fridays',
    embedding,
    importance: 0.6,
    sourceSite: 'test',
  });
  const claimId = await claimRepo.createClaim(TEST_USER, 'schedule', new Date('2026-01-01T00:00:00.000Z'));
  const activeVersionId = await claimRepo.createClaimVersion({
    claimId,
    userId: TEST_USER,
    memoryId,
    content: 'User works from the office on Fridays',
    embedding,
    importance: 0.6,
    sourceSite: 'test',
    validFrom: new Date('2026-01-01T00:00:00.000Z'),
  });
  await claimRepo.setClaimCurrentVersion(claimId, activeVersionId, 'active', new Date('2026-01-01T00:00:00.000Z'));

  const deleteVersionId = await claimRepo.createClaimVersion({
    claimId,
    userId: TEST_USER,
    content: '[DELETED] User works from the office on Fridays',
    embedding,
    importance: 0,
    sourceSite: 'test',
    validFrom: deletionTime,
    provenance: { mutationType: 'delete', previousVersionId: activeVersionId },
  });
  await claimRepo.supersedeClaimVersion(TEST_USER, activeVersionId, deleteVersionId, deletionTime);
  await claimRepo.invalidateClaim(TEST_USER, claimId, deletionTime, deleteVersionId);

  return { claimId, activeVersionId, deleteVersionId };
}

// unitVector and offsetVector imported from test-fixtures.ts
