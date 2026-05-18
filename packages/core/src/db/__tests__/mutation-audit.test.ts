/**
 * Integration tests for mutation audit trail (Phase 4).
 * Validates mutation summary, reversal chain traversal, recent mutations,
 * and single-memory audit trail lifecycle inspection.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../../config.js';
import { pool } from '../pool.js';
import type { MemoryRepository } from '../memory-repository.js';
import type { ClaimRepository } from '../claim-repository.js';
import { createIntegrationTestContext, unitVector, offsetVector } from './test-fixtures.js';

const TEST_USER = 'mutation-audit-user';

describe('mutation audit trail', () => {
  const { repo, claimRepo } = createIntegrationTestContext(pool, { beforeAll, beforeEach, afterAll });

  describe('getUserMutationSummary', () => {
    it('returns zero counts for a user with no mutations', async () => {
      const summary = await claimRepo.getUserMutationSummary(TEST_USER);

      expect(summary.totalVersions).toBe(0);
      expect(summary.activeVersions).toBe(0);
      expect(summary.supersededVersions).toBe(0);
      expect(summary.totalClaims).toBe(0);
      expect(Object.keys(summary.byMutationType)).toHaveLength(0);
    });

    it('counts mutations by type', async () => {
      await seedMutationHistory(repo, claimRepo);
      const summary = await claimRepo.getUserMutationSummary(TEST_USER);

      expect(summary.totalVersions).toBe(3);
      expect(summary.totalClaims).toBe(1);
      expect(summary.byMutationType.add).toBe(1);
      expect(summary.byMutationType.update).toBe(1);
      expect(summary.byMutationType.supersede).toBe(1);
    });

    it('distinguishes active from superseded versions', async () => {
      await seedMutationHistory(repo, claimRepo);
      const summary = await claimRepo.getUserMutationSummary(TEST_USER);

      expect(summary.activeVersions).toBe(1);
      expect(summary.supersededVersions).toBe(2);
    });
  });

  describe('getReversalChain', () => {
    it('traces forward through supersession chain', async () => {
      const history = await seedMutationHistory(repo, claimRepo);
      const chain = await claimRepo.getReversalChain(TEST_USER, history.v1Id);

      expect(chain).toHaveLength(3);
      expect(chain[0].content).toBe('User prefers Python');
      expect(chain[1].content).toBe('User prefers Python 3.11');
      expect(chain[2].content).toBe('User switched to Rust');
    });

    it('returns single version when no supersession exists', async () => {
      const history = await seedMutationHistory(repo, claimRepo);
      const chain = await claimRepo.getReversalChain(TEST_USER, history.v3Id);

      expect(chain).toHaveLength(1);
      expect(chain[0].content).toBe('User switched to Rust');
    });

    it('respects maxDepth limit', async () => {
      const history = await seedMutationHistory(repo, claimRepo);
      const chain = await claimRepo.getReversalChain(TEST_USER, history.v1Id, 2);

      expect(chain).toHaveLength(2);
    });

    it('returns empty array for non-existent version', async () => {
      const chain = await claimRepo.getReversalChain(TEST_USER, '00000000-0000-0000-0000-000000000000');

      expect(chain).toHaveLength(0);
    });
  });

  describe('getRecentMutations', () => {
    it('returns mutations ordered newest first', async () => {
      await seedMutationHistory(repo, claimRepo);
      const recent = await claimRepo.getRecentMutations(TEST_USER, 10);

      expect(recent).toHaveLength(3);
      expect(recent[0].mutation_type).toBe('supersede');
      expect(recent[1].mutation_type).toBe('update');
      expect(recent[2].mutation_type).toBe('add');
    });

    it('respects limit parameter', async () => {
      await seedMutationHistory(repo, claimRepo);
      const recent = await claimRepo.getRecentMutations(TEST_USER, 1);

      expect(recent).toHaveLength(1);
      expect(recent[0].mutation_type).toBe('supersede');
    });

    it('returns empty for user with no mutations', async () => {
      const recent = await claimRepo.getRecentMutations(TEST_USER, 10);
      expect(recent).toHaveLength(0);
    });
  });

  describe('findClaimByMemoryId audit trail', () => {
    it('returns full version history for a memory', async () => {
      const history = await seedMutationHistory(repo, claimRepo);
      const found = await claimRepo.findClaimByMemoryId(TEST_USER, history.mem3Id);

      expect(found).not.toBeNull();
      expect(found!.versions).toHaveLength(3);
      expect(found!.versions[0].mutation_type).toBe('add');
      expect(found!.versions[1].mutation_type).toBe('update');
      expect(found!.versions[2].mutation_type).toBe('supersede');
    });

    it('includes provenance details in version history', async () => {
      const history = await seedMutationHistory(repo, claimRepo);
      const found = await claimRepo.findClaimByMemoryId(TEST_USER, history.mem3Id);

      const supersedeVersion = found!.versions[2];
      expect(supersedeVersion.mutation_reason).toContain('Switched to Rust');
      expect(supersedeVersion.actor_model).toBe('test-model');
      expect(supersedeVersion.contradiction_confidence).toBeCloseTo(0.85);
      expect(supersedeVersion.previous_version_id).toBe(history.v2Id);
    });
  });
});

/**
 * Seeds a 3-version mutation history:
 * v1 (ADD): "User prefers Python"
 * v2 (UPDATE): "User prefers Python 3.11"
 * v3 (SUPERSEDE): "User switched to Rust"
 */
async function seedMutationHistory(repo: MemoryRepository, claimRepo: ClaimRepository) {
  const embed1 = unitVector(11);
  const embed2 = offsetVector(embed1, 7, 0.01);
  const embed3 = unitVector(21);

  const mem1Id = await repo.storeMemory({
    userId: TEST_USER, content: 'User prefers Python', embedding: embed1,
    importance: 0.7, sourceSite: 'test',
  });
  const claimId = await claimRepo.createClaim(TEST_USER, 'preference');
  const v1Id = await claimRepo.createClaimVersion({
    claimId, userId: TEST_USER, memoryId: mem1Id, content: 'User prefers Python',
    embedding: embed1, importance: 0.7, sourceSite: 'test',
    validFrom: new Date('2026-01-01'),
    provenance: { mutationType: 'add', actorModel: 'test-model' },
  });
  await claimRepo.setClaimCurrentVersion(claimId, v1Id);

  const v2Id = await claimRepo.createUpdateVersion({
    oldVersionId: v1Id, claimId, userId: TEST_USER, memoryId: mem1Id,
    content: 'User prefers Python 3.11', embedding: embed2,
    importance: 0.7, sourceSite: 'test',
    mutationReason: 'Specified version', actorModel: 'test-model',
  });

  await repo.expireMemory(TEST_USER, mem1Id);
  const mem3Id = await repo.storeMemory({
    userId: TEST_USER, content: 'User switched to Rust', embedding: embed3,
    importance: 0.8, sourceSite: 'test',
  });
  const v3Id = await claimRepo.createClaimVersion({
    claimId, userId: TEST_USER, memoryId: mem3Id, content: 'User switched to Rust',
    embedding: embed3, importance: 0.8, sourceSite: 'test',
    provenance: {
      mutationType: 'supersede',
      mutationReason: 'Switched to Rust from Python',
      previousVersionId: v2Id,
      actorModel: 'test-model',
      contradictionConfidence: 0.85,
    },
  });
  await claimRepo.supersedeClaimVersion(TEST_USER, v2Id, v3Id);
  await claimRepo.setClaimCurrentVersion(claimId, v3Id);

  return { claimId, mem1Id, mem3Id, v1Id, v2Id, v3Id };
}

// unitVector and offsetVector imported from test-fixtures.ts
