/**
 * Temporal correctness tests for the claim/version system.
 *
 * Validates that:
 * 1. Superseded claims hide stale facts from current search
 * 2. Historical recall returns old versions at past timestamps
 * 3. Clarification gating preserves the original when uncertain
 * 4. Topic isolation prevents cross-contamination during mutations
 * 5. Recovery from clarification to confirmed update works cleanly
 *
 * Uses deterministic vectors (no LLM); modeled after contradiction-dataset.json
 * and mutation-safety-dataset.ts scenarios.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../pool.js';
import { createIntegrationTestContext, unitVector, offsetVector } from './test-fixtures.js';

const TEST_USER = 'temporal-correctness-user';

describe('temporal correctness', () => {
  const { repo, claimRepo } = createIntegrationTestContext(pool, { beforeAll, beforeEach, afterAll });

  /** Store a memory and create an initial claim version for it. */
  async function storeMemoryWithClaim(content: string, embedding: number[], importance: number, createdAt?: Date) {
    const memId = await repo.storeMemory({
      userId: TEST_USER, content, embedding, importance, sourceSite: 'test',
      ...(createdAt ? { createdAt } : {}),
    });
    const claimId = await claimRepo.createClaim(TEST_USER, 'fact');
    const versionId = await claimRepo.createClaimVersion({
      claimId, userId: TEST_USER, memoryId: memId, content, embedding,
      importance, sourceSite: 'test', validFrom: new Date('2026-01-05'),
      provenance: { mutationType: 'add' },
    });
    await claimRepo.setClaimCurrentVersion(claimId, versionId);
    return { memId, claimId, versionId };
  }

  /** Create a Berlin->London supersession scenario. */
  async function createCitySupersession(params: {
    berlinEmbed: number[]; londonEmbed: number[];
    contradictionConfidence?: number; berlinCreatedAt?: Date;
  }) {
    const berlin = await storeMemoryWithClaim('User lives in Berlin', params.berlinEmbed, 0.8, params.berlinCreatedAt);
    await repo.expireMemory(TEST_USER, berlin.memId);

    const londonMemId = await repo.storeMemory({
      userId: TEST_USER, content: 'User now lives in London', embedding: params.londonEmbed,
      importance: 0.85, sourceSite: 'test',
      ...(params.berlinCreatedAt ? { createdAt: new Date('2026-03-01') } : {}),
    });
    const supersedeProv: Record<string, unknown> = {
      mutationType: 'supersede', previousVersionId: berlin.versionId,
    };
    if (params.contradictionConfidence != null) {
      supersedeProv.contradictionConfidence = params.contradictionConfidence;
    }
    const londonVersionId = await claimRepo.createClaimVersion({
      claimId: berlin.claimId, userId: TEST_USER, memoryId: londonMemId,
      content: 'User now lives in London', embedding: params.londonEmbed,
      importance: 0.85, sourceSite: 'test', validFrom: new Date('2026-03-01'),
      provenance: supersedeProv as any,
    });
    await claimRepo.supersedeClaimVersion(TEST_USER, berlin.versionId, londonVersionId, new Date('2026-03-01'));
    await claimRepo.setClaimCurrentVersion(berlin.claimId, londonVersionId);
    return { claimId: berlin.claimId, berlinVersionId: berlin.versionId, londonVersionId };
  }

  describe('current-vs-historical fact priority', () => {
    it('superseded city fact is hidden from current search', async () => {
      const berlinEmbed = unitVector(101);
      const londonEmbed = offsetVector(berlinEmbed, 13, 0.01);

      await createCitySupersession({
        berlinEmbed,
        londonEmbed,
        contradictionConfidence: 0.96,
        berlinCreatedAt: new Date('2026-01-05'),
      });

      const query = offsetVector(londonEmbed, 41, 0.002);
      const results = await repo.searchSimilar(TEST_USER, query, 5, 'test');

      expect(results[0].content).toContain('London');
      expect(results.some((r) => r.content.includes('Berlin'))).toBe(false);
    });

    it('historical recall returns Berlin before supersession date', async () => {
      const berlinEmbed = unitVector(102);
      const londonEmbed = offsetVector(berlinEmbed, 17, 0.01);

      await createCitySupersession({ berlinEmbed, londonEmbed });

      const query = offsetVector(berlinEmbed, 43, 0.002);
      const beforeSupersession = await claimRepo.searchClaimVersions(
        TEST_USER, query, 5, '2026-02-01T00:00:00.000Z', 'test',
      );
      const afterSupersession = await claimRepo.searchClaimVersions(
        TEST_USER, query, 5, '2026-04-01T00:00:00.000Z', 'test',
      );

      expect(beforeSupersession[0].content).toContain('Berlin');
      expect(afterSupersession[0].content).toContain('London');
    });
  });

  describe('clarification gating', () => {
    it('uncertain contradiction creates needs_clarification without overwriting', async () => {
      const birthdayEmbed = unitVector(111);

      const origMemId = await repo.storeMemory({
        userId: TEST_USER,
        content: 'User birthday is June 15',
        embedding: birthdayEmbed,
        importance: 0.95,
        sourceSite: 'test',
      });
      const claimId = await claimRepo.createClaim(TEST_USER, 'fact');
      const origVersionId = await claimRepo.createClaimVersion({
        claimId,
        userId: TEST_USER,
        memoryId: origMemId,
        content: 'User birthday is June 15',
        embedding: birthdayEmbed,
        importance: 0.95,
        sourceSite: 'test',
        validFrom: new Date('2026-01-01'),
        provenance: { mutationType: 'add' },
      });
      await claimRepo.setClaimCurrentVersion(claimId, origVersionId);

      const clarifyEmbed = offsetVector(birthdayEmbed, 23, 0.005);
      await repo.storeMemory({
        userId: TEST_USER,
        content: 'Uncertain: birthday may be June 16, needs clarification',
        embedding: clarifyEmbed,
        importance: 0.6,
        sourceSite: 'test',
        status: 'needs_clarification',
      });
      const clarifyVersionId = await claimRepo.createClaimVersion({
        claimId,
        userId: TEST_USER,
        content: 'Uncertain: birthday may be June 16, needs clarification',
        embedding: clarifyEmbed,
        importance: 0.6,
        sourceSite: 'test',
        validFrom: new Date('2026-02-15'),
        provenance: { mutationType: 'clarify' as any },
      });
      await claimRepo.setClaimCurrentVersion(claimId, clarifyVersionId, 'active');

      const clarCount = await repo.countNeedsClarification(TEST_USER);
      expect(clarCount).toBeGreaterThanOrEqual(1);

      const claim = await claimRepo.getClaim(claimId, TEST_USER);
      expect(claim?.status).toBe('active');

      const query = offsetVector(birthdayEmbed, 29, 0.002);
      const beforeConflict = await claimRepo.searchClaimVersions(
        TEST_USER, query, 5, '2026-02-01T00:00:00.000Z', 'test',
      );
      expect(beforeConflict[0].content).toContain('June 15');
    });
  });

  describe('topic isolation', () => {
    it('superseding dog breed does not affect cat memory', async () => {
      const dogEmbed = unitVector(121);
      const catEmbed = unitVector(131);

      const dogMemId = await repo.storeMemory({
        userId: TEST_USER,
        content: 'User dog Luna is a golden retriever',
        embedding: dogEmbed,
        importance: 0.7,
        sourceSite: 'test',
      });
      const catMemId = await repo.storeMemory({
        userId: TEST_USER,
        content: 'User cat is named Pixel',
        embedding: catEmbed,
        importance: 0.7,
        sourceSite: 'test',
      });

      const dogClaimId = await claimRepo.createClaim(TEST_USER, 'pet');
      const dogV1 = await claimRepo.createClaimVersion({
        claimId: dogClaimId,
        userId: TEST_USER,
        memoryId: dogMemId,
        content: 'User dog Luna is a golden retriever',
        embedding: dogEmbed,
        importance: 0.7,
        sourceSite: 'test',
        validFrom: new Date('2026-01-12'),
        provenance: { mutationType: 'add' },
      });
      await claimRepo.setClaimCurrentVersion(dogClaimId, dogV1);

      const catClaimId = await claimRepo.createClaim(TEST_USER, 'pet');
      const catV1 = await claimRepo.createClaimVersion({
        claimId: catClaimId,
        userId: TEST_USER,
        memoryId: catMemId,
        content: 'User cat is named Pixel',
        embedding: catEmbed,
        importance: 0.7,
        sourceSite: 'test',
        validFrom: new Date('2026-01-12'),
        provenance: { mutationType: 'add' },
      });
      await claimRepo.setClaimCurrentVersion(catClaimId, catV1);

      await repo.expireMemory(TEST_USER, dogMemId);
      const newDogEmbed = offsetVector(dogEmbed, 19, 0.01);
      const newDogMemId = await repo.storeMemory({
        userId: TEST_USER,
        content: 'User dog Luna is a labradoodle',
        embedding: newDogEmbed,
        importance: 0.8,
        sourceSite: 'test',
      });
      const dogV2 = await claimRepo.createClaimVersion({
        claimId: dogClaimId,
        userId: TEST_USER,
        memoryId: newDogMemId,
        content: 'User dog Luna is a labradoodle',
        embedding: newDogEmbed,
        importance: 0.8,
        sourceSite: 'test',
        validFrom: new Date('2026-03-10'),
        provenance: {
          mutationType: 'supersede',
          previousVersionId: dogV1,
          contradictionConfidence: 0.9,
        },
      });
      await claimRepo.supersedeClaimVersion(TEST_USER, dogV1, dogV2, new Date('2026-03-10'));
      await claimRepo.setClaimCurrentVersion(dogClaimId, dogV2);

      const dogQuery = offsetVector(newDogEmbed, 37, 0.002);
      const dogResults = await repo.searchSimilar(TEST_USER, dogQuery, 5, 'test');
      expect(dogResults[0].content).toContain('labradoodle');
      expect(dogResults.some((r) => r.content.includes('golden retriever'))).toBe(false);

      const catQuery = offsetVector(catEmbed, 41, 0.002);
      const catResults = await repo.searchSimilar(TEST_USER, catQuery, 5, 'test');
      expect(catResults.some((r) => r.content.includes('Pixel'))).toBe(true);
    });
  });

  describe('clarification recovery', () => {
    it('confirmed update resolves clarification and surfaces latest fact', async () => {
      const phoneEmbed = unitVector(141);

      const origMemId = await repo.storeMemory({
        userId: TEST_USER,
        content: 'User phone number is 555-1111',
        embedding: phoneEmbed,
        importance: 0.75,
        sourceSite: 'test',
      });
      const claimId = await claimRepo.createClaim(TEST_USER, 'fact');
      const origVersion = await claimRepo.createClaimVersion({
        claimId,
        userId: TEST_USER,
        memoryId: origMemId,
        content: 'User phone number is 555-1111',
        embedding: phoneEmbed,
        importance: 0.75,
        sourceSite: 'test',
        validFrom: new Date('2026-01-05'),
        provenance: { mutationType: 'add' },
      });
      await claimRepo.setClaimCurrentVersion(claimId, origVersion);

      const clarifyEmbed = offsetVector(phoneEmbed, 31, 0.005);
      await repo.storeMemory({
        userId: TEST_USER,
        content: 'Uncertain: phone may be 555-1112, needs clarification',
        embedding: clarifyEmbed,
        importance: 0.55,
        sourceSite: 'test',
        status: 'needs_clarification',
      });
      const clarifyVersion = await claimRepo.createClaimVersion({
        claimId,
        userId: TEST_USER,
        content: 'Uncertain: phone may be 555-1112, needs clarification',
        embedding: clarifyEmbed,
        importance: 0.55,
        sourceSite: 'test',
        validFrom: new Date('2026-02-01'),
        provenance: { mutationType: 'clarify' as any },
      });
      await claimRepo.setClaimCurrentVersion(claimId, clarifyVersion, 'active');

      const clarCountBefore = await repo.countNeedsClarification(TEST_USER);
      expect(clarCountBefore).toBeGreaterThanOrEqual(1);

      await repo.expireMemory(TEST_USER, origMemId);
      const finalEmbed = offsetVector(phoneEmbed, 47, 0.01);
      const finalMemId = await repo.storeMemory({
        userId: TEST_USER,
        content: 'User phone number is 555-9999',
        embedding: finalEmbed,
        importance: 0.8,
        sourceSite: 'test',
      });
      await claimRepo.supersedeClaimVersion(
        TEST_USER, origVersion, null, new Date('2026-02-10'),
      );
      await claimRepo.supersedeClaimVersion(
        TEST_USER, clarifyVersion, null, new Date('2026-02-10'),
      );
      const finalVersion = await claimRepo.createClaimVersion({
        claimId,
        userId: TEST_USER,
        memoryId: finalMemId,
        content: 'User phone number is 555-9999',
        embedding: finalEmbed,
        importance: 0.8,
        sourceSite: 'test',
        validFrom: new Date('2026-02-10'),
        provenance: {
          mutationType: 'supersede',
          previousVersionId: clarifyVersion,
          contradictionConfidence: 0.94,
        },
      });
      await claimRepo.setClaimCurrentVersion(claimId, finalVersion, 'active');

      const claim = await claimRepo.getClaim(claimId, TEST_USER);
      expect(claim?.status).toBe('active');

      const query = offsetVector(finalEmbed, 53, 0.002);
      const results = await repo.searchSimilar(TEST_USER, query, 5, 'test');
      expect(results[0].content).toContain('555-9999');
      expect(results.some((r) => r.content.includes('555-1111'))).toBe(false);

      const history = await claimRepo.getMutationHistory(claimId);
      expect(history).toHaveLength(3);
      expect(history[0].mutation_type).toBe('add');
      expect(history[1].mutation_type).toBe('clarify');
      expect(history[2].mutation_type).toBe('supersede');
    });
  });

  describe('mutation history integrity', () => {
    it('version chain preserves all mutations in chronological order', async () => {
      const embed = unitVector(151);

      const memId = await repo.storeMemory({
        userId: TEST_USER,
        content: 'User prefers VS Code',
        embedding: embed,
        importance: 0.7,
        sourceSite: 'test',
      });
      const claimId = await claimRepo.createClaim(TEST_USER, 'preference');
      const v1 = await claimRepo.createClaimVersion({
        claimId,
        userId: TEST_USER,
        memoryId: memId,
        content: 'User prefers VS Code',
        embedding: embed,
        importance: 0.7,
        sourceSite: 'test',
        validFrom: new Date('2026-01-10'),
        provenance: { mutationType: 'add', actorModel: 'test-harness' },
      });
      await claimRepo.setClaimCurrentVersion(claimId, v1);

      const embed2 = offsetVector(embed, 23, 0.01);
      const newVersionId = await claimRepo.createUpdateVersion({
        oldVersionId: v1,
        claimId,
        userId: TEST_USER,
        memoryId: memId,
        content: 'User prefers Zed',
        embedding: embed2,
        importance: 0.8,
        sourceSite: 'test',
        mutationReason: 'Editor switch',
        actorModel: 'test-harness',
      });

      const history = await claimRepo.getMutationHistory(claimId);
      expect(history).toHaveLength(2);
      expect(history[0].content).toBe('User prefers VS Code');
      expect(history[0].valid_to).not.toBeNull();
      expect(history[1].content).toBe('User prefers Zed');
      expect(history[1].mutation_type).toBe('update');
      expect(history[1].mutation_reason).toBe('Editor switch');
      expect(history[1].previous_version_id).toBe(v1);

      const claim = await claimRepo.getClaim(claimId, TEST_USER);
      expect(claim?.current_version_id).toBe(newVersionId);
    });
  });
});
