/**
 * Per-fact ingest pipeline: embed, gate, find candidates, decide, store.
 *
 * Unifies the three per-fact paths (full, quick, workspace) behind a single
 * parameterized function. Each path is a different combination of options
 * rather than a separate code path.
 */

import { embedText } from './embedding.js';
import { mergeCandidates } from './conflict-policy.js';
import { computeEntropyScore } from './entropy-gate.js';
import { assessWriteSecurity, recordRejectedWrite } from './write-security.js';
import { previewContent } from './ingest-trace.js';
import { timed } from './timing.js';
import { storeCanonicalFact, resolveDeterministicClaimSlot, findSlotConflictCandidates } from './memory-storage.js';
import { findFilteredCandidates, resolveAndExecuteAudn } from './memory-audn.js';
import type { WorkspaceContext } from '../db/repository-types.js';
import type {
  AudnFactContext,
  EntropyContext,
  FactInput,
  FactResult,
  IngestFactTrace,
  IngestTraceAction,
  IngestTraceCandidate,
  IngestTraceDecision,
  MemoryServiceDeps,
} from './memory-service-types.js';

// ---------------------------------------------------------------------------
// Pipeline options
// ---------------------------------------------------------------------------

/** Controls which stages of the per-fact pipeline are active. */
export interface FactPipelineOptions {
  /** When set, scopes candidate finding and storage to this workspace. */
  workspace?: WorkspaceContext;
  /** Run the entropy gate before candidate search (off for quick-ingest). */
  entropyGate: boolean;
  /** Run the full AUDN path (fast + deferred + LLM). When false, uses quick duplicate threshold only. */
  fullAudn: boolean;
  /** Mutable set of superseded target IDs, shared across a batch. */
  supersededTargets: Set<string>;
  /** Mutable entropy context, shared across a batch. */
  entropyCtx: EntropyContext;
  /** Optional logical timestamp for backdating. */
  logicalTimestamp?: Date;
  /** Timing label prefix for timed() wrappers. */
  timingPrefix: string;
  /** Optional per-request trace collector. */
  traceCollector?: { record(trace: IngestFactTrace): void };
}

// ---------------------------------------------------------------------------
// Main pipeline function
// ---------------------------------------------------------------------------

/** Process a single extracted fact through the ingest pipeline. */
export async function processFactThroughPipeline(
  deps: MemoryServiceDeps,
  userId: string,
  fact: FactInput,
  sourceSite: string,
  sourceUrl: string,
  episodeId: string,
  options: FactPipelineOptions,
): Promise<FactResult> {
  if (options.workspace) {
    return processWorkspaceFact(deps, userId, fact, sourceSite, sourceUrl, episodeId, options);
  }
  if (options.fullAudn) {
    return processFullAudnFact(deps, userId, fact, sourceSite, sourceUrl, episodeId, options);
  }
  return processQuickFact(deps, userId, fact, sourceSite, sourceUrl, episodeId, options);
}

// ---------------------------------------------------------------------------
// Full AUDN path (performIngest)
// ---------------------------------------------------------------------------

async function processFullAudnFact(
  deps: MemoryServiceDeps,
  userId: string,
  fact: FactInput,
  sourceSite: string,
  sourceUrl: string,
  episodeId: string,
  options: FactPipelineOptions,
): Promise<FactResult> {
  const embedding = await timed(`${options.timingPrefix}.fact.embed`, () => embedText(fact.fact));
  const writeSecurity = assessWriteSecurity(fact.fact, sourceSite, deps.config);

  if (!writeSecurity.allowed) {
    await recordRejectedWrite(userId, fact.fact, sourceSite, writeSecurity, deps.config, deps.stores.lesson);
    return blockedResult(options, fact, writeSecurity, undefined, blockedReasonCode(writeSecurity.blockedBy));
  }

  const entropyResult = options.entropyGate
    ? assessEntropyGate(fact, embedding, options.entropyCtx, deps.config)
    : null;
  if (entropyResult && !entropyResult.accepted) {
    return blockedResult(options, fact, writeSecurity, entropyResult, 'entropy-gate');
  }

  const claimSlot = await resolveDeterministicClaimSlot(deps, userId, fact);
  const filteredCandidates = await findFilteredCandidates(deps, userId, fact, embedding, claimSlot, options.supersededTargets);
  const candidates = toTraceCandidates(filteredCandidates);

  const ctx: AudnFactContext = {
    userId, fact, embedding, sourceSite, sourceUrl, episodeId,
    trustScore: writeSecurity.trust.score, claimSlot, logicalTimestamp: options.logicalTimestamp,
  };

  if (filteredCandidates.length === 0) {
    const result = await storeCanonicalFact(deps, ctx);
    return storedDirectResult(options, result, embedding, fact, writeSecurity, candidates, entropyResult, 'direct-store-no-candidates');
  }

  return tracedResult(options, await resolveAndExecuteAudn(
    deps, userId, fact, embedding, sourceSite, sourceUrl, episodeId,
    writeSecurity.trust.score, claimSlot, options.logicalTimestamp,
    filteredCandidates, options.supersededTargets,
    undefined,
    {
      fact,
      logicalTimestamp: options.logicalTimestamp,
      writeSecurity,
      entropyResult,
      candidates,
    },
  ));
}

// ---------------------------------------------------------------------------
// Quick path (performQuickIngest)
// ---------------------------------------------------------------------------

async function processQuickFact(
  deps: MemoryServiceDeps,
  userId: string,
  fact: FactInput,
  sourceSite: string,
  sourceUrl: string,
  episodeId: string,
  options: FactPipelineOptions,
): Promise<FactResult> {
  const embedding = await timed(`${options.timingPrefix}.fact.embed`, () => embedText(fact.fact));
  const writeSecurity = assessWriteSecurity(fact.fact, sourceSite, deps.config);
  if (!writeSecurity.allowed) {
    return blockedResult(options, fact, writeSecurity, undefined, blockedReasonCode(writeSecurity.blockedBy));
  }
  const claimSlot = await resolveDeterministicClaimSlot(deps, userId, fact);

  const [vectorCandidates, slotCandidates] = await timed(`${options.timingPrefix}.fact.find-dupes`, async () => Promise.all([
    deps.stores.search.findNearDuplicates(userId, embedding, deps.config.audnCandidateThreshold),
    findSlotConflictCandidates(deps, userId, claimSlot),
  ]));
  const candidates = mergeCandidates(vectorCandidates, slotCandidates);
  const traceCandidates = toTraceCandidates(candidates);

  if (candidates.length > 0) {
    const topCandidate = candidates.reduce((a, b) => a.similarity > b.similarity ? a : b);
    if (topCandidate.similarity >= deps.config.fastAudnDuplicateThreshold) {
      return tracedResult(options, {
        outcome: 'skipped',
        memoryId: topCandidate.id,
        trace: buildFactTrace(fact, options.logicalTimestamp, {
          writeSecurity,
          candidates: traceCandidates,
          decision: makeDecision('quick-dedup', 'NOOP', 'quick-duplicate-noop', topCandidate.id, ['raw-near-duplicate']),
        }, 'skipped', topCandidate.id),
      });
    }
  }

  const ctx: AudnFactContext = { userId, fact, embedding, sourceSite, sourceUrl, episodeId, trustScore: writeSecurity.trust.score, claimSlot, logicalTimestamp: options.logicalTimestamp };
  const result = await storeCanonicalFact(deps, ctx);
  return storedDirectResult(options, result, embedding, fact, writeSecurity, traceCandidates, undefined, 'direct-store-no-candidates');
}

// ---------------------------------------------------------------------------
// Workspace path (performWorkspaceIngest)
// ---------------------------------------------------------------------------

async function processWorkspaceFact(
  deps: MemoryServiceDeps,
  userId: string,
  fact: FactInput,
  sourceSite: string,
  sourceUrl: string,
  episodeId: string,
  options: FactPipelineOptions,
): Promise<FactResult> {
  const embedding = await timed(`${options.timingPrefix}.fact.embed`, () => embedText(fact.fact));
  const writeSecurity = assessWriteSecurity(fact.fact, sourceSite, deps.config);
  if (!writeSecurity.allowed) {
    await recordRejectedWrite(userId, fact.fact, sourceSite, writeSecurity, deps.config);
    return blockedResult(options, fact, writeSecurity, undefined, blockedReasonCode(writeSecurity.blockedBy));
  }

  const candidates = await deps.stores.search.findNearDuplicatesInWorkspace(
    options.workspace!.workspaceId, embedding, deps.config.audnCandidateThreshold, 10, 'all', options.workspace!.agentId,
  );
  const traceCandidates = toTraceCandidates(candidates);

  const ctx: AudnFactContext = {
    userId, fact, embedding, sourceSite, sourceUrl, episodeId,
    trustScore: writeSecurity.trust.score, workspace: options.workspace,
  };

  if (candidates.length === 0) {
    const result = await storeCanonicalFact(deps, ctx);
    return storedDirectResult(options, result, embedding, fact, writeSecurity, traceCandidates, undefined, 'workspace-direct-store');
  }

  return tracedResult(options, await resolveAndExecuteAudn(
    deps, userId, fact, embedding, sourceSite, sourceUrl, episodeId,
    writeSecurity.trust.score, null, undefined,
    candidates.map((c) => ({ ...c, content: c.content ?? '' })),
    options.supersededTargets,
    options.workspace,
    {
      fact,
      logicalTimestamp: options.logicalTimestamp,
      writeSecurity,
      candidates: traceCandidates,
    },
  ));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Check entropy gate; returns false if the fact should be skipped. */
function assessEntropyGate(
  fact: FactInput,
  embedding: number[],
  entropyCtx: EntropyContext,
  runtimeConfig: Pick<
    MemoryServiceDeps['config'],
    'entropyGateEnabled' | 'entropyGateThreshold' | 'entropyGateAlpha'
  >,
): ReturnType<typeof computeEntropyScore> | null {
  if (!runtimeConfig.entropyGateEnabled) return null;
  const entropyResult = computeEntropyScore(
    {
      windowEntities: fact.keywords,
      existingEntities: entropyCtx.seenEntities,
      windowEmbedding: embedding,
      previousEmbedding: entropyCtx.previousEmbedding,
    },
    { threshold: runtimeConfig.entropyGateThreshold, alpha: runtimeConfig.entropyGateAlpha },
  );
  entropyCtx.previousEmbedding = embedding;
  for (const kw of fact.keywords) entropyCtx.seenEntities.add(kw);
  return entropyResult;
}

function buildFactTrace(
  fact: FactInput,
  logicalTimestamp: Date | undefined,
  details: {
    writeSecurity?: ReturnType<typeof assessWriteSecurity>;
    entropyGate?: ReturnType<typeof computeEntropyScore> | null;
    candidates?: IngestTraceCandidate[];
    decision: IngestTraceDecision;
  },
  outcome: FactResult['outcome'],
  memoryId: string | null,
): IngestFactTrace {
  return {
    factText: fact.fact,
    headline: fact.headline,
    factType: fact.type,
    importance: fact.importance,
    ...(logicalTimestamp ? { logicalTimestamp: logicalTimestamp.toISOString() } : {}),
    ...(details.writeSecurity ? {
      writeSecurity: {
        allowed: details.writeSecurity.allowed,
        blockedBy: details.writeSecurity.blockedBy,
        trustScore: details.writeSecurity.trust.score,
      },
    } : {}),
    ...(details.entropyGate ? { entropyGate: details.entropyGate } : {}),
    ...(details.candidates ? { candidates: details.candidates } : {}),
    decision: details.decision,
    outcome,
    memoryId,
  };
}

function makeDecision(
  source: IngestTraceDecision['source'],
  action: IngestTraceAction,
  reasonCode: IngestTraceDecision['reasonCode'],
  targetMemoryId: string | null,
  rawAction?: string[],
): IngestTraceDecision {
  return {
    source,
    action,
    reasonCode,
    targetMemoryId,
    ...(rawAction?.[0] ? { rawAction: rawAction[0] } : {}),
  };
}

function toTraceCandidates(
  candidates: Array<{ id: string; similarity: number; content: string }>,
): IngestTraceCandidate[] {
  return candidates.map((candidate) => ({
    id: candidate.id,
    similarity: Math.round(candidate.similarity * 10000) / 10000,
    contentPreview: previewContent(candidate.content),
  }));
}

function blockedReasonCode(
  blockedBy: ReturnType<typeof assessWriteSecurity>['blockedBy'],
): IngestTraceDecision['reasonCode'] {
  return blockedBy === 'sanitization'
    ? 'write-security-sanitization'
    : 'write-security-trust';
}

function tracedResult(options: FactPipelineOptions, result: FactResult): FactResult {
  if (result.trace) options.traceCollector?.record(result.trace);
  return result;
}

function blockedResult(
  options: FactPipelineOptions,
  fact: FactInput,
  writeSecurity: ReturnType<typeof assessWriteSecurity>,
  entropyResult: ReturnType<typeof computeEntropyScore> | null | undefined,
  reasonCode: IngestTraceDecision['reasonCode'],
): FactResult {
  return tracedResult(options, {
    outcome: 'skipped',
    memoryId: null,
    trace: buildFactTrace(fact, options.logicalTimestamp, {
      writeSecurity,
      entropyGate: entropyResult,
      decision: makeDecision(
        reasonCode === 'entropy-gate' ? 'entropy-gate' : 'write-security',
        'SKIP',
        reasonCode,
        null,
      ),
    }, 'skipped', null),
  });
}

function storedDirectResult(
  options: FactPipelineOptions,
  result: Awaited<ReturnType<typeof storeCanonicalFact>>,
  embedding: number[],
  fact: FactInput,
  writeSecurity: ReturnType<typeof assessWriteSecurity>,
  candidates: IngestTraceCandidate[],
  entropyResult: ReturnType<typeof computeEntropyScore> | null | undefined,
  reasonCode: 'direct-store-no-candidates' | 'workspace-direct-store',
): FactResult {
  return tracedResult(options, {
    ...result,
    embedding,
    trace: buildFactTrace(fact, options.logicalTimestamp, {
      writeSecurity,
      entropyGate: entropyResult,
      candidates,
      decision: makeDecision('direct-store', 'ADD', reasonCode, null),
    }, result.outcome, result.memoryId),
  });
}
