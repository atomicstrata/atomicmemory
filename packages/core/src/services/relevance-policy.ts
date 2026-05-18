/**
 * Score semantics and relevance threshold policy for retrieval packaging.
 */

import type { SearchResult } from '../db/repository-types.js';
import { classifyQueryDetailed, resolveRecallBypass, type QueryComplexityLabel } from './retrieval-policy.js';

export interface RelevanceGateConfig {
  similarityThreshold: number;
}

export interface RelevanceGateContext {
  asOf?: string;
  sourceSite?: string;
}

export interface RelevanceGate {
  threshold: number | null;
  source: 'request' | 'config' | 'disabled';
  reason: string;
  queryLabel: QueryComplexityLabel;
}

export interface RelevanceFilterDecision {
  id: string;
  sourceSite: string;
  sourceKind: 'integration' | 'local';
  namespace: string | null;
  semanticSimilarity: number;
  rankingScore: number;
  relevance: number;
  threshold: number | null;
  decision: 'kept' | 'filtered';
  reason: string;
}

export interface RelevanceFilterResult {
  memories: SearchResult[];
  decisions: RelevanceFilterDecision[];
  removedIds: string[];
}

type ScoredSearchResult = SearchResult & {
  semantic_similarity: number;
  ranking_score: number;
  relevance: number;
};

const INTEGRATION_SOURCE_PREFIXES = ['integration-', 'integration_', 'integration:', 'integration/'];
const KNOWN_INTEGRATION_SOURCE_SITES = new Set([
  'integration',
  'gmail',
  'gmail.com',
  'google-drive',
  'google_drive',
  'drive.google.com',
  'docs.google.com',
  'mail.google.com',
  'x.com',
  'twitter',
  'twitter.com',
]);

export function resolveRelevanceGate(
  query: string,
  requestedThreshold: number | undefined,
  runtimeConfig: RelevanceGateConfig,
  context: RelevanceGateContext = {},
): RelevanceGate {
  const queryLabel = classifyQueryDetailed(query).label;
  // Explicit caller policy is authoritative; recall-preserving bypasses below
  // only relax the config default when the request has not supplied a floor.
  if (requestedThreshold !== undefined) {
    return buildGate(requestedThreshold, 'request', 'caller-threshold', queryLabel);
  }
  const bypassReason = resolveRecallBypass(query, queryLabel, context);
  if (bypassReason) return { threshold: null, source: 'disabled', reason: bypassReason, queryLabel };
  return buildGate(runtimeConfig.similarityThreshold, 'config', 'direct-query-default', queryLabel);
}

export function applyRelevanceFilter(
  memories: SearchResult[],
  gate: RelevanceGate,
): RelevanceFilterResult {
  const scored = memories.map(withScoreSemantics);
  const decisions = scored.map((memory) => buildDecision(memory, gate));
  if (gate.threshold === null) return { memories: scored, decisions, removedIds: [] };

  const keptIds = new Set(
    decisions.filter((decision) => decision.decision === 'kept').map((decision) => decision.id),
  );
  return {
    memories: scored.filter((memory) => keptIds.has(memory.id)),
    decisions,
    removedIds: decisions.filter((decision) => decision.decision === 'filtered').map((decision) => decision.id),
  };
}

function withScoreSemantics(memory: SearchResult): ScoredSearchResult {
  const semanticSimilarity = finiteOrZero(memory.semantic_similarity ?? memory.similarity);
  const rankingScore = finiteOrZero(memory.ranking_score ?? memory.score);
  const relevance = clampUnit(memory.relevance ?? semanticSimilarity);
  return {
    ...memory,
    semantic_similarity: semanticSimilarity,
    ranking_score: rankingScore,
    relevance,
  };
}

function buildGate(
  rawThreshold: number,
  source: RelevanceGate['source'],
  reason: string,
  queryLabel: QueryComplexityLabel,
): RelevanceGate {
  const threshold = clampUnit(rawThreshold);
  return { threshold, source, reason, queryLabel };
}

function buildDecision(memory: ScoredSearchResult, gate: RelevanceGate): RelevanceFilterDecision {
  const sourceKind = classifySourceKind(memory.source_site);
  const threshold = gate.threshold;
  const kept = threshold === null || memory.relevance >= threshold;
  return {
    id: memory.id,
    sourceSite: memory.source_site,
    sourceKind,
    namespace: memory.namespace ?? null,
    semanticSimilarity: memory.semantic_similarity,
    rankingScore: memory.ranking_score,
    relevance: memory.relevance,
    threshold,
    decision: kept ? 'kept' : 'filtered',
    reason: buildReason(kept, gate, sourceKind),
  };
}

function buildReason(
  kept: boolean,
  gate: RelevanceGate,
  sourceKind: RelevanceFilterDecision['sourceKind'],
): string {
  if (gate.threshold === null) return gate.reason;
  if (sourceKind === 'integration') {
    return kept ? 'integration-meets-threshold' : 'integration-below-threshold';
  }
  return kept ? 'meets-threshold' : 'below-threshold';
}

function classifySourceKind(sourceSite: string): RelevanceFilterDecision['sourceKind'] {
  const normalized = normalizeSourceSite(sourceSite);
  if (INTEGRATION_SOURCE_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return 'integration';
  }
  return KNOWN_INTEGRATION_SOURCE_SITES.has(normalized) ? 'integration' : 'local';
}

function normalizeSourceSite(sourceSite: string): string {
  const trimmed = sourceSite.trim().toLowerCase();
  if (!trimmed) return trimmed;
  try {
    const parsed = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
    return parsed.hostname.replace(/^www\./, '');
  } catch {
    return trimmed;
  }
}

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
