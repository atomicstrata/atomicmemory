/**
 * Topic abstraction layer for the EO (event ordering) experiment.
 *
 * For each chunk processed during ingest, run a separate LLM pass to extract
 * the *conceptual topic* discussed in the fragment at a higher abstraction
 * level than the raw fact (e.g. "API authentication design" rather than
 * "Flask, Bootstrap"). The topic is stored alongside the raw fact so that
 * EO-style queries — which expect conceptual phases, not implementation
 * specifics — can retrieve material at the rubric's abstraction level.
 *
 * Principled, no regex: an LLM-learned summarization, an embedding similarity
 * fusion at retrieval. No query-text pattern matching. The mechanism activates
 * uniformly for all chunks; the answer LLM uses topic context for any query
 * that benefits from it.
 *
 * Cost budget: one extra short LLM call per chunk during ingest. Adds
 * ~10-25 % to ingest token usage. Zero added latency at retrieval.
 *
 * See benchmarks-sprint3/2026-05-10-am-baseline-and-rerank-design.md.
 */

import type { ChatMessage, LLMProvider } from './llm.js';
import { llm as defaultLlm } from './llm.js';
import { extractFirstJsonObject } from './extraction.js';

const TOPIC_MAX_TOKENS = 128;
const TOPIC_MAX_WORDS = 7;
const TOPIC_MIN_WORDS = 3;

const TOPIC_SYSTEM_PROMPT = [
  'You extract the conceptual TOPIC discussed in a short conversation fragment.',
  '',
  'Rules:',
  '- Output a JSON object: {"topic": "<3 to 7 words>"}',
  '- The topic must name a conceptual phase, theme, or domain — NOT implementation specifics.',
  '- Good topics: "API authentication design", "deployment pipeline setup",',
  '  "frontend layout iteration", "user onboarding flow", "database migration planning".',
  '- Bad topics (too specific): "Flask login route", "Bootstrap navbar CSS",',
  '  "PostgreSQL ALTER TABLE statement", "axios POST to /api/users".',
  '- Bad topics (too generic): "code", "the user", "discussion", "project work".',
  '- Strictly 3 to 7 words. No punctuation other than spaces.',
  '- No markdown fences. No prose around the JSON.',
].join('\n');

export interface TopicAbstraction {
  topic: string;
}

export class TopicAbstractionError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'TopicAbstractionError';
  }
}

interface RawTopicResponse {
  topic?: unknown;
}

/**
 * Extract a conceptual topic from a chunk + fact pair.
 *
 * Fail-closed: throws TopicAbstractionError on any LLM transport failure
 * or invalid output. Caller (memory-ingest.ts) decides whether to record
 * the chunk without a topic, or fail the ingest entirely.
 */
export async function extractTopicAbstraction(
  chunkText: string,
  factText: string,
  llmClient: LLMProvider = defaultLlm,
): Promise<TopicAbstraction> {
  const messages: ChatMessage[] = [
    { role: 'system', content: TOPIC_SYSTEM_PROMPT },
    { role: 'user', content: buildTopicUserMessage(chunkText, factText) },
  ];
  let raw: string;
  try {
    raw = await llmClient.chat(messages, {
      temperature: 0,
      jsonMode: true,
      maxTokens: TOPIC_MAX_TOKENS,
    });
  } catch (err) {
    throw new TopicAbstractionError(`topic extraction LLM call failed: ${(err as Error).message}`, err);
  }
  if (!raw) {
    throw new TopicAbstractionError('topic extraction returned empty content');
  }
  const cleaned = extractFirstJsonObject(raw);
  let parsed: RawTopicResponse;
  try {
    parsed = JSON.parse(cleaned) as RawTopicResponse;
  } catch (err) {
    throw new TopicAbstractionError(`topic extraction returned non-JSON: ${cleaned.slice(0, 200)}`, err);
  }
  return validateTopic(parsed);
}

function buildTopicUserMessage(chunkText: string, factText: string): string {
  return [
    'CHAT FRAGMENT:',
    chunkText.trim().slice(0, 4000),
    '',
    'FACT EXTRACTED FROM FRAGMENT:',
    factText.trim().slice(0, 1000),
    '',
    'Return the conceptual topic as JSON: {"topic": "<3 to 7 words>"}',
  ].join('\n');
}

function validateTopic(parsed: RawTopicResponse): TopicAbstraction {
  const topicRaw = typeof parsed.topic === 'string' ? parsed.topic.trim() : null;
  if (!topicRaw) {
    throw new TopicAbstractionError(`topic extraction returned no topic field: ${JSON.stringify(parsed).slice(0, 200)}`);
  }
  const words = topicRaw.split(/\s+/).filter(Boolean);
  if (words.length < TOPIC_MIN_WORDS || words.length > TOPIC_MAX_WORDS) {
    throw new TopicAbstractionError(
      `topic must be ${TOPIC_MIN_WORDS}-${TOPIC_MAX_WORDS} words, got ${words.length}: "${topicRaw}"`,
    );
  }
  return { topic: words.join(' ') };
}
