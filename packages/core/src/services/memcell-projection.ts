/**
 * Deterministic projection helpers for dual-write memory cells.
 * These helpers keep retrieval-oriented child rows aligned with the parent
 * memory projection without adding a second LLM step yet.
 */

import type {
  AtomicFactProjection,
  FactInput,
  ForesightProjection,
} from './memory-service-types.js';

/**
 * Build the retrieval-facing atomic fact row for a parent memory.
 * Current prototype uses one canonical fact row per stored fact; later work can
 * expand this to multiple child facts per narrative episode.
 */
export function buildAtomicFactProjection(
  fact: FactInput,
  embedding: number[],
): AtomicFactProjection {
  return {
    factText: fact.fact,
    embedding,
    factType: fact.type,
    importance: fact.importance,
    keywords: fact.keywords,
    metadata: {
      headline: fact.headline,
      entities: fact.entities,
      relations: fact.relations,
    },
  };
}

/**
 * Derive initial foresight rows from plan-like facts.
 * This is intentionally conservative: only explicit plan facts are projected.
 */
export function buildForesightProjections(
  fact: FactInput,
  embedding: number[],
): ForesightProjection[] {
  if (fact.type !== 'plan') return [];
  return [{
    content: fact.fact,
    embedding,
    foresightType: 'plan',
    metadata: {
      headline: fact.headline,
      keywords: fact.keywords,
    },
  }];
}
