/**
 * MSR cross-conversation aggregator.
 *
 * Retrieval-side intervention for multi-session-reasoning queries. v39-multihop
 * diagnostic on v26 MSR failures: gold facts WERE in the top-K but spread
 * across 2-4 conversations; the answer LLM could not synthesize them and
 * returned inflated counts ("Twenty-three" vs gold "Four").
 *
 * Strategy: group retrieved memories by `episode_id` (= conversation id in
 * BEAM). For each group with >=2 memories, emit a 1-sentence summary via the
 * configured chat LLM (cheap — defaults to Haiku). Groups with a single
 * memory pass through verbatim (no LLM call). The concatenated
 * `## CONVERSATION N SUMMARY` blocks become an additional channel BEFORE
 * the standard OBSERVATIONS / TIMELINE / ENTITY_STATE blocks.
 *
 * Fail-closed: any LLM error during summarization throws — no silent
 * fallback to raw text. Matches the AUDN mutation invariant.
 */

import type { SearchResult } from '../db/memory-repository.js';
import type { LLMProvider, ChatMessage } from './llm.js';

/** Caller-supplied dependencies. Decoupled from MemoryServiceDeps for testability. */
export interface MsrAggregatorDeps {
  /** Chat LLM provider — shared singleton in production, mocked in tests. */
  llm: LLMProvider;
  /** Model used for per-conversation summary calls. Default Haiku-cheap. */
  model: string;
  /** Optional override for the per-summary token budget. Default 80. */
  maxTokensPerSummary?: number;
}

const DEFAULT_MAX_TOKENS = 80;
const NO_EPISODE_KEY = '__no_episode__';

interface GroupedMemories {
  /** Episode id, or NO_EPISODE_KEY when null. */
  key: string;
  memories: SearchResult[];
}

/** Group retrieved memories by episode_id, preserving first-seen order. */
function groupByEpisode(memories: ReadonlyArray<SearchResult>): GroupedMemories[] {
  const groups = new Map<string, SearchResult[]>();
  for (const memory of memories) {
    const key = memory.episode_id ?? NO_EPISODE_KEY;
    const existing = groups.get(key);
    if (existing) {
      existing.push(memory);
    } else {
      groups.set(key, [memory]);
    }
  }
  return Array.from(groups.entries()).map(([key, mems]) => ({ key, memories: mems }));
}

/** Build the LLM prompt for a single conversation-summary call. */
function buildSummaryPrompt(query: string, memories: ReadonlyArray<SearchResult>): ChatMessage[] {
  const factLines = memories.map((m, i) => `${i + 1}. ${m.content}`).join('\n');
  const system =
    'You summarize what was discussed in one conversation. Output exactly one ' +
    'concise sentence (max ~30 words) that captures only what relates to the ' +
    "user's question. Do not invent facts. Do not list — write one sentence.";
  const user =
    `User's question: ${query}\n\n` +
    `Facts retrieved from this conversation:\n${factLines}\n\n` +
    'One-sentence summary of what was discussed in this conversation that ' +
    "relates to the user's question:";
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/**
 * Summarize a single conversation group via the chat LLM. Fail-closed: if the
 * LLM throws or returns an empty string, this re-throws with context — no
 * silent fallback.
 */
async function summarizeGroup(
  group: GroupedMemories,
  query: string,
  deps: MsrAggregatorDeps,
): Promise<string> {
  const messages = buildSummaryPrompt(query, group.memories);
  const text = await deps.llm.chat(messages, {
    temperature: 0,
    maxTokens: deps.maxTokensPerSummary ?? DEFAULT_MAX_TOKENS,
  });
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new Error(
      `msr-aggregator: LLM returned empty summary for episode_id=${group.key}`,
    );
  }
  return trimmed;
}

/**
 * Render a single memory's content verbatim — used for groups with exactly
 * one memory, where summarization would only add LLM cost without
 * cross-source synthesis benefit.
 */
function renderPassthrough(group: GroupedMemories): string {
  return group.memories[0].content.trim();
}

/**
 * Build the per-conversation aggregated string. Groups are 1-indexed by
 * first-seen episode order. Multi-memory groups go through the LLM; single-
 * memory groups pass through verbatim.
 *
 * Returns an empty string when there are no retrieved memories — caller
 * should treat that as "no MSR channel to add" and skip the prefix.
 */
export async function aggregateByConversation(
  memories: ReadonlyArray<SearchResult>,
  query: string,
  deps: MsrAggregatorDeps,
): Promise<string> {
  if (memories.length === 0) return '';
  const groups = groupByEpisode(memories);
  const sections: string[] = [];
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    const body =
      group.memories.length >= 2
        ? await summarizeGroup(group, query, deps)
        : renderPassthrough(group);
    sections.push(`## CONVERSATION ${i + 1} SUMMARY\n${body}`);
  }
  return sections.join('\n\n');
}
