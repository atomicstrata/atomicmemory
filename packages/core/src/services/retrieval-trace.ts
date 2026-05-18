/**
 * Retrieval observability trace logger.
 *
 * Captures structured per-query traces through the retrieval pipeline:
 * query → candidates → repair → MMR → link expansion → final selection.
 *
 * Traces are persisted as JSON artifacts when RETRIEVAL_TRACE_ENABLED=true.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import type { SearchResult } from '../db/memory-repository.js';
import type { RelevanceFilterDecision } from './relevance-policy.js';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const DEFAULT_TRACE_DIR = resolve(__dirname, '../../.traces');

/** A snapshot of a single memory at a pipeline stage. */
interface TracedMemory {
  id: string;
  similarity: number;
  semanticSimilarity: number;
  score: number;
  rankingScore: number;
  relevance: number;
  importance: number;
  sourceSite: string;
  namespace: string | null;
  contentPreview: string;
  tier?: string;
}

/** One stage in the retrieval pipeline. */
interface TraceStage {
  name: string;
  count: number;
  memories: TracedMemory[];
  meta?: Record<string, unknown>;
  timestamp: number;
}

/** Full trace for one retrieval operation. */
export interface RetrievalTrace {
  traceId: string;
  query: string;
  userId: string;
  timestamp: string;
  durationMs: number;
  stages: TraceStage[];
  finalResultCount: number;
  retrieval?: RetrievalTraceSummary;
  packaging?: PackagingTraceSummary;
  assembly?: AssemblyTraceSummary;
}

export interface RetrievalTraceSummary {
  candidateIds: string[];
  candidateCount: number;
  queryText: string;
  skipRepair: boolean;
  relevanceThreshold?: number | null;
  relevanceFilterSource?: string;
  relevanceFilterReason?: string;
  filteredCandidateIds?: string[];
  filterDecisions?: RelevanceFilterDecision[];
  traceId?: string;
  stageCount?: number;
  stageNames?: string[];
}

export type PackagingType = 'subject-pack' | 'timeline-pack' | 'tiered';
export type PackagingEvidenceRole = 'primary' | 'supporting' | 'historical' | 'contextual';

export interface PackagingTraceSummary {
  packageType: PackagingType;
  includedIds: string[];
  droppedIds: string[];
  evidenceRoles: Record<string, PackagingEvidenceRole>;
  episodeCount: number;
  dateCount: number;
  hasCurrentMarker: boolean;
  hasConflictBlock: boolean;
  tokenCost: number;
}

export interface AssemblyTraceSummary {
  finalIds: string[];
  finalTokenCost: number;
  tokenBudget: number | null;
  primaryEvidencePosition: number | null;
  blocks: string[];
}

const CONTENT_PREVIEW_LENGTH = 120;

function snapshotMemories(results: SearchResult[]): TracedMemory[] {
  return results.map((r) => ({
    id: r.id,
    similarity: round4(r.similarity),
    semanticSimilarity: round4(r.semantic_similarity ?? r.similarity),
    score: round4(r.score),
    rankingScore: round4(r.ranking_score ?? r.score),
    relevance: round4(r.relevance ?? r.similarity),
    importance: round4(r.importance),
    sourceSite: r.source_site,
    namespace: r.namespace ?? null,
    contentPreview: r.content.slice(0, CONTENT_PREVIEW_LENGTH),
    // @ts-expect-error -- tier might be present if added by tiered loading
    tier: r.tier,
  }));
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/**
 * Accumulates trace stages during a single search operation.
 */
export class TraceCollector {
  private stages: TraceStage[] = [];
  private retrieval?: RetrievalTraceSummary;
  private packaging?: PackagingTraceSummary;
  private assembly?: AssemblyTraceSummary;
  private startTime: number;
  private traceId: string;
  private query: string;
  private userId: string;
  private enabled: boolean;

  constructor(query: string, userId: string) {
    this.query = query;
    this.userId = userId;
    this.enabled = config.retrievalTraceEnabled;
    this.startTime = Date.now();
    this.traceId = `trace-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  }

  /** Record a pipeline stage with its current result set and optional metadata. */
  stage(name: string, results: SearchResult[], meta?: Record<string, unknown>): void {
    if (!this.enabled) return;
    this.stages.push({
      name,
      count: results.length,
      memories: snapshotMemories(results),
      meta,
      timestamp: Date.now() - this.startTime,
    });
  }

  /** Event-only stage (no memories, just metadata). */
  event(name: string, meta?: Record<string, unknown>): void {
    if (!this.enabled) return;
    this.stages.push({
      name,
      count: 0,
      memories: [],
      meta,
      timestamp: Date.now() - this.startTime,
    });
  }

  setRetrievalSummary(summary: RetrievalTraceSummary): void {
    if (!this.enabled) return;
    this.retrieval = summary;
  }

  setPackagingSummary(summary: PackagingTraceSummary): void {
    if (!this.enabled) return;
    this.packaging = summary;
  }

  setAssemblySummary(summary: AssemblyTraceSummary): void {
    if (!this.enabled) return;
    this.assembly = summary;
  }

  getRetrievalSummary(): RetrievalTraceSummary | undefined {
    if (!this.retrieval) return undefined;
    return {
      ...this.retrieval,
      traceId: this.traceId,
      stageCount: this.stages.length,
      stageNames: this.stages.map((stage) => stage.name),
    };
  }

  getPackagingSummary(): PackagingTraceSummary | undefined {
    return this.packaging;
  }

  getAssemblySummary(): AssemblyTraceSummary | undefined {
    return this.assembly;
  }

  /** Persist the full trace to disk and optionally log to stdout. */
  finalize(finalResults: SearchResult[]): string | null {
    if (!this.enabled) return null;
    this.stage('final', finalResults);

    const trace: RetrievalTrace = {
      traceId: this.traceId,
      query: this.query,
      userId: this.userId,
      timestamp: new Date().toISOString(),
      durationMs: Date.now() - this.startTime,
      stages: this.stages,
      finalResultCount: finalResults.length,
      retrieval: this.retrieval,
      packaging: this.packaging,
      assembly: this.assembly,
    };

    this.persistTrace(trace);
    return this.traceId;
  }

  private persistTrace(trace: RetrievalTrace): void {
    try {
      const filename = writeTraceArtifact(trace);
      console.log(`[trace] Saved retrieval trace: ${filename} (${trace.durationMs}ms, ${trace.stages.length} stages)`);
    } catch (err) {
      console.error('[trace] Failed to persist retrieval trace:', err);
    }
  }
}

function writeTraceArtifact(trace: RetrievalTrace): string {
  const traceDir = process.env.RETRIEVAL_TRACE_DIR ?? DEFAULT_TRACE_DIR;
  if (!existsSync(traceDir)) mkdirSync(traceDir, { recursive: true });
  const filename = `${trace.traceId}.json`;
  writeFileSync(join(traceDir, filename), JSON.stringify(trace, null, 2));
  return filename;
}
