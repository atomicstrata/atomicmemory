/**
 * Shared plan maps and helper functions for integration tests that exercise
 * the full ingest pipeline with deterministic mocks.
 *
 * The vi.mock() calls must remain in each test file (vitest hoists them),
 * but this module centralizes the plan maps and vector helpers to
 * eliminate duplication across canonical-memory-lineage.test.ts and
 * temporal-mutation-regression.test.ts.
 */

import type { AUDNDecision } from '../extraction.js';
import type { FactInput } from '../memory-service-types.js';
import type pg from 'pg';

export { unitVector, offsetVector } from '../../db/__tests__/test-fixtures.js';

// fallow-ignore-next-line unused-export
export const factPlans = new Map<string, FactInput[]>();
export const decisionPlans = new Map<string, AUDNDecision>();
// fallow-ignore-next-line unused-export
export const embeddingPlans = new Map<string, number[]>();

/** Deterministic cachedResolveAUDN implementation — shared by mock factory and wire fn. */
async function resolveAudnFromPlan(factText: string, candidates: Array<{ id: string }>): Promise<AUDNDecision> {
  const decision = decisionPlans.get(factText);
  if (!decision) throw new Error(`Missing deterministic AUDN plan for: ${factText}`);
  if (decision.targetMemoryId === '__first_candidate__') {
    return { ...decision, targetMemoryId: candidates[0]?.id ?? null };
  }
  return decision;
}

/** Clear all plan maps — call in beforeEach. */
function clearPlans(): void {
  factPlans.clear();
  decisionPlans.clear();
  embeddingPlans.clear();
}

/** Mock fns passed from vi.hoisted() in the test file. */
interface DeterministicMocks {
  mockEmbedText: ReturnType<typeof import('vitest').vi.fn>;
  mockEmbedTexts: ReturnType<typeof import('vitest').vi.fn>;
  mockConsensusExtractFacts: ReturnType<typeof import('vitest').vi.fn>;
  mockCachedResolveAUDN: ReturnType<typeof import('vitest').vi.fn>;
}

/**
 * Wire vi.hoisted mock fns to the deterministic plan maps.
 * Call this in beforeEach() — keeps the wiring DRY across test files
 * while vi.mock declarations stay per-file (vitest hoisting requirement).
 */
export function wireDeterministicMocks(mocks: DeterministicMocks): void {
  mocks.mockEmbedText.mockImplementation(async (text: string) => {
    const embedding = embeddingPlans.get(text);
    if (!embedding) throw new Error(`Missing deterministic embedding for: ${text}`);
    return embedding;
  });
  mocks.mockEmbedTexts.mockImplementation(async (texts: string[]) =>
    Promise.all(texts.map(async (text: string) => {
      const embedding = embeddingPlans.get(text);
      if (!embedding) throw new Error(`Missing deterministic embedding for: ${text}`);
      return embedding;
    })),
  );
  mocks.mockConsensusExtractFacts.mockImplementation(async (conversationText: string) => {
    const facts = factPlans.get(conversationText);
    if (!facts) throw new Error(`Missing deterministic fact plan for: ${conversationText}`);
    return facts;
  });
  mocks.mockCachedResolveAUDN.mockImplementation(resolveAudnFromPlan);
}

/**
 * Create the standard deterministic ingest test context: repo, claimRepo, service,
 * and lifecycle hooks (setupTestSchema, clearPlans, deleteAll, pool.end).
 *
 * Must be called inside a describe() block. The returned objects are used
 * by canonical-memory-lineage and temporal-mutation-regression tests.
 */
export function createDeterministicIngestContext(
  pool: pg.Pool,
  hooks: {
    beforeAll: (fn: () => Promise<void>) => void;
    beforeEach: (fn: () => Promise<void>) => void;
    afterAll: (fn: () => Promise<void>) => void;
  },
  options: {
    testUser: string;
    cleanCmo?: boolean;
  },
) {
  /* Lazy-init holders — populated in beforeAll via dynamic import to avoid
     CJS resolution issues with .ts sources in vitest. */
  const ctx: {
    repo: import('../../db/memory-repository.js').MemoryRepository;
    claimRepo: import('../../db/claim-repository.js').ClaimRepository;
    service: import('../memory-service.js').MemoryService;
    originalFastAudnEnabled: boolean;
  } = {} as any;

  hooks.beforeAll(async () => {
    const [
      { ClaimRepository },
      { MemoryRepository },
      { MemoryService },
      { config },
      { setupTestSchema: doSetup },
    ] = await Promise.all([
      import('../../db/claim-repository.js'),
      import('../../db/memory-repository.js'),
      import('../memory-service.js'),
      import('../../config.js'),
      import('../../db/__tests__/test-fixtures.js'),
    ]);

    ctx.repo = new MemoryRepository(pool);
    ctx.claimRepo = new ClaimRepository(pool);
    ctx.service = new MemoryService(ctx.repo, ctx.claimRepo);
    ctx.originalFastAudnEnabled = config.fastAudnEnabled;
    await doSetup(pool);
  });

  hooks.beforeEach(async () => {
    clearPlans();
    const { config } = await import('../../config.js');
    config.fastAudnEnabled = false;
    await ctx.claimRepo.deleteAll();
    await ctx.repo.deleteAll();
    if (options.cleanCmo) {
      await pool.query('DELETE FROM canonical_memory_objects');
    }
  });

  hooks.afterAll(async () => {
    const { config } = await import('../../config.js');
    config.fastAudnEnabled = ctx.originalFastAudnEnabled;
    await pool.end();
  });

  /* Return the lazy context object — tests must access properties at test time,
     not at describe-block definition time. */
  return ctx;
}

/**
 * Register a conversation with its fact plan and embedding for the harness.
 * The `withHeadline` variant (headline provided) produces 'project'-type facts
 * with importance 0.8; the plain variant produces 'knowledge'-type at 0.9.
 */
export function registerConversation(
  conversation: string,
  factText: string,
  embedding: number[],
  headline?: string,
): void {
  factPlans.set(conversation, [{
    fact: factText,
    headline: headline ?? factText,
    importance: headline ? 0.8 : 0.9,
    type: headline ? 'project' : 'knowledge',
    keywords: headline
      ? factText.split(' ').filter((word) => word.length > 2)
      : factText.toLowerCase().split(/\W+/).filter(Boolean),
    entities: [],
    relations: [],
  }]);
  embeddingPlans.set(factText, embedding);
}
