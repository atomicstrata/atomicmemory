/**
 * Integration tests for LLM-based consolidation execution (Phase 4).
 * Tests the full flow: cluster identification → LLM synthesis → archive originals.
 * Uses mocked LLM to avoid API calls while testing DB operations.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupTestSchema } from './test-fixtures.js';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('../../services/llm.js', () => ({
  llm: {
    chat: vi.fn().mockResolvedValue(
      'User is a TypeScript developer who prefers strong typing and uses Vitest for testing.',
    ),
  },
}));

vi.mock('../../services/embedding.js', async () => {
  const { config } = await import('../../config.js');
  const { cosineSimilarity } = await import('../../vector-math.js');
  return {
    embedText: vi.fn(async () => Array.from({ length: config.embeddingDimensions }, () => 0.1)),
    embedTexts: vi.fn(async (texts: string[]) =>
      texts.map(() => Array.from({ length: config.embeddingDimensions }, () => 0.1)),
    ),
    cosineSimilarity,
  };
});

const { config } = await import('../../config.js');
const { pool } = await import('../pool.js');
const { MemoryRepository } = await import('../memory-repository.js');
const { ClaimRepository } = await import('../repository-claims.js');
const { executeConsolidation } = await import('../../services/consolidation-service.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_USER = 'consolidation-exec-user';

describe('consolidation execution', () => {
  const repo = new MemoryRepository(pool);
  const claimRepo = new ClaimRepository(pool);

  beforeAll(async () => {
    await setupTestSchema(pool);
  });

  beforeEach(async () => {
    await claimRepo.deleteAll();
    await repo.deleteAll();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('consolidates a cluster and archives originals', async () => {
    await seedRelatedMemories(repo);

    const result = await executeConsolidation(repo, claimRepo, TEST_USER, {
      affinity: {
        threshold: 0.5,
        minClusterSize: 3,
        beta: 1.0,
        temporalLambda: 0,
      },
    });

    expect(result.clustersConsolidated).toBeGreaterThanOrEqual(1);
    expect(result.memoriesArchived).toBeGreaterThanOrEqual(3);
    expect(result.memoriesCreated).toBeGreaterThanOrEqual(1);
    expect(result.consolidatedMemoryIds).toHaveLength(result.memoriesCreated);
  });

  it('consolidated memory exists and is retrievable', async () => {
    await seedRelatedMemories(repo);

    const result = await executeConsolidation(repo, claimRepo, TEST_USER, {
      affinity: { threshold: 0.5, minClusterSize: 3, beta: 1.0, temporalLambda: 0 },
    });

    const consolidatedMemory = await repo.getMemory(result.consolidatedMemoryIds[0], TEST_USER);
    expect(consolidatedMemory).not.toBeNull();
    expect(consolidatedMemory!.content).toContain('TypeScript');
  });

  it('archived originals are no longer in active memory', async () => {
    const memberIds = await seedRelatedMemories(repo);

    await executeConsolidation(repo, claimRepo, TEST_USER, {
      affinity: { threshold: 0.5, minClusterSize: 3, beta: 1.0, temporalLambda: 0 },
    });

    const activeCount = await repo.countMemories(TEST_USER);
    expect(activeCount).toBeLessThan(memberIds.length);

    for (const id of memberIds) {
      const mem = await repo.getMemory(id, TEST_USER);
      if (mem === null) {
        const deleted = await repo.getMemoryIncludingDeleted(id, TEST_USER);
        expect(deleted).not.toBeNull();
        expect(deleted!.deleted_at).not.toBeNull();
      }
    }
  });

  it('consolidated memory has claim version with provenance', async () => {
    await seedRelatedMemories(repo);

    const result = await executeConsolidation(repo, claimRepo, TEST_USER, {
      affinity: { threshold: 0.5, minClusterSize: 3, beta: 1.0, temporalLambda: 0 },
    });

    const version = await claimRepo.getClaimVersionByMemoryId(TEST_USER, result.consolidatedMemoryIds[0]);
    expect(version).not.toBeNull();
    expect(version!.mutation_type).toBe('add');
    expect(version!.mutation_reason).toContain('Consolidated');
    expect(version!.actor_model).toBe(config.llmModel);
  });

  it('preserves the current no-CMO consolidation behavior', async () => {
    await seedRelatedMemories(repo);

    const result = await executeConsolidation(repo, claimRepo, TEST_USER, {
      affinity: { threshold: 0.5, minClusterSize: 3, beta: 1.0, temporalLambda: 0 },
    });

    const consolidatedId = result.consolidatedMemoryIds[0];
    const consolidatedMemory = await repo.getMemory(consolidatedId, TEST_USER);
    const cmoRows = await pool.query(
      `SELECT id
       FROM canonical_memory_objects
       WHERE user_id = $1
         AND lineage->>'claimVersionId' = (
           SELECT id::text
           FROM memory_claim_versions
           WHERE user_id = $1 AND memory_id = $2
         )`,
      [TEST_USER, consolidatedId],
    );

    expect(consolidatedMemory).not.toBeNull();
    expect(consolidatedMemory!.metadata.cmo_id).toBeUndefined();
    expect(cmoRows.rows).toHaveLength(0);
  });

  it('consolidated memory has metadata with source member IDs', async () => {
    const mem = await seedAndConsolidateFirst(repo, claimRepo);
    expect(mem!.metadata.consolidated_from).toBeDefined();
    expect(Array.isArray(mem!.metadata.consolidated_from)).toBe(true);
    expect((mem!.metadata.consolidated_from as string[]).length).toBeGreaterThanOrEqual(3);
  });

  it('returns zero results when no clusters form', async () => {
    await repo.storeMemory({
      userId: TEST_USER, content: 'Standalone fact', embedding: unitVector(99),
      importance: 0.5, sourceSite: 'test',
    });

    const result = await executeConsolidation(repo, claimRepo, TEST_USER);
    expect(result.clustersConsolidated).toBe(0);
    expect(result.memoriesArchived).toBe(0);
    expect(result.memoriesCreated).toBe(0);
  });

  it('importance of consolidated memory is slightly above max member', async () => {
    const mem = await seedAndConsolidateFirst(repo, claimRepo);
    expect(mem!.importance).toBeGreaterThanOrEqual(0.8);
    expect(mem!.importance).toBeLessThanOrEqual(1.0);
  });
});

/**
 * Seed 4 semantically similar memories about TypeScript/testing.
 * Uses nearly-identical embeddings to ensure clustering at low threshold.
 */
async function seedRelatedMemories(repo: InstanceType<typeof MemoryRepository>): Promise<string[]> {
  const base = unitVector(11);
  const ids: string[] = [];

  const facts = [
    'User prefers TypeScript for all projects',
    'User uses TypeScript with strict mode enabled',
    'User writes tests using Vitest framework',
    'User prefers strong typing over dynamic typing',
  ];

  for (let i = 0; i < facts.length; i++) {
    const embedding = offsetVector(base, i + 1, 0.005);
    const id = await repo.storeMemory({
      userId: TEST_USER,
      content: facts[i],
      embedding,
      importance: 0.7 + i * 0.03,
      sourceSite: 'test',
    });
    ids.push(id);
  }

  return ids;
}

/** Seed related memories, run consolidation, and return the first consolidated memory. */
async function seedAndConsolidateFirst(
  repo: InstanceType<typeof MemoryRepository>,
  claimRepo: InstanceType<typeof ClaimRepository>,
) {
  await seedRelatedMemories(repo);
  const result = await executeConsolidation(repo, claimRepo, TEST_USER, {
    affinity: { threshold: 0.5, minClusterSize: 3, beta: 1.0, temporalLambda: 0 },
  });
  return repo.getMemory(result.consolidatedMemoryIds[0], TEST_USER);
}

function unitVector(seed: number): number[] {
  const values = Array.from({ length: config.embeddingDimensions }, (_, i) => Math.sin(seed * (i + 1)));
  const norm = Math.sqrt(values.reduce((s, v) => s + v * v, 0));
  return values.map((v) => v / norm);
}

function offsetVector(base: number[], seed: number, scale: number): number[] {
  const values = base.map((v, i) => v + Math.cos(seed * (i + 1)) * scale);
  const norm = Math.sqrt(values.reduce((s, v) => s + v * v, 0));
  return values.map((v) => v / norm);
}
