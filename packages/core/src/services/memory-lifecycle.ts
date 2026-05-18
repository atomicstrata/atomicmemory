/**
 * Memory lifecycle management: decay cycle and memory count cap.
 *
 * Decay cycle: Computes a retention score for each memory using the same
 * three-signal formula as retrieval scoring (similarity excluded since there's
 * no query). Memories below the retention threshold are archived (soft-deleted).
 * This implements the Ebbinghaus forgetting curve for long-term store health.
 *
 * Memory count cap: Checks whether a user's active memory count exceeds
 * a configured limit and returns a recommendation for whether consolidation
 * or decay should run.
 *
 * Both features are pure functions over memory data + config — they compute
 * what should happen but let the caller decide when to act.
 */

import type { MemoryRow } from '../db/repository-types.js';

/** 30-day time constant in milliseconds, matching the SQL decay formula. */
const DECAY_TAU_MS = 2_592_000_000;

export interface DecayConfig {
  /** Retention score below which memories are archived. */
  retentionThreshold: number;
  /** Weight for importance in retention score. */
  importanceWeight: number;
  /** Weight for recency in retention score. */
  recencyWeight: number;
  /** Weight for access frequency in retention score. */
  accessWeight: number;
  /** Minimum age in milliseconds before a memory can be decayed. */
  minAgeMs: number;
}

export const DEFAULT_DECAY_CONFIG: DecayConfig = {
  retentionThreshold: 0.2,
  importanceWeight: 0.4,
  recencyWeight: 0.4,
  accessWeight: 0.2,
  minAgeMs: 7 * 24 * 60 * 60 * 1000, // 7 days
};

export interface DecayCandidate {
  id: string;
  content: string;
  retentionScore: number;
  importance: number;
  daysSinceAccess: number;
  accessCount: number;
}

export interface DecayResult {
  memoriesEvaluated: number;
  candidatesForArchival: DecayCandidate[];
  retentionThreshold: number;
  avgRetentionScore: number;
}

/**
 * Compute the retention score for a single memory.
 *
 * Formula: importanceWeight * importance + recencyWeight * recency + accessWeight * accessFreq
 * Where recency = exp(-timeSinceAccess / TAU) and accessFreq = min(1, accessCount / 10).
 */
export function computeRetentionScore(
  memory: Pick<MemoryRow, 'importance' | 'last_accessed_at' | 'access_count' | 'trust_score'>,
  referenceTime: Date,
  decayConfig: DecayConfig,
): number {
  const elapsedMs = referenceTime.getTime() - memory.last_accessed_at.getTime();
  const recency = Math.exp(-elapsedMs / DECAY_TAU_MS);
  const accessFreq = Math.min(1.0, memory.access_count / 10);
  const rawScore = (decayConfig.importanceWeight * memory.importance)
    + (decayConfig.recencyWeight * recency)
    + (decayConfig.accessWeight * accessFreq);
  return rawScore * (memory.trust_score ?? 1.0);
}

/**
 * Evaluate a batch of memories and identify those below the retention threshold.
 * Does not modify any data — returns candidates for the caller to archive.
 */
export function evaluateDecayCandidates(
  memories: MemoryRow[],
  referenceTime: Date,
  decayConfig: DecayConfig = DEFAULT_DECAY_CONFIG,
): DecayResult {
  const eligible = memories.filter((m) => {
    const ageMs = referenceTime.getTime() - m.created_at.getTime();
    return ageMs >= decayConfig.minAgeMs;
  });

  const scored = eligible.map((m) => {
    const retentionScore = computeRetentionScore(m, referenceTime, decayConfig);
    const elapsedMs = referenceTime.getTime() - m.last_accessed_at.getTime();
    return {
      id: m.id,
      content: m.content,
      retentionScore,
      importance: m.importance,
      daysSinceAccess: elapsedMs / (24 * 60 * 60 * 1000),
      accessCount: m.access_count,
    };
  });

  const candidates = scored
    .filter((s) => s.retentionScore < decayConfig.retentionThreshold)
    .sort((a, b) => a.retentionScore - b.retentionScore);

  const totalScore = scored.reduce((sum, s) => sum + s.retentionScore, 0);
  const avgRetentionScore = scored.length > 0 ? totalScore / scored.length : 0;

  return {
    memoriesEvaluated: eligible.length,
    candidatesForArchival: candidates,
    retentionThreshold: decayConfig.retentionThreshold,
    avgRetentionScore,
  };
}

export interface CapConfig {
  /** Maximum number of active memories before triggering lifecycle actions. */
  maxMemories: number;
  /** Warn threshold as a fraction of maxMemories (0.0-1.0). */
  warnRatio: number;
}

const DEFAULT_CAP_CONFIG: CapConfig = {
  maxMemories: 5000,
  warnRatio: 0.8,
};

export type CapStatus = 'ok' | 'warn' | 'exceeded';

export interface CapCheckResult {
  activeMemories: number;
  maxMemories: number;
  status: CapStatus;
  usageRatio: number;
  recommendation: CapRecommendation;
}

export type CapRecommendation = 'none' | 'consolidate' | 'decay' | 'consolidate-and-decay';

/**
 * Check whether a user's memory count is within the configured cap.
 * Returns a status and recommendation for what lifecycle action to take.
 */
export function checkMemoryCap(
  activeMemories: number,
  capConfig: CapConfig = DEFAULT_CAP_CONFIG,
): CapCheckResult {
  const usageRatio = activeMemories / capConfig.maxMemories;
  const status = resolveCapStatus(usageRatio, capConfig.warnRatio);
  const recommendation = resolveRecommendation(status, usageRatio);

  return {
    activeMemories,
    maxMemories: capConfig.maxMemories,
    status,
    usageRatio,
    recommendation,
  };
}

function resolveCapStatus(usageRatio: number, warnRatio: number): CapStatus {
  if (usageRatio >= 1.0) return 'exceeded';
  if (usageRatio >= warnRatio) return 'warn';
  return 'ok';
}

function resolveRecommendation(status: CapStatus, usageRatio: number): CapRecommendation {
  if (status === 'ok') return 'none';
  if (status === 'warn') return 'consolidate';
  if (usageRatio >= 1.2) return 'consolidate-and-decay';
  return 'decay';
}
