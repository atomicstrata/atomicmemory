/**
 * Deterministic regression tests for temporal mutation ordering and clarification.
 * Uses mocked extraction/AUDN/embeddings with the real Postgres repositories.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/* vi.hoisted + vi.mock must be per-file (vitest hoisting requirement). */
const mockEmbedText = vi.hoisted(() => vi.fn());
const mockEmbedTexts = vi.hoisted(() => vi.fn());
const mockConsensusExtractFacts = vi.hoisted(() => vi.fn());
const mockCachedResolveAUDN = vi.hoisted(() => vi.fn());
vi.mock('../embedding.js', () => ({ embedText: mockEmbedText, embedTexts: mockEmbedTexts }));
vi.mock('../consensus-extraction.js', () => ({ consensusExtractFacts: mockConsensusExtractFacts }));
vi.mock('../extraction-cache.js', () => ({ cachedResolveAUDN: mockCachedResolveAUDN }));
vi.mock('../conflict-policy.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../conflict-policy.js')>();
  return { ...mod, applyClarificationOverrides: vi.fn((d) => d) };
});

import {
  decisionPlans, unitVector, offsetVector, registerConversation,
  createDeterministicIngestContext, embeddingPlans, factPlans,
  wireDeterministicMocks,
} from './deterministic-ingest-harness.js';

import { pool } from '../../db/pool.js';
const TEST_USER = 'temporal-mutation-regression-user';

describe('temporal mutation regression', () => {
  const ctx = createDeterministicIngestContext(
    pool,
    { beforeAll, beforeEach, afterAll },
    { testUser: TEST_USER },
  );

  beforeEach(() => {
    wireDeterministicMocks({ mockEmbedText, mockEmbedTexts, mockConsensusExtractFacts, mockCachedResolveAUDN });
  });

  it('preserves logical supersession order for current and historical retrieval', async () => {
    const oldAt = new Date('2026-01-10T00:00:00.000Z');
    const newAt = new Date('2026-03-15T00:00:00.000Z');
    const oldConversation = 'old-memory-backend';
    const newConversation = 'new-memory-backend';
    const oldFact = 'Project uses Mem0 as the memory backend.';
    const newFact = 'Project now uses the AtomicMemory engine as the memory backend.';
    const backendBase = unitVector(11);

    registerConversation(oldConversation, oldFact, backendBase);
    registerConversation(newConversation, newFact, offsetVector(backendBase, 17, 0.01));

    const oldResult = await ctx.service.ingest({
      userId: TEST_USER,
      conversationText: oldConversation,
      sourceSite: 'test',
      sessionTimestamp: oldAt,
    });
    decisionPlans.set(newFact, {
      action: 'SUPERSEDE',
      targetMemoryId: oldResult.memoryIds[0],
      updatedContent: null,
      contradictionConfidence: 0.97,
      clarificationNote: null,
    });

    const newResult = await ctx.service.ingest({
      userId: TEST_USER,
      conversationText: newConversation,
      sourceSite: 'test',
      sessionTimestamp: newAt,
    });
    const queryEmbedding = offsetVector(backendBase, 31, 0.002);
    const currentResults = await ctx.repo.searchSimilar(TEST_USER, queryEmbedding, 5, 'test');
    const oldVersion = await ctx.claimRepo.getClaimVersionByMemoryId(TEST_USER, oldResult.memoryIds[0]);
    const versions = await ctx.claimRepo.listClaimVersions(oldVersion!.claim_id);
    const beforeSwitch = await ctx.claimRepo.searchClaimVersions(
      TEST_USER,
      queryEmbedding,
      5,
      '2026-02-01T00:00:00.000Z',
      'test',
    );
    const afterSwitch = await ctx.claimRepo.searchClaimVersions(
      TEST_USER,
      queryEmbedding,
      5,
      '2026-04-01T00:00:00.000Z',
      'test',
    );

    expect(newResult.memoryIds).toHaveLength(1);
    expect(currentResults[0].content).toContain('AtomicMemory');
    expect(currentResults.some((row) => row.content.includes('Mem0'))).toBe(false);
    expect(versions[0].valid_from.toISOString()).toBe(oldAt.toISOString());
    expect(versions[0].valid_to?.toISOString()).toBe(newAt.toISOString());
    expect(versions[1].valid_from.toISOString()).toBe(newAt.toISOString());
    expect(beforeSwitch[0].content).toContain('Mem0');
    expect(afterSwitch[0].content).toContain('AtomicMemory');
  });

  it('uses session timestamps for update-version chronology', async () => {
    const oldAt = new Date('2026-01-05T00:00:00.000Z');
    const updateAt = new Date('2026-04-20T00:00:00.000Z');
    const oldConversation = 'salary-v1';
    const newConversation = 'salary-v2';
    const oldFact = 'Current salary is $145,000 base.';
    const updatedFact = 'Current salary is $200,000 base with a $30,000 annual bonus.';
    const salaryBase = unitVector(21);

    registerConversation(oldConversation, oldFact, salaryBase);
    registerConversation(newConversation, updatedFact, offsetVector(salaryBase, 23, 0.01));

    const original = await ctx.service.ingest({
      userId: TEST_USER,
      conversationText: oldConversation,
      sourceSite: 'test',
      sessionTimestamp: oldAt,
    });
    decisionPlans.set(updatedFact, {
      action: 'UPDATE',
      targetMemoryId: original.memoryIds[0],
      updatedContent: updatedFact,
      contradictionConfidence: 0.91,
      clarificationNote: null,
    });

    await ctx.service.ingest({
      userId: TEST_USER,
      conversationText: newConversation,
      sourceSite: 'test',
      sessionTimestamp: updateAt,
    });

    const queryEmbedding = offsetVector(salaryBase, 29, 0.002);
    const currentResults = await ctx.repo.searchSimilar(TEST_USER, queryEmbedding, 5, 'test');
    const updatedVersion = await ctx.claimRepo.getClaimVersionByMemoryId(TEST_USER, original.memoryIds[0]);
    const versions = await ctx.claimRepo.listClaimVersions(updatedVersion!.claim_id);
    const beforeRaise = await ctx.claimRepo.searchClaimVersions(
      TEST_USER,
      queryEmbedding,
      5,
      '2026-02-01T00:00:00.000Z',
      'test',
    );
    const afterRaise = await ctx.claimRepo.searchClaimVersions(
      TEST_USER,
      queryEmbedding,
      5,
      '2026-05-01T00:00:00.000Z',
      'test',
    );

    expect(currentResults[0].content).toContain('$200,000');
    expect(versions).toHaveLength(2);
    expect(versions[0].valid_from.toISOString()).toBe(oldAt.toISOString());
    expect(versions[0].valid_to?.toISOString()).toBe(updateAt.toISOString());
    expect(versions[1].valid_from.toISOString()).toBe(updateAt.toISOString());
    expect(versions[1].mutation_type).toBe('update');
    expect(beforeRaise[0].content).toContain('$145,000');
    expect(afterRaise[0].content).toContain('$200,000');
  });

  it('stores clarification memories at the logical timestamp without overwriting the active claim', async () => {
    const originalAt = new Date('2026-01-01T00:00:00.000Z');
    const clarifyAt = new Date('2026-02-18T00:00:00.000Z');
    const originalConversation = 'birthday-known';
    const clarifyConversation = 'birthday-conflict';
    const originalFact = 'User birthday is June 15.';
    const conflictingFact = 'User birthday may be June 16 and needs clarification.';
    const birthdayBase = unitVector(41);

    registerConversation(originalConversation, originalFact, birthdayBase);
    registerConversation(clarifyConversation, conflictingFact, offsetVector(birthdayBase, 43, 0.008));

    const original = await ctx.service.ingest({
      userId: TEST_USER,
      conversationText: originalConversation,
      sourceSite: 'test',
      sessionTimestamp: originalAt,
    });
    const originalVersion = await ctx.claimRepo.getClaimVersionByMemoryId(TEST_USER, original.memoryIds[0]);
    decisionPlans.set(conflictingFact, {
      action: 'CLARIFY',
      targetMemoryId: original.memoryIds[0],
      updatedContent: null,
      contradictionConfidence: 0.42,
      clarificationNote: 'Conflicting birthday requires confirmation.',
    });

    await ctx.service.ingest({
      userId: TEST_USER,
      conversationText: clarifyConversation,
      sourceSite: 'test',
      sessionTimestamp: clarifyAt,
    });

    const clarificationRows = await pool.query(
      `SELECT content, status, created_at, observed_at, metadata
       FROM memories
       WHERE user_id = $1 AND status = 'needs_clarification'`,
      [TEST_USER],
    );
    const currentResults = await ctx.repo.searchSimilar(
      TEST_USER,
      offsetVector(birthdayBase, 47, 0.002),
      5,
      'test',
    );
    const claim = await ctx.claimRepo.getClaim(originalVersion!.claim_id, TEST_USER);
    const versions = await ctx.claimRepo.listClaimVersions(originalVersion!.claim_id);

    expect(clarificationRows.rows).toHaveLength(1);
    expect(clarificationRows.rows[0].content).toContain('June 16');
    expect(clarificationRows.rows[0].status).toBe('needs_clarification');
    expect(new Date(clarificationRows.rows[0].created_at).toISOString()).toBe(clarifyAt.toISOString());
    expect(new Date(clarificationRows.rows[0].observed_at).toISOString()).toBe(clarifyAt.toISOString());
    expect(claim?.current_version_id).toBe(originalVersion!.id);
    expect(versions).toHaveLength(1);
    expect(await ctx.repo.countNeedsClarification(TEST_USER)).toBe(1);
    expect(currentResults[0].content).toContain('June 15');
  });
});

// registerConversation, unitVector, offsetVector imported from deterministic-ingest-harness.ts
