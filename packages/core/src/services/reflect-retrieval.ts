/**
 * Query-time reflection retrieval. When the question classifier returns one of
 * the "synthesis-heavy" types (summary, contradiction, preference, ...), this
 * module embeds the query and pulls top-K reflections by cosine similarity.
 * The result is later emitted as a ## OBSERVATIONS prompt channel by
 * retrieval-format.ts.
 *
 * Returns [] when disabled or when the question type is OTHER — the caller
 * passes the empty array through and downstream packaging emits no
 * observations block.
 */
import type { Reflection, ReflectionsRepository } from '../db/reflections-repository.js';
import { QuestionType } from './answer-format.js';

const ROUTED_TYPES: ReadonlySet<QuestionType> = new Set([
  QuestionType.SUMMARY,
  QuestionType.CONTRADICTION,
  QuestionType.PREFERENCE,
  QuestionType.NUMERIC_COUNT,
  QuestionType.EXACT_DATE,
  QuestionType.ORDERED_LIST,
]);

export interface ReflectRetrievalDeps {
  reflections: Pick<ReflectionsRepository, 'findSimilar'>;
  embed: (text: string) => Promise<number[]>;
  topK: number;
  enabled: boolean;
}

/**
 * Fetch reflections most similar to a user query by cosine similarity.
 *
 * When `enabled` is false, returns []. When the question type is OTHER or
 * ABSTAIN, returns [] (no routing). Otherwise embeds the query and calls
 * findSimilar on the session_reflections table.
 *
 * @param deps DI container with reflections repo, embeddings fn, config
 * @param userId User ID for scoping the reflection query
 * @param query Raw user question string to embed
 * @param questionType Classified question type from answer-format classifier
 * @returns Array of Reflection objects, empty if disabled or not routed
 */
export async function fetchReflectionsForQuery(
  deps: ReflectRetrievalDeps,
  userId: string,
  query: string,
  questionType: QuestionType,
): Promise<Reflection[]> {
  if (!deps.enabled) return [];
  if (!ROUTED_TYPES.has(questionType)) return [];
  const embedding = await deps.embed(query);
  return deps.reflections.findSimilar(userId, embedding, deps.topK);
}
