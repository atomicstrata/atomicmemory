/**
 * Shared internal types for the memory-search pipeline.
 *
 * These shapes are private to the search internals — kept out of
 * `memory-service-types.ts` (which is the cross-module public surface)
 * but split out from `memory-search.ts` so the TLL-augmentation sibling
 * module (`tll-augmentation.ts`) can consume them without duplicating
 * definitions or introducing a circular import.
 */

import type { SearchResult } from '../db/memory-repository.js';
import type { ConsensusResult } from './consensus-validation.js';
import type { RelevanceFilterDecision } from './relevance-policy.js';

export interface RelevanceFilterSummary {
  threshold: number | null;
  source: string;
  reason: string;
  queryLabel: string;
  removedIds: string[];
  decisions: RelevanceFilterDecision[];
}

export interface PostProcessedSearch {
  memories: SearchResult[];
  consensusResult?: ConsensusResult;
  relevanceFilter: RelevanceFilterSummary;
}
