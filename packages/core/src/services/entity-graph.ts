/**
 * Entity co-occurrence graph for spreading activation retrieval.
 *
 * At ingest time: extract entities from fact text, store pairwise co-occurrence edges.
 * At query time: extract query entities, run 3-hop spreading activation, score memories
 * by accumulated activation. Returns ranked memory IDs for RRF fusion with vector search.
 */

import pg from 'pg';
import {
  storeEntityEdges,
  findNeighbors,
  findMemoriesForEntities,
  removeEntityEdges as removeEdges,
} from '../db/repository-entity-graph.js';

/** Spreading activation parameters (SLM-V3: γ=0.7, maxHops=3). */
const ACTIVATION_DECAY = 0.7;
const MAX_HOPS = 3;
const ACTIVATION_THRESHOLD = 0.01;

/** Minimum entity length for graph inclusion. */
const MIN_ENTITY_LENGTH = 3;

/**
 * Stopwords excluded from entity extraction.
 * Broader than AUDN conflict keywords — filters common verbs, prepositions, articles.
 */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'have', 'has', 'had',
  'was', 'were', 'been', 'being', 'will', 'would', 'could', 'should', 'might',
  'also', 'just', 'about', 'into', 'over', 'after', 'before', 'between',
  'through', 'during', 'each', 'other', 'some', 'such', 'than', 'then',
  'these', 'those', 'when', 'where', 'which', 'while', 'their', 'there',
  'they', 'them', 'what', 'who', 'how', 'very', 'more', 'most', 'only',
  'same', 'does', 'doing', 'done', 'using', 'used', 'uses', 'user',
  'like', 'want', 'wants', 'make', 'made', 'making', 'work', 'working',
  'plan', 'plans', 'planning', 'currently', 'recently', 'project',
  'maybe', 'might', 'perhaps', 'check', 'tomorrow', 'sure', 'think',
  'not',
]);

export interface EntityGraphResult {
  memoryId: string;
  activationScore: number;
}

/**
 * Extract entities from text for graph construction.
 * Captures: proper nouns (capitalized words), technology names, multi-word terms.
 * Returns normalized lowercase entities.
 */
export function extractEntities(text: string): string[] {
  const entities = new Set<string>();

  const words = text.match(/[A-Za-z][A-Za-z0-9._-]*/g) ?? [];
  for (const word of words) {
    const lower = word.toLowerCase();
    if (lower.length < MIN_ENTITY_LENGTH) continue;
    if (STOPWORDS.has(lower)) continue;
    entities.add(lower);
  }

  const compoundPatterns = [
    /[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+/g,
    /[A-Za-z]+[._-][A-Za-z]+/g,
  ];
  for (const pattern of compoundPatterns) {
    const matches = text.match(pattern) ?? [];
    for (const match of matches) {
      const normalized = match.toLowerCase().replace(/\s+/g, '_');
      if (normalized.length >= MIN_ENTITY_LENGTH) {
        entities.add(normalized);
      }
    }
  }

  return [...entities];
}

/** Update entity graph after storing a new memory. */
async function updateEntityGraph(
  pool: pg.Pool,
  userId: string,
  memoryId: string,
  factText: string,
): Promise<number> {
  const entities = extractEntities(factText);
  return storeEntityEdges(pool, userId, memoryId, entities);
}

/** Replace entity graph edges for a memory (used on UPDATE/SUPERSEDE). */
async function replaceEntityEdges(
  pool: pg.Pool,
  userId: string,
  memoryId: string,
  factText: string,
): Promise<number> {
  await removeEdges(pool, memoryId);
  return updateEntityGraph(pool, userId, memoryId, factText);
}

/**
 * 3-hop spreading activation from query entities.
 * Returns memories scored by accumulated activation, sorted descending.
 *
 * Algorithm:
 * 1. Seed activation map with query entities (activation=1.0)
 * 2. For each hop: find neighbors, propagate activation * γ
 * 3. Collect all activated entities, find linked memories
 * 4. Score each memory by sum of activations from its linked entities
 */
async function spreadingActivation(
  pool: pg.Pool,
  userId: string,
  queryText: string,
  limit: number,
): Promise<EntityGraphResult[]> {
  const queryEntities = extractEntities(queryText);
  if (queryEntities.length === 0) return [];

  const activation = seedActivationMap(queryEntities);
  await propagateActivation(pool, userId, activation);
  return scoreMemoriesByActivation(pool, userId, activation, limit);
}

/** Initialize activation map with query entities at full activation. */
function seedActivationMap(entities: string[]): Map<string, number> {
  const activation = new Map<string, number>();
  for (const entity of entities) {
    activation.set(entity, 1.0);
  }
  return activation;
}

/** Propagate activation through the entity graph for MAX_HOPS iterations. */
async function propagateActivation(
  pool: pg.Pool,
  userId: string,
  activation: Map<string, number>,
): Promise<void> {
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const activeEntities = [...activation.entries()]
      .filter(([, score]) => score >= ACTIVATION_THRESHOLD)
      .map(([entity]) => entity);
    if (activeEntities.length === 0) break;

    const neighbors = await findNeighbors(pool, userId, activeEntities);
    for (const neighbor of neighbors) {
      const sourceActivation = activation.get(neighbor.entity) ?? 0;
      if (sourceActivation < ACTIVATION_THRESHOLD) continue;
      const propagated = sourceActivation * ACTIVATION_DECAY;
      const existing = activation.get(neighbor.entity) ?? 0;
      activation.set(neighbor.entity, Math.max(existing, propagated));
    }
  }
}

/** Score memories by summing activation from their linked entities. */
async function scoreMemoriesByActivation(
  pool: pg.Pool,
  userId: string,
  activation: Map<string, number>,
  limit: number,
): Promise<EntityGraphResult[]> {
  const allActivatedEntities = [...activation.entries()]
    .filter(([, score]) => score >= ACTIVATION_THRESHOLD)
    .map(([entity]) => entity);
  if (allActivatedEntities.length === 0) return [];

  const memoryEntities = await findMemoriesForEntities(pool, userId, allActivatedEntities);
  const memoryScores = new Map<string, number>();
  for (const { memoryId, entity } of memoryEntities) {
    const current = memoryScores.get(memoryId) ?? 0;
    memoryScores.set(memoryId, current + (activation.get(entity) ?? 0));
  }

  return [...memoryScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([memoryId, activationScore]) => ({ memoryId, activationScore }));
}
