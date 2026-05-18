/**
 * Phase 6 research-consumption contract test.
 *
 * Proves the two in-repo consumption seams documented at
 * https://docs.atomicstrata.ai/platform/consuming-core both work against a
 * shared runtime and agree on stored state:
 *
 *   - in-process:  `createCoreRuntime({ pool }).services.memory.*`
 *   - HTTP:         `bindEphemeral(createApp(runtime))` + `fetch`
 *
 * The third mode (docker/E2E compose) is exercised by
 * `scripts/docker-smoke-test.sh` and is out of scope for this test.
 *
 * Uses the same mock-hoist pattern as `smoke.test.ts` so no external
 * LLM/embedding provider is required.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { config } from '../../config.js';

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

vi.mock('../../services/embedding.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/embedding.js')>();
  return { ...actual, embedText: mocks.mockEmbedText, embedTexts: mocks.mockEmbedTexts };
});
vi.mock('../../services/consensus-extraction.js', () => ({
  consensusExtractFacts: mocks.mockConsensusExtractFacts,
}));
vi.mock('../../services/extraction-cache.js', () => ({
  cachedResolveAUDN: mocks.mockCachedResolveAUDN,
}));

import { pool } from '../../db/pool.js';
import { setupTestSchema } from '../../db/__tests__/test-fixtures.js';
import { createCoreRuntime } from '../runtime-container.js';
import { createApp } from '../create-app.js';
import { bindEphemeral, type BootedApp } from '../bind-ephemeral.js';
import { authHeader } from '../../__tests__/helpers/auth-headers.js';

const TEST_USER = 'phase6-consumption-user';
const CONVERSATION =
  'user: I ship the backend in Go and the frontend in TypeScript with Next.js.';

function stubMocks() {
  mocks.mockEmbedText.mockImplementation(async (text: string) => seededEmbedding(text));
  mocks.mockEmbedTexts.mockImplementation(async (texts: string[]) =>
    texts.map((text) => seededEmbedding(text)),
  );
  mocks.mockConsensusExtractFacts.mockImplementation(async () => [
    {
      fact: 'User ships Go backend and TypeScript/Next.js frontend.',
      headline: 'Stack',
      importance: 0.8,
      type: 'knowledge',
      keywords: ['go', 'typescript', 'nextjs'],
      entities: [],
      relations: [],
    },
  ]);
  mocks.mockCachedResolveAUDN.mockImplementation(async () => ({
    action: 'ADD',
    targetMemoryId: null,
    updatedContent: null,
    contradictionConfidence: null,
    clarificationNote: null,
  }));
}

describe('Phase 6 research-consumption seams', () => {
  let runtime: Awaited<ReturnType<typeof createCoreRuntime>>;
  let app: ReturnType<typeof createApp>;
  let server: BootedApp;

  beforeAll(async () => {
    await setupTestSchema(pool);
    runtime = await createCoreRuntime({ pool });
    app = createApp(runtime);
    server = await bindEphemeral(app);
  });

  afterAll(async () => {
    await server.close();
    await pool.end();
  });

  beforeEach(async () => {
    stubMocks();
    await runtime.repos.claims.deleteAll();
    await runtime.repos.memory.deleteAll();
  });

  it('in-process seam: ingest + search via runtime.services.memory', async () => {
    const write = await runtime.services.memory.ingest({
      userId: TEST_USER,
      conversationText: CONVERSATION,
      sourceSite: 'test-site',
    });
    expect(write.memoriesStored).toBeGreaterThan(0);

    const read = await runtime.services.memory.search(TEST_USER, 'What stack does the user use?');
    expect(read.memories.length).toBeGreaterThan(0);
    expect(read.injectionText.length).toBeGreaterThan(0);
  });

  it('in-process seam: named ingest + list preserve session scope', async () => {
    await runtime.services.memory.ingest({
      userId: TEST_USER,
      conversationText: CONVERSATION,
      sourceSite: 'test-site',
      sessionId: 'phase6-session-a',
    });
    await runtime.services.memory.ingest({
      userId: TEST_USER,
      conversationText: 'user: I also maintain a Rust CLI.',
      sourceSite: 'test-site',
      sessionId: 'phase6-session-b',
    });

    const scoped = await runtime.services.memory.list({
      userId: TEST_USER,
      sessionId: 'phase6-session-a',
    });

    expect(scoped.length).toBeGreaterThan(0);
    expect(scoped.every((memory) => memory.session_id === 'phase6-session-a')).toBe(true);
  });

  it('HTTP seam: POST /v1/memories/ingest + POST /v1/memories/search via bindEphemeral', async () => {
    const ingestRes = await fetch(`${server.baseUrl}/v1/memories/ingest`, {
      method: 'POST',
      headers: { ...authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: TEST_USER, conversation: CONVERSATION, source_site: 'test-site' }),
    });
    expect(ingestRes.status).toBe(200);
    const ingestBody = await ingestRes.json();
    expect(ingestBody.memories_stored).toBeGreaterThan(0);

    const searchRes = await fetch(`${server.baseUrl}/v1/memories/search`, {
      method: 'POST',
      headers: { ...authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: TEST_USER, query: 'What stack does the user use?' }),
    });
    expect(searchRes.status).toBe(200);
    const searchBody = await searchRes.json();
    expect(searchBody.count).toBeGreaterThan(0);
    expect(typeof searchBody.injection_text).toBe('string');
    expect(searchBody.injection_text.length).toBeGreaterThan(0);
  });

  it('parity: in-process write is observable through the HTTP seam (shared pool)', async () => {
    const write = await runtime.services.memory.ingest({
      userId: TEST_USER,
      conversationText: CONVERSATION,
      sourceSite: 'test-site',
    });
    expect(write.memoriesStored).toBeGreaterThan(0);
    const writtenIds = new Set(write.memoryIds);

    const searchRes = await fetch(`${server.baseUrl}/v1/memories/search`, {
      method: 'POST',
      headers: { ...authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: TEST_USER, query: 'What stack does the user use?' }),
    });
    const body = await searchRes.json();
    const returnedIds: string[] = body.memories.map((memory: { id: string }) => memory.id);
    const overlap = returnedIds.filter((id) => writtenIds.has(id));

    expect(overlap.length).toBeGreaterThan(0);
  });

  it('parity: HTTP write is observable through the in-process seam (shared pool)', async () => {
    const ingestRes = await fetch(`${server.baseUrl}/v1/memories/ingest`, {
      method: 'POST',
      headers: { ...authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: TEST_USER, conversation: CONVERSATION, source_site: 'test-site' }),
    });
    const ingestBody = await ingestRes.json();
    expect(ingestBody.memories_stored).toBeGreaterThan(0);
    const writtenIds = new Set<string>([
      ...ingestBody.stored_memory_ids,
      ...ingestBody.updated_memory_ids,
    ]);

    const read = await runtime.services.memory.search(TEST_USER, 'What stack does the user use?');
    const overlap = read.memories.filter((memory) => writtenIds.has(memory.id));
    expect(overlap.length).toBeGreaterThan(0);
  });
});
