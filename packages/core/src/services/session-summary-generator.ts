/**
 * Session + conversation summary generation for hierarchical retrieval (T2.2).
 *
 * Called at end-of-session ingest (session summary) and end-of-conversation
 * ingest (conversation summary). Output is persisted to `session_summaries`
 * and `conv_summaries` tables; embeddings are computed by the caller using
 * the existing `embedText` pipeline.
 *
 * Cost-aware: small sessions (< MIN_FACTS_FOR_LLM facts) skip the LLM call
 * and return a deterministic concat. Saves cost on tiny conversational
 * fragments and keeps unit-test cost at zero.
 *
 * No new LLM provider — reuses the shared LLMProvider interface from llm.ts.
 * Activated by `hierarchicalRetrievalEnabled=true` in IngestRuntimeConfig.
 */

import type { LLMProvider } from './llm.js';

const MIN_FACTS_FOR_LLM = 5;
const SESSION_SUMMARY_MAX_TOKENS = 150;
const CONV_SUMMARY_MAX_TOKENS = 280;
const MAX_TOPICS = 8;

export interface SessionSummary {
  summary: string;
  topics: string[];
  /** True when the LLM was invoked; false when the deterministic-skip path fired. */
  llmInvoked: boolean;
}

export interface ConvSummary {
  summary: string;
  llmInvoked: boolean;
}

export interface SummaryGenerationOptions {
  /** Random seed forwarded to the LLM provider when supported (for determinism). */
  seed?: number;
  /** Optional override for the small-session deterministic-skip threshold. */
  minFactsForLlm?: number;
}

/**
 * Generate a topical summary for one session.
 *
 * Returns `{summary, topics}`:
 *  - summary  : ~100-token natural-language sketch ("kickoff: API design, auth choices")
 *  - topics   : up to MAX_TOPICS short noun-phrase tags ("api design", "auth", "kickoff")
 *
 * For sessions with fewer than `minFactsForLlm` facts, returns a deterministic
 * concat of the first 3 facts plus their first-noun-phrase as topics — this
 * keeps unit tests free of LLM mocks and is empirically as good as a tiny LLM
 * summary on short sessions.
 */
export async function generateSessionSummary(
  sessionFacts: string[],
  llm: LLMProvider,
  opts: SummaryGenerationOptions = {},
): Promise<SessionSummary> {
  const minFacts = opts.minFactsForLlm ?? MIN_FACTS_FOR_LLM;
  if (sessionFacts.length < minFacts) {
    return deterministicSessionSummary(sessionFacts);
  }
  const userMsg = buildSessionPrompt(sessionFacts);
  const raw = await llm.chat(
    [
      { role: 'system', content: SESSION_SYSTEM_PROMPT },
      { role: 'user', content: userMsg },
    ],
    { maxTokens: SESSION_SUMMARY_MAX_TOKENS, jsonMode: true, seed: opts.seed },
  );
  return parseSessionResponse(raw, sessionFacts);
}

/**
 * Generate a conversation-level summary by rolling up session summaries.
 *
 * `sessionSummaries` are passed in chronological order. Output is ~200-token
 * natural-language overview ("project kickoff through API redesign;
 * decisions on Postgres + JWT auth; outstanding question on rate-limit").
 */
export async function generateConvSummary(
  sessionSummaries: string[],
  llm: LLMProvider,
  opts: SummaryGenerationOptions = {},
): Promise<ConvSummary> {
  const minFacts = opts.minFactsForLlm ?? MIN_FACTS_FOR_LLM;
  if (sessionSummaries.length < minFacts) {
    return {
      summary: sessionSummaries.join(' / ').slice(0, 600),
      llmInvoked: false,
    };
  }
  const userMsg = buildConvPrompt(sessionSummaries);
  const raw = await llm.chat(
    [
      { role: 'system', content: CONV_SYSTEM_PROMPT },
      { role: 'user', content: userMsg },
    ],
    { maxTokens: CONV_SUMMARY_MAX_TOKENS, jsonMode: true, seed: opts.seed },
  );
  return { summary: parseConvResponse(raw), llmInvoked: true };
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const SESSION_SYSTEM_PROMPT =
  'You produce a structured summary of one conversation session. ' +
  'Output ONLY valid JSON of the form {"summary": "...", "topics": ["...", "..."]}. ' +
  'The "summary" field is one to two sentences (≤ 100 tokens) describing what was ' +
  'discussed and any decisions reached. The "topics" field is up to 8 short noun-phrase ' +
  'tags. No prose outside the JSON.';

const CONV_SYSTEM_PROMPT =
  'You produce a structured summary of an entire conversation by rolling up its session ' +
  'summaries. Output ONLY valid JSON of the form {"summary": "..."}. The "summary" field ' +
  'is two to four sentences (≤ 200 tokens) covering the conversation arc. No prose ' +
  'outside the JSON.';

function buildSessionPrompt(facts: string[]): string {
  const enumerated = facts.slice(0, 50).map((f, i) => `${i + 1}. ${f}`).join('\n');
  return `Session facts:\n${enumerated}\n\nReturn JSON {summary, topics}.`;
}

function buildConvPrompt(summaries: string[]): string {
  const enumerated = summaries.map((s, i) => `Session ${i + 1}: ${s}`).join('\n');
  return `Session summaries (chronological):\n${enumerated}\n\nReturn JSON {summary}.`;
}

// ---------------------------------------------------------------------------
// Deterministic-skip path
// ---------------------------------------------------------------------------

function deterministicSessionSummary(facts: string[]): SessionSummary {
  const lead = facts.slice(0, 3).join(' / ').slice(0, 400);
  const topics = extractDeterministicTopics(facts);
  return { summary: lead, topics, llmInvoked: false };
}

function extractDeterministicTopics(facts: string[]): string[] {
  const tokens = facts
    .flatMap((f) => f.toLowerCase().split(/\W+/))
    .filter((t) => t.length >= 4);
  const counts = new Map<string, number>();
  for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_TOPICS)
    .map(([word]) => word);
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

interface RawSessionResponse {
  summary?: unknown;
  topics?: unknown;
}

interface RawConvResponse {
  summary?: unknown;
}

function parseSessionResponse(raw: string, fallbackFacts: string[]): SessionSummary {
  const parsed = tryParseJson<RawSessionResponse>(raw);
  if (!parsed || typeof parsed.summary !== 'string') {
    return { ...deterministicSessionSummary(fallbackFacts), llmInvoked: true };
  }
  const topics = Array.isArray(parsed.topics)
    ? parsed.topics.filter((t): t is string => typeof t === 'string').slice(0, MAX_TOPICS)
    : [];
  return { summary: parsed.summary, topics, llmInvoked: true };
}

function parseConvResponse(raw: string): string {
  const parsed = tryParseJson<RawConvResponse>(raw);
  if (parsed && typeof parsed.summary === 'string') return parsed.summary;
  // Fail-safe: return raw text trimmed
  return raw.trim().slice(0, 600);
}

function tryParseJson<T>(raw: string): T | null {
  const trimmed = raw.trim();
  // Tolerate ```json fenced blocks
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/);
  const body = fence ? fence[1].trim() : trimmed;
  try {
    return JSON.parse(body) as T;
  } catch {
    return null;
  }
}
