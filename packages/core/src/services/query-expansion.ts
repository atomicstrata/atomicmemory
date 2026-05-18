/**
 * Query expansion via entity graph bridging.
 *
 * Two modes:
 * 1. **Query augmentation** (zero-LLM): Embeds the query, matches against
 *    entity embeddings, appends top entity names to the query text before
 *    the main vector search. Sub-millisecond cost, improves cold-path
 *    retrieval by grounding generic queries in user-specific context.
 *
 * 2. **LLM-based expansion**: Extracts entity names and concepts from the
 *    query via LLM, looks them up in the entity graph, traverses relations,
 *    and returns memory IDs that are conceptually related but not
 *    embedding-adjacent.
 *
 * Example (augmentation): "How should I implement caching?" → matches
 * entities [Python, Redis, FastAPI] → augmented query becomes
 * "How should I implement caching? [context: Python, Redis, FastAPI]"
 */

import { config } from '../config.js';
import type { CoreRuntimeConfig } from '../app/runtime-container.js';
import type { SearchResult } from '../db/repository-types.js';
import type { SearchStore, EntityStore } from '../db/stores.js';
import { llm } from './llm.js';
import { embedText } from './embedding.js';

type SearchExpansionRuntimeConfig = Pick<
  CoreRuntimeConfig,
  'queryExpansionMinSimilarity' | 'queryAugmentationMaxEntities' | 'queryAugmentationMinSimilarity'
>;

const ENTITY_EXTRACTION_PROMPT =
  'Extract entity names and conceptual topics from this search query. ' +
  'Return a JSON object with two arrays: ' +
  '"entities" (specific named things: tools, people, projects, places, organizations) and ' +
  '"concepts" (abstract topics: caching, deployment, testing, fitness, cooking). ' +
  'Be thorough — include implicit references. ' +
  'Example: "How should I cache my API?" → {"entities":["API"],"concepts":["caching","performance"]}. ' +
  'Return ONLY valid JSON, no explanation.';

export interface QueryExpansionResult {
  extractedEntities: string[];
  extractedConcepts: string[];
  matchedEntityIds: string[];
  expandedMemoryIds: string[];
}

/** Extract entity names and concepts from a query using the LLM. */
async function extractQueryTerms(
  query: string,
): Promise<{ entities: string[]; concepts: string[] }> {
  const response = await llm.chat(
    [
      { role: 'system', content: ENTITY_EXTRACTION_PROMPT },
      { role: 'user', content: query },
    ],
    { temperature: 0, maxTokens: 200 },
  );

  return parseQueryTerms(response);
}

/** Parse LLM response into structured terms. Pure function for testability. */
export function parseQueryTerms(
  response: string,
): { entities: string[]; concepts: string[] } {
  const fallback = { entities: [], concepts: [] };
  try {
    const parsed = JSON.parse(response.trim()) as Record<string, unknown>;
    const entities = Array.isArray(parsed.entities)
      ? parsed.entities.filter((e): e is string => typeof e === 'string' && e.trim().length > 0)
      : [];
    const concepts = Array.isArray(parsed.concepts)
      ? parsed.concepts.filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
      : [];
    return { entities, concepts };
  } catch {
    return fallback;
  }
}

/**
 * Search entities by name (case-insensitive substring match).
 * Returns entity IDs that match any of the provided terms.
 */
async function findEntitiesByTerms(
  entityRepo: EntityStore,
  userId: string,
  terms: string[],
  limit: number,
  runtimeConfig: SearchExpansionRuntimeConfig = config,
): Promise<string[]> {
  if (terms.length === 0) return [];

  const allIds: Set<string> = new Set();
  for (const term of terms) {
    const embedding = await embedText(term);
    const matches = await entityRepo.searchEntities(
      userId, embedding, limit, runtimeConfig.queryExpansionMinSimilarity,
    );
    for (const match of matches) {
      allIds.add(match.id);
    }
  }
  return [...allIds];
}

/**
 * Run full query expansion: extract terms → find entities → traverse
 * relations → retrieve bridging memories.
 */
export async function expandQueryViaEntities(
  entityRepo: EntityStore,
  repo: SearchStore,
  userId: string,
  query: string,
  queryEmbedding: number[],
  excludeIds: Set<string>,
  budget: number,
  runtimeConfig: SearchExpansionRuntimeConfig = config,
): Promise<{ memories: SearchResult[]; expansion: QueryExpansionResult }> {
  const { entities, concepts } = await extractQueryTerms(query);
  const allTerms = [...entities, ...concepts];

  if (allTerms.length === 0) {
    return {
      memories: [],
      expansion: { extractedEntities: entities, extractedConcepts: concepts, matchedEntityIds: [], expandedMemoryIds: [] },
    };
  }

  const matchedEntityIds = await findEntitiesByTerms(
    entityRepo,
    userId,
    allTerms,
    10,
    runtimeConfig,
  );

  if (matchedEntityIds.length === 0) {
    return {
      memories: [],
      expansion: { extractedEntities: entities, extractedConcepts: concepts, matchedEntityIds: [], expandedMemoryIds: [] },
    };
  }

  const relatedEntityIds = await entityRepo.findRelatedEntityIds(
    userId, matchedEntityIds, new Set(matchedEntityIds), budget,
  );

  const allEntityIds = [...matchedEntityIds, ...relatedEntityIds];
  const memoryIds = await entityRepo.findMemoryIdsByEntities(
    userId, allEntityIds, excludeIds, budget,
  );

  if (memoryIds.length === 0) {
    return {
      memories: [],
      expansion: { extractedEntities: entities, extractedConcepts: concepts, matchedEntityIds, expandedMemoryIds: [] },
    };
  }

  const memories = await repo.fetchMemoriesByIds(userId, memoryIds, queryEmbedding);

  return {
    memories,
    expansion: {
      extractedEntities: entities,
      extractedConcepts: concepts,
      matchedEntityIds,
      expandedMemoryIds: memoryIds,
    },
  };
}

// ─── Zero-LLM Query Augmentation ──────────────────────────────────────

export interface QueryAugmentationResult {
  originalQuery: string;
  augmentedQuery: string;
  matchedEntities: Array<{ name: string; entityType: string; similarity: number }>;
}

/**
 * Augment a query with entity names from the memory graph.
 *
 * Uses the query embedding (already computed) to find semantically matching
 * entities, then appends their names as context hints to the query text.
 * This grounds generic queries in the user's specific context without any
 * LLM call.
 *
 * Returns the augmented query string and metadata about matched entities.
 * If no entities match above threshold, returns the original query unchanged.
 */
export async function augmentQueryWithEntities(
  entityRepo: EntityStore,
  userId: string,
  query: string,
  queryEmbedding: number[],
  runtimeConfig: SearchExpansionRuntimeConfig = config,
): Promise<QueryAugmentationResult> {
  const matches = await entityRepo.searchEntities(
    userId,
    queryEmbedding,
    runtimeConfig.queryAugmentationMaxEntities,
    runtimeConfig.queryAugmentationMinSimilarity,
  );

  const matchedEntities = matches.map((e) => ({
    name: e.name,
    entityType: e.entity_type,
    similarity: e.similarity,
  }));

  if (matchedEntities.length === 0) {
    return { originalQuery: query, augmentedQuery: query, matchedEntities: [] };
  }

  const entityNames = matchedEntities.map((e) => e.name);
  const augmentedQuery = `${query} [context: ${entityNames.join(', ')}]`;

  return { originalQuery: query, augmentedQuery, matchedEntities };
}

// ─── Entity Name Co-Retrieval ─────────────────────────────────────────

/** Common English words that appear capitalized but aren't entity names. */
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'must', 'need', 'dare',
  'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as',
  'into', 'through', 'during', 'before', 'after', 'above', 'below',
  'and', 'but', 'or', 'nor', 'not', 'so', 'yet', 'both', 'either',
  'what', 'which', 'who', 'whom', 'this', 'that', 'these', 'those',
  'how', 'when', 'where', 'why', 'if', 'then', 'than', 'because',
  'while', 'although', 'though', 'unless', 'until', 'whether',
  'it', 'its', 'he', 'she', 'they', 'we', 'you', 'i', 'me', 'my',
  'about', 'also', 'just', 'like', 'more', 'most', 'much', 'no',
  'yes', 'all', 'any', 'each', 'every', 'some', 'such', 'very',
  'ask', 'tell', 'give', 'get', 'make', 'take', 'see', 'know',
]);

/**
 * Extract capitalized multi-word phrases and proper nouns from a query.
 * These are candidate entity names for exact-match co-retrieval.
 *
 * Matches patterns like "Acme Corp", "New Zealand", "Studio Ghibli",
 * single capitalized words like "Redis", and quoted phrases.
 */
export function extractNamedEntityCandidates(query: string): string[] {
  const candidates = new Set<string>();
  collectQuotedPhrases(query, candidates);
  collectMultiWordNames(query, candidates);
  collectSingleCapitalizedWords(query, candidates);
  return [...candidates].filter((c) => c.length >= 2);
}

/** Extract quoted strings as entity candidates. */
function collectQuotedPhrases(query: string, candidates: Set<string>): void {
  const quoted = query.match(/["']([^"']+)["']/g);
  if (!quoted) return;
  for (const q of quoted) {
    candidates.add(q.replace(/["']/g, '').trim());
  }
}

/** Extract capitalized multi-word sequences, stripping stop words. */
function collectMultiWordNames(query: string, candidates: Set<string>): void {
  const multiWord = query.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g);
  if (!multiWord) return;
  for (const m of multiWord) {
    const cleaned = stripStopWords(m);
    if (cleaned.length >= 2) candidates.add(cleaned);
  }
}

/** Extract single capitalized words that are not sentence-starters or stop words. */
function collectSingleCapitalizedWords(query: string, candidates: Set<string>): void {
  const words = query.split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    const word = words[i].replace(/[?.,!;:]/g, '');
    if (!word || word.length <= 1) continue;
    const isCapitalized = /^[A-Z][a-z]*$/.test(word);
    const isSentenceStart = i === 0 || /[.!?]$/.test(words[i - 1] ?? '');
    if (isCapitalized && !isSentenceStart && !STOP_WORDS.has(word.toLowerCase())) {
      candidates.add(word);
    }
  }
}

/** Strip leading and trailing stop words from a multi-word phrase. */
function stripStopWords(phrase: string): string {
  const words = phrase.split(/\s+/);
  let start = 0;
  let end = words.length - 1;
  while (start <= end && STOP_WORDS.has(words[start].toLowerCase())) start++;
  while (end >= start && STOP_WORDS.has(words[end].toLowerCase())) end--;
  return words.slice(start, end + 1).join(' ');
}

/**
 * Co-retrieve all memories linked to entities whose names appear in the query.
 * Uses exact name matching (case-insensitive) — no embedding or LLM needed.
 *
 * This ensures that when a user asks about "Acme Corp", all memories linked
 * to the Acme Corp entity are included in the result set, even if their
 * content embeddings don't match the query semantically.
 */
export async function coRetrieveByEntityNames(
  entityRepo: EntityStore,
  repo: SearchStore,
  userId: string,
  query: string,
  queryEmbedding: number[],
  excludeIds: Set<string>,
  budget: number,
): Promise<{ memories: SearchResult[]; matchedNames: string[] }> {
  const candidates = extractNamedEntityCandidates(query);
  if (candidates.length === 0) return { memories: [], matchedNames: [] };

  const matchedEntityIds: string[] = [];
  const matchedNames: string[] = [];

  for (const name of candidates) {
    const entities = await entityRepo.findEntitiesByName(userId, name);
    for (const entity of entities) {
      matchedEntityIds.push(entity.id);
      if (!matchedNames.includes(entity.name)) {
        matchedNames.push(entity.name);
      }
    }
  }

  if (matchedEntityIds.length === 0) return { memories: [], matchedNames: [] };

  const memoryIds = await entityRepo.findMemoryIdsByEntities(
    userId, matchedEntityIds, excludeIds, budget,
  );

  if (memoryIds.length === 0) return { memories: [], matchedNames };

  const memories = await repo.fetchMemoriesByIds(userId, memoryIds, queryEmbedding);
  return { memories, matchedNames };
}
