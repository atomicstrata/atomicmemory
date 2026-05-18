/**
 * Retrieval profile definitions for safe, balanced, and quality modes.
 */

export type RetrievalProfileName = 'safe' | 'balanced' | 'quality';

export interface RetrievalProfile {
  name: RetrievalProfileName;
  maxSearchResults: number;
  repairLoopEnabled: boolean;
  adaptiveRetrievalEnabled: boolean;
  hybridSearchEnabled: boolean;
  repairLoopMinSimilarity: number;
  repairSkipSimilarity: number;
  rerankDepth: number;
  repairPrimaryWeight: number;
  repairRewriteWeight: number;
  lexicalWeight: number;
  mmrEnabled: boolean;
  mmrLambda: number;
  linkExpansionEnabled: boolean;
  linkExpansionMax: number;
  linkSimilarityThreshold: number;
  scoringWeightSimilarity: number;
  scoringWeightImportance: number;
  scoringWeightRecency: number;
  /**
   * Minimum semantic similarity required before importance/recency ranking
   * boosts apply, and before direct simple/medium queries consider a candidate
   * eligible for injection. Safe is stricter; quality keeps a little more
   * recall for borderline matches.
   */
  rankingMinSimilarity: number;
  linkExpansionBeforeMMR: boolean;
  repairDeltaThreshold: number;
  repairConfidenceFloor: number;
}

const PROFILES: Record<RetrievalProfileName, RetrievalProfile> = {
  safe: {
    name: 'safe',
    maxSearchResults: 5,
    repairLoopEnabled: false,
    adaptiveRetrievalEnabled: false,
    hybridSearchEnabled: false,
    repairLoopMinSimilarity: 0.8,
    repairSkipSimilarity: 0.65,
    rerankDepth: 5,
    repairPrimaryWeight: 1,
    repairRewriteWeight: 0,
    lexicalWeight: 0.4,
    mmrEnabled: false,
    mmrLambda: 0.7,
    linkExpansionEnabled: false,
    linkExpansionMax: 0,
    linkSimilarityThreshold: 0.5,
    scoringWeightSimilarity: 2.0,
    scoringWeightImportance: 1.0,
    scoringWeightRecency: 1.0,
    rankingMinSimilarity: 0.35,
    linkExpansionBeforeMMR: false,
    repairDeltaThreshold: 0,
    repairConfidenceFloor: 0,
  },
  balanced: {
    name: 'balanced',
    maxSearchResults: 12,
    repairLoopEnabled: true,
    adaptiveRetrievalEnabled: true,
    hybridSearchEnabled: false,
    repairLoopMinSimilarity: 0.72,
    repairSkipSimilarity: 0.65,
    rerankDepth: 16,
    repairPrimaryWeight: 1,
    repairRewriteWeight: 0.92,
    lexicalWeight: 0.8,
    mmrEnabled: true,
    mmrLambda: 0.85,
    linkExpansionEnabled: true,
    linkExpansionMax: 3,
    linkSimilarityThreshold: 0.5,
    scoringWeightSimilarity: 2.0,
    scoringWeightImportance: 1.0,
    scoringWeightRecency: 1.0,
    rankingMinSimilarity: 0.3,
    linkExpansionBeforeMMR: false,
    repairDeltaThreshold: 0,
    repairConfidenceFloor: 0,
  },
  quality: {
    name: 'quality',
    maxSearchResults: 12,
    repairLoopEnabled: true,
    adaptiveRetrievalEnabled: true,
    hybridSearchEnabled: true,
    repairLoopMinSimilarity: 0.78,
    repairSkipSimilarity: 0.65,
    rerankDepth: 12,
    repairPrimaryWeight: 1,
    repairRewriteWeight: 1.05,
    lexicalWeight: 1.15,
    mmrEnabled: true,
    mmrLambda: 0.6,
    linkExpansionEnabled: true,
    linkExpansionMax: 4,
    linkSimilarityThreshold: 0.45,
    scoringWeightSimilarity: 2.0,
    scoringWeightImportance: 1.0,
    scoringWeightRecency: 1.0,
    rankingMinSimilarity: 0.25,
    linkExpansionBeforeMMR: false,
    repairDeltaThreshold: 0,
    repairConfidenceFloor: 0,
  },
};

export function parseRetrievalProfile(value: string | undefined): RetrievalProfileName {
  if (!value) return 'balanced';
  if (value === 'safe' || value === 'balanced' || value === 'quality') return value;
  throw new Error('Invalid RETRIEVAL_PROFILE. Must be "safe", "balanced", or "quality"');
}

export function getRetrievalProfile(name: RetrievalProfileName): RetrievalProfile {
  return PROFILES[name];
}
