/**
 * Smoke test: exercises the full ingest -> search pipeline with mocked LLM/embedding.
 * No live API credentials required.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

import { config } from '../config.js';

/** Generate a deterministic embedding seeded by a string. */
function seededEmbedding(text: string): number[] {
  let seed = 0;
  for (let i = 0; i < text.length; i++) seed = ((seed << 5) - seed + text.charCodeAt(i)) | 0;
  return Array.from({ length: config.embeddingDimensions }, (_, i) => Math.sin(seed * (i + 1)) / 10);
}

const mocks = vi.hoisted(() => ({
  mockEmbedText: vi.fn(),
  mockEmbedTexts: vi.fn(),
  mockConsensusExtractFacts: vi.fn(),
  mockCachedResolveAUDN: vi.fn(),
}));

vi.mock('../services/embedding.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/embedding.js')>();
  return {
    ...actual,
    embedText: mocks.mockEmbedText,
    embedTexts: mocks.mockEmbedTexts,
  };
});
vi.mock('../services/consensus-extraction.js', () => ({
  consensusExtractFacts: mocks.mockConsensusExtractFacts,
}));
vi.mock('../services/extraction-cache.js', () => ({
  cachedResolveAUDN: mocks.mockCachedResolveAUDN,
}));

import { pool } from '../db/pool.js';
import { createServiceTestContext } from '../db/__tests__/test-fixtures.js';

const TEST_USER = 'smoke-test-user';

describe('full pipeline smoke test', () => {
  const { repo, service } = createServiceTestContext(pool, { beforeAll, beforeEach, afterAll });

  beforeEach(() => {
    mocks.mockEmbedText.mockImplementation(async (text: string) => seededEmbedding(text));
    mocks.mockEmbedTexts.mockImplementation(async (texts: string[]) =>
      texts.map((text) => seededEmbedding(text)),
    );
    mocks.mockConsensusExtractFacts.mockImplementation(async (text: string) => {
      if (text.includes('microservices')) {
        return [
          { fact: 'User is migrating monolith to microservices using Kubernetes.', headline: 'Kubernetes migration', importance: 0.9, type: 'knowledge', keywords: ['kubernetes', 'microservices', 'migration'], entities: [], relations: [] },
          { fact: 'Auth service gets 10x the traffic and needs independent scaling.', headline: 'Auth scaling', importance: 0.8, type: 'knowledge', keywords: ['auth', 'scaling'], entities: [], relations: [] },
          { fact: 'User prefers Go for performance-critical services and TypeScript for the rest.', headline: 'Language preferences', importance: 0.7, type: 'preference', keywords: ['go', 'typescript'], entities: [], relations: [] },
        ];
      }
      if (text.includes('hiking')) {
        return [
          { fact: 'User loves hiking in the mountains every weekend.', headline: 'Hiking hobby', importance: 0.5, type: 'preference', keywords: ['hiking', 'mountains'], entities: [], relations: [] },
        ];
      }
      if (text.includes('React')) {
        return [
          { fact: 'User React app uses Next.js with Prisma for the database layer.', headline: 'Tech stack', importance: 0.8, type: 'knowledge', keywords: ['react', 'nextjs', 'prisma'], entities: [], relations: [] },
        ];
      }
      return [];
    });
    mocks.mockCachedResolveAUDN.mockImplementation(async () => ({
      action: 'ADD',
      targetMemoryId: null,
      updatedContent: null,
      contradictionConfidence: null,
      clarificationNote: null,
    }));
  });

  it('ingests a conversation and retrieves relevant context', async () => {
    const conversation = `user: I'm migrating our monolith to microservices using Kubernetes.
assistant: What's driving the migration?
user: We need independent scaling. The auth service gets 10x the traffic.
assistant: What language for the services?
user: Go for performance-critical ones, TypeScript for the rest.`;

    const writeResult = await service.ingest({
      userId: TEST_USER,
      conversationText: conversation,
      sourceSite: 'claude.ai',
    });
    expect(writeResult.memoriesStored).toBeGreaterThan(0);

    const searchResult = await service.search(TEST_USER, 'What infrastructure is the user using?');
    expect(searchResult.memories.length).toBeGreaterThan(0);
    expect(searchResult.injectionText.length).toBeGreaterThan(0);
  });

  it('returns relevant results over irrelevant ones', async () => {
    await service.ingest({
      userId: TEST_USER,
      conversationText: 'user: I love hiking in the mountains every weekend.',
      sourceSite: 'test',
    });
    await service.ingest({
      userId: TEST_USER,
      conversationText: 'user: My React app uses Next.js with Prisma for the database layer.',
      sourceSite: 'test',
    });

    const result = await service.search(TEST_USER, 'What framework is the user using?');
    expect(result.memories.length).toBeGreaterThan(0);

    const topContent = result.memories[0].content.toLowerCase();
    expect(topContent).toMatch(/react|next|prisma/i);
  });
});
