/**
 * Regression coverage for current-state retrieval after a tool migration.
 * Uses the real Postgres repositories plus mocked LLM/embeddings so the
 * Mem0 -> AtomicMemory failure stays deterministic and executable.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockChat, embeddingOverrides } = vi.hoisted(() => {
  return {
    mockChat: vi.fn(),
    embeddingOverrides: new Map<string, number[]>(),
  };
});

vi.mock('../llm.js', () => ({
  llm: { chat: (...args: unknown[]) => mockChat(...args) },
}));

vi.mock('../embedding.js', async () => {
  const { cosineSimilarity } = await import('../../vector-math.js');
  return {
    embedText: vi.fn(async (text: string) => embeddingOverrides.get(text) ?? hashVector(text)),
    embedTexts: vi.fn(async (texts: string[]) => texts.map((text) => embeddingOverrides.get(text) ?? hashVector(text))),
    cosineSimilarity,
  };
});

import { config } from '../../config.js';
import { pool } from '../../db/pool.js';
import { createServiceTestContext, unitVector, offsetVector } from '../../db/__tests__/test-fixtures.js';

const TEST_USER = 'current-state-retrieval-regression-user';
const OLD_CONVERSATION = [
  'User: Last month I was using Mem0 for browser memory experiments.',
  'Assistant: Understood.',
  'User: At that time I was mainly testing simple vector retrieval.',
].join('\n');
const NEW_CONVERSATION = [
  'User: This week I switched to the internal AtomicMemory engine.',
  'Assistant: Why?',
  'User: I want better mutation safety, provenance, and controllable retrieval.',
].join('\n');
const OLD_FACT = 'As of February 2026, user was using Mem0 for browser memory experiments.';
const CURRENT_FACT = 'As of March 2026, user uses the internal AtomicMemory engine.';
const BACKEND_ALIAS_FACT = "As of March 2026, user's current memory backend is the internal AtomicMemory engine.";
const TRANSITION_FACT = 'As of March 2026, user switched away from Mem0.';
const CURRENT_QUERY = 'What is the user using now for browser memory?';
const BACKEND_QUERY = 'What is the current memory backend?';

describe('current-state retrieval regression', () => {
  const { repo, claimRepo, service } = createServiceTestContext(pool, {
    beforeAll,
    afterAll,
  });

  beforeEach(async () => {
    mockChat.mockReset();
    embeddingOverrides.clear();
    await claimRepo.deleteAll();
    await repo.deleteAll();
    registerEmbeddings();
    mockChat.mockImplementation(buildMockChat());
  });

  it('keeps stale Mem0 references out of the top current-state result after switching to AtomicMemory', async () => {
    await service.ingest({
      userId: TEST_USER,
      conversationText: OLD_CONVERSATION,
      sourceSite: 'test',
      sessionTimestamp: new Date('2026-02-01T00:00:00.000Z'),
    });
    await service.ingest({
      userId: TEST_USER,
      conversationText: NEW_CONVERSATION,
      sourceSite: 'test',
      sessionTimestamp: new Date('2026-03-01T00:00:00.000Z'),
    });

    const current = await service.search(
      TEST_USER,
      CURRENT_QUERY,
      'test',
      5,
      undefined,
      undefined,
      undefined,
      { skipRepairLoop: true, skipReranking: true },
    );
    const historical = await service.search(
      TEST_USER,
      CURRENT_QUERY,
      'test',
      5,
      '2026-02-15T00:00:00.000Z',
    );
    const backend = await service.search(
      TEST_USER,
      BACKEND_QUERY,
      'test',
      5,
      undefined,
      undefined,
      undefined,
      { skipRepairLoop: true, skipReranking: true },
    );

    expect(current.memories[0]?.content).toContain('AtomicMemory');
    expect(current.memories[0]?.content).not.toContain('Mem0');
    expect(backend.memories[0]?.content).toContain('AtomicMemory');
    expect(backend.memories[0]?.content).not.toContain('Mem0');
    expect(current.memories.some((memory) => memory.content === TRANSITION_FACT)).toBe(true);
    expect(historical.memories[0]?.content).toContain('Mem0');
  });
});

function buildMockChat(): (messages: Array<{ role: string; content: string }>) => Promise<string> {
  return async (messages) => {
    const system = messages[0]?.content ?? '';
    const user = messages[1]?.content ?? '';
    if (system.includes('memory extraction system')) {
      return handleExtraction(user);
    }
    if (system.includes('You manage a memory store')) {
      return handleAudn(user);
    }
    throw new Error(`Unexpected llm.chat prompt: ${system.slice(0, 80)}`);
  };
}

function handleExtraction(content: string): string {
  if (content.includes(OLD_CONVERSATION)) {
    return JSON.stringify({ memories: [buildFact(OLD_FACT, ['Mem0'])] });
  }
  if (content.includes(NEW_CONVERSATION)) {
    return JSON.stringify({
      memories: [
        buildFact(
          'As of March 2026, user switched away from Mem0 and built the internal AtomicMemory engine.',
          ['Mem0', 'AtomicMemory'],
        ),
      ],
    });
  }
  throw new Error(`Missing extraction fixture for: ${content.slice(0, 120)}`);
}

function handleAudn(content: string): string {
  if (content.includes(`NEW FACT: ${CURRENT_FACT}`)) {
    return JSON.stringify({
      action: 'SUPERSEDE',
      target_memory_id: extractFirstMemoryId(content),
      updated_content: null,
      clarification_note: null,
      contradiction_confidence: 0.98,
    });
  }

  if (content.includes('NEW FACT: Last month I was using Mem0 for browser memory experiments.')) {
    return JSON.stringify({
      action: 'NOOP',
      target_memory_id: extractFirstMemoryId(content),
      updated_content: null,
      clarification_note: null,
      contradiction_confidence: null,
    });
  }

  return JSON.stringify({
    action: 'ADD',
    target_memory_id: null,
    updated_content: null,
    clarification_note: null,
    contradiction_confidence: null,
  });
}

function buildFact(fact: string, keywords: string[]) {
  return {
    fact,
    headline: fact.slice(0, 32),
    importance: 0.8,
    type: 'project',
    keywords,
    entities: [],
    relations: [],
  };
}

function extractFirstMemoryId(content: string): string {
  const match = content.match(/\[ID: ([^\]]+)\]/);
  if (!match) throw new Error(`Missing candidate memory id in AUDN prompt: ${content}`);
  return match[1]!;
}

function registerEmbeddings(): void {
  const oldVector = unitVector(11);
  const currentVector = offsetVector(oldVector, 17, 0.35);
  const backendAliasVector = offsetVector(currentVector, 19, 0.01);
  const transitionVector = offsetVector(oldVector, 23, 0.08);
  const queryVector = offsetVector(currentVector, 29, 0.01);
  const backendQueryVector = offsetVector(backendAliasVector, 31, 0.01);

  embeddingOverrides.set(OLD_FACT, oldVector);
  embeddingOverrides.set(CURRENT_FACT, currentVector);
  embeddingOverrides.set(BACKEND_ALIAS_FACT, backendAliasVector);
  embeddingOverrides.set(TRANSITION_FACT, transitionVector);
  embeddingOverrides.set(CURRENT_QUERY, queryVector);
  embeddingOverrides.set(BACKEND_QUERY, backendQueryVector);
}

function hashVector(text: string): number[] {
  const seed = [...text].reduce((sum, char, index) => sum + char.charCodeAt(0) * (index + 1), 0) || 1;
  return unitVector(seed);
}
