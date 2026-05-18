/**
 * Branch coverage for ingest trace decision sources.
 *
 * Exercises the real ingest entrypoints and inspects persisted ingest-trace
 * artifacts so the public trace contract stays aligned with runtime behavior.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  facts: [
    {
      fact: 'User prefers Rust',
      headline: 'Prefers Rust',
      importance: 0.8,
      type: 'preference' as const,
      keywords: ['rust'],
      entities: [],
      relations: [],
    },
  ],
  writeSecurity: {
    allowed: true,
    blockedBy: null,
    trust: { score: 0.9, sanitization: { passed: true, findings: [], highestSeverity: 'none' } },
  },
  entropyResult: { score: 0.9, entityNovelty: 1, semanticNovelty: 1, accepted: true },
  vectorCandidates: [] as Array<{ id: string; content: string; similarity: number; importance: number }>,
  conflictCandidates: [] as Array<{ id: string; content: string; similarity: number; importance: number }>,
  shouldDefer: false,
  audnDecision: {
    action: 'NOOP' as const,
    targetMemoryId: 'existing-1',
    updatedContent: null,
    contradictionConfidence: null,
  },
  storedMemoryId: 'memory-1',
  writeFileSync: vi.fn(),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => true),
  mkdirSync: vi.fn(),
  writeFileSync: state.writeFileSync,
}));

vi.mock('../consensus-extraction.js', () => ({
  consensusExtractFacts: vi.fn(async () => state.facts),
}));
vi.mock('../quick-extraction.js', () => ({
  quickExtractFacts: vi.fn(() => state.facts),
}));
vi.mock('../embedding.js', () => ({
  embedText: vi.fn(async () => [0.1, 0.2]),
}));
vi.mock('../write-security.js', () => ({
  assessWriteSecurity: vi.fn(() => state.writeSecurity),
  recordRejectedWrite: vi.fn(),
}));
vi.mock('../entropy-gate.js', () => ({
  computeEntropyScore: vi.fn(() => state.entropyResult),
}));
vi.mock('../timing.js', () => ({
  timed: vi.fn(async (_name: string, fn: () => unknown) => fn()),
}));
vi.mock('../ingest-post-write.js', () => ({
  runPostWriteProcessors: vi.fn(async () => ({ linksCreated: 0, compositesCreated: 0 })),
}));
vi.mock('../memory-storage.js', () => ({
  resolveDeterministicClaimSlot: vi.fn(async () => null),
  findSlotConflictCandidates: vi.fn(async () => []),
  findConflictCandidates: vi.fn(async () => state.conflictCandidates),
  storeCanonicalFact: vi.fn(async () => ({ outcome: 'stored', memoryId: state.storedMemoryId })),
  applyEntityScopedDedup: vi.fn(async (_deps, decision) => decision),
  ensureClaimTarget: vi.fn(async () => ({ claimId: 'c1', versionId: 'v1', memoryId: 'existing-1' })),
  storeProjection: vi.fn(),
}));
vi.mock('../conflict-policy.js', () => ({
  mergeCandidates: vi.fn((left: unknown[], right: unknown[]) => [...left, ...right]),
  applyClarificationOverrides: vi.fn((decision: unknown) => decision),
}));
vi.mock('../extraction-cache.js', () => ({
  cachedResolveAUDN: vi.fn(async () => state.audnDecision),
}));
vi.mock('../deferred-audn.js', () => ({
  shouldDeferAudn: vi.fn(() => state.shouldDefer),
  deferMemoryForReconciliation: vi.fn(async () => {}),
}));
vi.mock('../memory-network.js', () => ({
  applyOpinionSignal: vi.fn(),
  audnActionToOpinionSignal: vi.fn(),
}));
vi.mock('../memory-lineage.js', () => ({
  emitLineageEvent: vi.fn(async () => null),
}));
vi.mock('../audit-events.js', () => ({
  emitAuditEvent: vi.fn(),
}));
vi.mock('../lesson-service.js', () => ({
  recordContradictionLesson: vi.fn(async () => {}),
}));

const { performIngest, performQuickIngest, performStoreVerbatim } = await import('../memory-ingest.js');

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    config: {
      audnCandidateThreshold: 0.7,
      auditLoggingEnabled: false,
      chunkedExtractionEnabled: false,
      chunkedExtractionFallbackEnabled: false,
      chunkSizeTurns: 4,
      chunkOverlapTurns: 1,
      compositeGroupingEnabled: false,
      compositeMinClusterSize: 2,
      consensusExtractionEnabled: false,
      consensusExtractionRuns: 1,
      entityGraphEnabled: false,
      entropyGateAlpha: 0.5,
      entropyGateEnabled: true,
      entropyGateThreshold: 0.35,
      extractionCacheEnabled: false,
      fastAudnEnabled: true,
      fastAudnDuplicateThreshold: 0.95,
      ingestTraceDir: './.traces/ingest',
      ingestTraceEnabled: true,
      lessonsEnabled: false,
      llmModel: 'test-llm',
      trustScoringEnabled: true,
      trustScoreMinThreshold: 0.3,
      ...overrides,
    },
    stores: {
      episode: { storeEpisode: vi.fn(async () => 'episode-1') },
      search: {
        findNearDuplicates: vi.fn(async () => state.vectorCandidates),
      },
      memory: {
        storeMemory: vi.fn(async () => 'verbatim-1'),
      },
      link: {},
      representation: {},
      claim: { addEvidence: vi.fn(async () => {}) },
      entity: null,
      lesson: null,
      pool: {},
    },
    observationService: null,
    uriResolver: {},
  } as any;
}

function resetState(): void {
  state.facts = [
    {
      fact: 'User prefers Rust',
      headline: 'Prefers Rust',
      importance: 0.8,
      type: 'preference',
      keywords: ['rust'],
      entities: [],
      relations: [],
    },
  ];
  state.writeSecurity = {
    allowed: true,
    blockedBy: null,
    trust: { score: 0.9, sanitization: { passed: true, findings: [], highestSeverity: 'none' } },
  };
  state.entropyResult = { score: 0.9, entityNovelty: 1, semanticNovelty: 1, accepted: true };
  state.vectorCandidates = [];
  state.conflictCandidates = [];
  state.shouldDefer = false;
  state.audnDecision = {
    action: 'NOOP',
    targetMemoryId: 'existing-1',
    updatedContent: null,
    contradictionConfidence: null,
  };
  state.storedMemoryId = 'memory-1';
  state.writeFileSync.mockReset();
}

function latestTrace(): Record<string, unknown> {
  const json = state.writeFileSync.mock.calls.at(-1)?.[1];
  return JSON.parse(String(json));
}

function firstFactDecision() {
  const trace = latestTrace();
  const facts = trace.facts as Array<{ decision: Record<string, unknown>; outcome: string; memoryId: string | null }>;
  return facts[0]!;
}

describe('ingest trace branches', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetState();
  });

  it('captures direct-store-no-candidates during full ingest', async () => {
    const result = await performIngest(makeDeps(), 'user-1', 'conversation', 'chat');
    expect(result.ingestTraceId).toMatch(/^ingest-trace-/);
    expect(firstFactDecision().decision).toMatchObject({
      source: 'direct-store',
      action: 'ADD',
      reasonCode: 'direct-store-no-candidates',
    });
  });

  it('captures quick-duplicate-noop during quick ingest', async () => {
    state.vectorCandidates = [{ id: 'existing-1', content: 'User prefers Rust', similarity: 0.97, importance: 0.8 }];
    await performQuickIngest(makeDeps(), 'user-1', 'conversation', 'chat');
    expect(firstFactDecision().decision).toMatchObject({
      source: 'quick-dedup',
      action: 'NOOP',
      reasonCode: 'quick-duplicate-noop',
      targetMemoryId: 'existing-1',
    });
  });

  it('captures fast-audn-noop during full ingest', async () => {
    state.conflictCandidates = [{ id: 'existing-1', content: 'User prefers Rust', similarity: 0.98, importance: 0.8 }];
    await performIngest(makeDeps({ fastAudnEnabled: true }), 'user-1', 'conversation', 'chat');
    expect(firstFactDecision().decision).toMatchObject({
      source: 'fast-audn',
      action: 'NOOP',
      reasonCode: 'fast-audn-noop',
      targetMemoryId: 'existing-1',
    });
  });

  it('captures deferred-audn-store during full ingest', async () => {
    state.conflictCandidates = [{ id: 'existing-1', content: 'old fact', similarity: 0.7, importance: 0.5 }];
    state.shouldDefer = true;
    await performIngest(makeDeps({ fastAudnEnabled: false }), 'user-1', 'conversation', 'chat');
    expect(firstFactDecision().decision).toMatchObject({
      source: 'deferred-audn',
      action: 'ADD',
      reasonCode: 'deferred-audn-store',
    });
  });

  it('captures write-security blocks during full ingest', async () => {
    state.writeSecurity = {
      allowed: false,
      blockedBy: 'trust',
      trust: { score: 0.1, sanitization: { passed: true, findings: [], highestSeverity: 'none' } },
    } as any;
    await performIngest(makeDeps(), 'user-1', 'conversation', 'chat');
    expect(firstFactDecision().decision).toMatchObject({
      source: 'write-security',
      action: 'SKIP',
      reasonCode: 'write-security-trust',
    });
  });

  it('captures entropy-gate blocks during full ingest', async () => {
    state.entropyResult = { score: 0.1, entityNovelty: 0.1, semanticNovelty: 0.1, accepted: false };
    await performIngest(makeDeps({ entropyGateEnabled: true }), 'user-1', 'conversation', 'chat');
    expect(firstFactDecision().decision).toMatchObject({
      source: 'entropy-gate',
      action: 'SKIP',
      reasonCode: 'entropy-gate',
    });
  });

  it('captures verbatim-store during storeVerbatim', async () => {
    const result = await performStoreVerbatim(makeDeps(), 'user-1', 'raw uploaded text', 'upload');
    expect(result.ingestTraceId).toMatch(/^ingest-trace-/);
    expect(firstFactDecision().decision).toMatchObject({
      source: 'verbatim',
      action: 'ADD',
      reasonCode: 'verbatim-store',
    });
  });
});
