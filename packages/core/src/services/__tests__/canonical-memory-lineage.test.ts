/**
 * Deterministic service tests for canonical memory object lineage.
 * Covers successor CMO emission in update, supersede, and delete mutation paths.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/* vi.hoisted + vi.mock must be per-file (vitest hoisting requirement). */
const mocks = vi.hoisted(() => ({ embedText: vi.fn(), embedTexts: vi.fn(), extractFacts: vi.fn(), resolveAUDN: vi.fn() }));
vi.mock('../embedding.js', () => ({ embedText: mocks.embedText, embedTexts: mocks.embedTexts }));
vi.mock('../consensus-extraction.js', () => ({ consensusExtractFacts: mocks.extractFacts }));
vi.mock('../extraction-cache.js', () => ({ cachedResolveAUDN: mocks.resolveAUDN }));
vi.mock('../conflict-policy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../conflict-policy.js')>();
  return { ...actual, applyClarificationOverrides: vi.fn((d) => d) };
});

import {
  decisionPlans, unitVector, offsetVector, registerConversation,
  createDeterministicIngestContext, embeddingPlans, factPlans,
  wireDeterministicMocks,
} from './deterministic-ingest-harness.js';

import { pool } from '../../db/pool.js';
const TEST_USER = 'canonical-memory-lineage-user';

describe('canonical memory lineage', () => {
  const ctx = createDeterministicIngestContext(
    pool,
    { beforeAll, beforeEach, afterAll },
    { testUser: TEST_USER, cleanCmo: true },
  );

  beforeEach(() => {
    wireDeterministicMocks({ mockEmbedText: mocks.embedText, mockEmbedTexts: mocks.embedTexts, mockConsensusExtractFacts: mocks.extractFacts, mockCachedResolveAUDN: mocks.resolveAUDN });
  });

  it('emits a successor CMO on supersede and links it from the new projection', async () => {
    const originalConversation = 'original-backend';
    const replacementConversation = 'replacement-backend';
    const originalFact = 'Project uses Mem0 as the memory backend.';
    const replacementFact = 'Project now uses AtomicMemory as the memory backend.';
    const originalAt = new Date('2026-01-10T00:00:00.000Z');
    const replacementAt = new Date('2026-03-15T00:00:00.000Z');
    const baseEmbedding = unitVector(11);

    registerConversation(originalConversation, originalFact, baseEmbedding, 'Uses Mem0 backend');
    registerConversation(replacementConversation, replacementFact, offsetVector(baseEmbedding, 17, 0.01), 'Uses AtomicMemory backend');

    const { memory: originalMemory, version: originalVersion } = await ingestAndCapture(originalConversation, originalAt);

    decisionPlans.set(replacementFact, {
      action: 'SUPERSEDE',
      targetMemoryId: originalMemory!.id,
      updatedContent: null,
      contradictionConfidence: 0.97,
      clarificationNote: null,
    });

    const { memory: replacementMemory, version: replacementVersion } = await ingestAndCapture(replacementConversation, replacementAt, 'https://source/replacement');
    const cmoRow = await queryCmoById(replacementMemory!.metadata.cmo_id as string);

    expect(cmoRow.rows).toHaveLength(1);
    expect(cmoRow.rows[0].canonical_payload.factText).toBe(replacementFact);
    expect(cmoRow.rows[0].provenance.sourceUrl).toBe('https://source/replacement');
    expect(cmoRow.rows[0].lineage.mutationType).toBe('supersede');
    expectLineageLinks(cmoRow.rows[0].lineage, originalMemory!, originalVersion!, replacementVersion!);
  });

  it('emits an update successor CMO and relinks the in-place projection', async () => {
    const originalConversation = 'original-editor';
    const updateConversation = 'update-editor';
    const originalFact = 'User prefers VS Code.';
    const updatedFact = 'User prefers Cursor over VS Code.';
    const originalAt = new Date('2026-01-05T00:00:00.000Z');
    const updateAt = new Date('2026-04-20T00:00:00.000Z');
    const baseEmbedding = unitVector(15);

    registerConversation(originalConversation, originalFact, baseEmbedding, 'Prefers VS Code');
    registerConversation(updateConversation, updatedFact, offsetVector(baseEmbedding, 23, 0.01), 'Prefers Cursor');

    const { result: original, memory: originalMemory, version: originalVersion } = await ingestAndCapture(originalConversation, originalAt);

    decisionPlans.set(updatedFact, {
      action: 'UPDATE',
      targetMemoryId: originalMemory!.id,
      updatedContent: updatedFact,
      contradictionConfidence: 0.88,
      clarificationNote: null,
    });

    await ctx.service.ingest({
      userId: TEST_USER,
      conversationText: updateConversation,
      sourceSite: 'test',
      sourceUrl: 'https://source/update',
      sessionTimestamp: updateAt,
    });

    const updatedMemory = await ctx.repo.getMemory(originalMemory!.id, TEST_USER);
    const updatedVersion = await ctx.claimRepo.getClaimVersionByMemoryId(TEST_USER, originalMemory!.id);
    const cmoRow = await queryCmoById(updatedMemory!.metadata.cmo_id as string);

    expect(cmoRow.rows).toHaveLength(1);
    expect(updatedMemory!.id).toBe(originalMemory!.id);
    expect(updatedMemory!.content).toBe(updatedFact);
    expect(cmoRow.rows[0].canonical_payload.factText).toBe(updatedFact);
    expect(cmoRow.rows[0].provenance.sourceUrl).toBe('https://source/update');
    expect(cmoRow.rows[0].lineage.mutationType).toBe('update');
    expectLineageLinks(cmoRow.rows[0].lineage, originalMemory!, originalVersion!, updatedVersion!);
  });

  it('emits a delete successor CMO with prior object and version lineage', async () => {
    const originalConversation = 'original-location';
    const deleteConversation = 'delete-location';
    const originalFact = 'User lives in Oakland.';
    const deleteFact = 'User no longer lives in Oakland.';
    const originalAt = new Date('2026-01-01T00:00:00.000Z');
    const deleteAt = new Date('2026-04-01T00:00:00.000Z');
    const baseEmbedding = unitVector(21);

    registerConversation(originalConversation, originalFact, baseEmbedding, 'Lives in Oakland');
    registerConversation(deleteConversation, deleteFact, offsetVector(baseEmbedding, 19, 0.01), 'No longer lives in Oakland');

    const { memory: originalMemory, version: originalVersion } = await ingestAndCapture(originalConversation, originalAt);

    decisionPlans.set(deleteFact, {
      action: 'DELETE',
      targetMemoryId: originalMemory!.id,
      updatedContent: null,
      contradictionConfidence: 0.92,
      clarificationNote: null,
    });

    await ctx.service.ingest({
      userId: TEST_USER,
      conversationText: deleteConversation,
      sourceSite: 'test',
      sourceUrl: 'https://source/delete',
      sessionTimestamp: deleteAt,
    });

    const claim = await ctx.claimRepo.getClaim(originalVersion!.claim_id, TEST_USER);
    const deleteCmoRow = await pool.query(
      `SELECT canonical_payload, provenance, lineage
       FROM canonical_memory_objects
       WHERE user_id = $1 AND lineage->>'mutationType' = 'delete'
       ORDER BY created_at DESC
       LIMIT 1`,
      [TEST_USER],
    );

    expect(deleteCmoRow.rows).toHaveLength(1);
    expect(deleteCmoRow.rows[0].canonical_payload.factText).toBe(deleteFact);
    expect(deleteCmoRow.rows[0].provenance.sourceUrl).toBe('https://source/delete');
    expect(deleteCmoRow.rows[0].lineage.mutationType).toBe('delete');
    expect(deleteCmoRow.rows[0].lineage.previousObjectId).toBe(originalMemory!.metadata.cmo_id);
    expect(deleteCmoRow.rows[0].lineage.claimId).toBe(originalVersion!.claim_id);
    expect(deleteCmoRow.rows[0].lineage.previousVersionId).toBe(originalVersion!.id);
    // Delete uses the invalidation version rather than a new successor version
    expect(deleteCmoRow.rows[0].lineage.claimVersionId).toBe(claim!.invalidated_by_version_id);
  });

  it('preserves delete tombstone claim-version invariants', async () => {
    const originalConversation = 'original-employer';
    const deleteConversation = 'delete-employer';
    const originalFact = 'User works at OpenAI.';
    const deleteFact = 'User no longer works at OpenAI.';
    const originalAt = new Date('2026-01-02T00:00:00.000Z');
    const deleteAt = new Date('2026-04-02T00:00:00.000Z');
    const baseEmbedding = unitVector(31);

    registerConversation(originalConversation, originalFact, baseEmbedding, 'Works at OpenAI');
    registerConversation(deleteConversation, deleteFact, offsetVector(baseEmbedding, 13, 0.01), 'No longer works at OpenAI');

    const { memory: originalMemory, version: originalVersion } = await ingestAndCapture(originalConversation, originalAt);

    decisionPlans.set(deleteFact, {
      action: 'DELETE',
      targetMemoryId: originalMemory!.id,
      updatedContent: null,
      contradictionConfidence: 0.94,
      clarificationNote: null,
    });

    await ctx.service.ingest({
      userId: TEST_USER,
      conversationText: deleteConversation,
      sourceSite: 'test',
      sourceUrl: 'https://source/delete-employer',
      sessionTimestamp: deleteAt,
    });

    const claim = await ctx.claimRepo.getClaim(originalVersion!.claim_id, TEST_USER);
    const tombstoneVersion = await ctx.claimRepo.getClaimVersion(claim!.invalidated_by_version_id!, TEST_USER);

    expect(tombstoneVersion).not.toBeNull();
    expect(tombstoneVersion!.memory_id).toBeNull();
    expect(tombstoneVersion!.content).toBe(`[DELETED] ${deleteFact}`);
    expect(tombstoneVersion!.importance).toBe(0);
    expect(tombstoneVersion!.source_site).toBe('');
    expect(tombstoneVersion!.source_url).toBe('');
    expect(tombstoneVersion!.previous_version_id).toBe(originalVersion!.id);
    expect(tombstoneVersion!.embedding).toEqual(originalVersion!.embedding);
  });

  it('backfills lineage for a legacy projection without emitting a mutation CMO', async () => {
    const { memoryId, target } = await backfillLegacyProjection(
      'Legacy memory without claim lineage.',
      unitVector(29),
      0.6,
    );
    const claim = await ctx.claimRepo.getClaim(target.claimId, TEST_USER);
    const version = await ctx.claimRepo.getClaimVersionByMemoryId(TEST_USER, memoryId);
    const cmoRows = await pool.query('SELECT id FROM canonical_memory_objects WHERE user_id = $1', [TEST_USER]);

    expect(target.memoryId).toBe(memoryId);
    expect(target.cmoId).toBeNull();
    expect(claim?.current_version_id).toBe(target.versionId);
    expect(version?.id).toBe(target.versionId);
    expect(cmoRows.rows).toHaveLength(0);
  });

  it('leaves backfilled claim-version provenance fields null', async () => {
    const { target } = await backfillLegacyProjection(
      'Legacy fact with no prior claim version.',
      unitVector(37),
      0.55,
    );
    const version = await ctx.claimRepo.getClaimVersion(target.versionId, TEST_USER);

    expect(version).not.toBeNull();
    expect(version!.mutation_type).toBeNull();
    expect(version!.mutation_reason).toBeNull();
    expect(version!.previous_version_id).toBeNull();
    expect(version!.actor_model).toBeNull();
    expect(version!.contradiction_confidence).toBeNull();
  });

  /** Ingest a conversation and return its first memory, version, and raw result. */
  async function ingestAndCapture(conversation: string, timestamp: Date, sourceUrl = 'https://source/original') {
    const result = await ctx.service.ingest({
      userId: TEST_USER,
      conversationText: conversation,
      sourceSite: 'test',
      sourceUrl,
      sessionTimestamp: timestamp,
    });
    const memory = await ctx.repo.getMemory(result.memoryIds[0], TEST_USER);
    const version = await ctx.claimRepo.getClaimVersionByMemoryId(TEST_USER, result.memoryIds[0]);
    return { result, memory, version };
  }

  /** Create a legacy projection and force the claim-version backfill seam to run. */
  async function backfillLegacyProjection(content: string, embedding: number[], importance: number) {
    const memoryId = await ctx.repo.storeMemory({
      userId: TEST_USER,
      content,
      embedding,
      memoryType: 'semantic',
      importance,
      sourceSite: 'test',
    });
    const { ensureClaimTarget } = await import('../memory-storage.js');
    const target = await ensureClaimTarget({ repo: ctx.repo, claims: ctx.claimRepo, stores: { memory: ctx.repo, claim: ctx.claimRepo } } as any, TEST_USER, memoryId);
    return { memoryId, target };
  }

  /** Query a canonical_memory_objects row by id. */
  async function queryCmoById(cmoId: string) {
    return pool.query(
      `SELECT canonical_payload, provenance, lineage FROM canonical_memory_objects WHERE id = $1`,
      [cmoId],
    );
  }
});

/** Assert that a lineage row links back to the expected original memory and version. */
function expectLineageLinks(
  lineage: Record<string, unknown>,
  originalMemory: { metadata: Record<string, unknown> },
  originalVersion: { claim_id: string; id: string },
  successorVersion: { id: string },
) {
  expect(lineage.previousObjectId).toBe(originalMemory.metadata.cmo_id);
  expect(lineage.claimId).toBe(originalVersion.claim_id);
  expect(lineage.previousVersionId).toBe(originalVersion.id);
  expect(lineage.claimVersionId).toBe(successorVersion.id);
}
