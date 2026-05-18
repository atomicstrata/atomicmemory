/**
 * CR (Contradiction Resolution) specialist.
 *
 * Replaces the deleted Layer 3 counter-edge-surface module which was
 * broken (the [CONTRADICTS] marker confused Haiku into picking the wrong
 * side). The new approach: explicit FACT A / FACT B framing via tool-use
 * so the LLM produces BEAM's canonical "you said X but also Y" answer.
 *
 * Flow:
 *   1) Pattern-match the query (e.g. "have I ever", "did I ever")
 *   2) Query belief_edges for COUNTER edges among the retrieved top-K
 *   3) Fetch BOTH sides of each edge
 *   4) Call Haiku with explicit fact_a/fact_b framing via tool-use
 *   5) Return the LLM's answer (which should follow the BEAM canonical shape)
 */

import type { BeliefEdgesRepository } from '../../db/belief-edges-repository.js';
import type { MemoryRepository } from '../../db/memory-repository.js';
import { callAnthropicTool } from '../llm.js';

/** Pattern check: should the CR specialist handle this query? */
export function shouldInvokeCrSpecialist(query: string): boolean {
  // BEAM CR phrasings: "have I ever / did I ever / am I / do I / conflicting / contradict"
  return /\b(have I (ever|already|previously)|did I (ever|already|previously)|am I (currently|now)|conflicting|contradict)\b/i.test(
    query,
  );
}

export interface CrMemoryInput {
  id: string;
  text: string;
}

export interface CrSpecialistDeps {
  /** Top-K retrieved memories from the shared search spine. */
  memories: ReadonlyArray<CrMemoryInput>;
  /** Original user query. */
  query: string;
  /** User ID scoping all DB lookups. */
  userId: string;
  /** Anthropic model ID (e.g. 'claude-haiku-4-5'). */
  model: string;
  /** BeliefEdgesRepository — null when TBC is disabled. */
  beliefEdges: BeliefEdgesRepository | null;
  /** MemoryRepository for fetching sides not present in top-K. */
  memoryRepo: MemoryRepository;
}

export interface CrSpecialistResult {
  /** The LLM answer in canonical "You said X but also Y" shape. */
  answer: string;
  /** Whether the specialist handled the query (false = fall through to spine). */
  handled: boolean;
  /** Number of bilateral contradiction pairs found. */
  contradictionsFound: number;
}

interface ContradictionPair {
  factA: string;
  factB: string;
}

const CR_TOOL_SCHEMA = {
  name: 'answer_contradiction',
  description:
    'Answer a contradiction-resolution question by surfacing both conflicting facts.',
  input_schema: {
    type: 'object',
    properties: {
      both_sides_present: { type: 'boolean' },
      answer_text: {
        type: 'string',
        description:
          'BEAM canonical shape: "You said X but also Y. Could you clarify which is correct?"',
      },
    },
    required: ['both_sides_present', 'answer_text'],
  },
} as const;

/** Resolve the text for a single memory side (top-K cache first, then DB). */
async function resolveMemoryText(
  userId: string,
  id: string,
  topK: ReadonlyArray<CrMemoryInput>,
  memoryRepo: MemoryRepository,
): Promise<string> {
  const cached = topK.find(m => m.id === id);
  if (cached) return cached.text;
  const row = await memoryRepo.getMemory(id, userId);
  return row?.content ?? '';
}

/** Query COUNTER edges and resolve both sides into ContradictionPair[]. */
async function fetchContradictions(
  deps: CrSpecialistDeps,
): Promise<ContradictionPair[]> {
  if (!deps.beliefEdges) return [];
  const topIds = deps.memories.map(m => m.id);
  if (topIds.length === 0) return [];

  const edges = await deps.beliefEdges.findCounterEdgesForMemories(deps.userId, topIds);
  if (edges.length === 0) return [];

  const pairs: ContradictionPair[] = [];
  const seen = new Set<string>();

  for (const e of edges) {
    const key = [e.sourceId, e.targetId].sort().join('|');
    if (seen.has(key)) continue;
    seen.add(key);

    const [factA, factB] = await Promise.all([
      resolveMemoryText(deps.userId, e.sourceId, deps.memories, deps.memoryRepo),
      resolveMemoryText(deps.userId, e.targetId, deps.memories, deps.memoryRepo),
    ]);

    if (factA && factB) {
      pairs.push({ factA, factB });
    }
  }

  return pairs;
}

/** Build system prompt for CR tool-use call. */
function buildSystemPrompt(): string {
  return [
    'You are answering a contradiction-resolution question.',
    'The user\'s memory contains two conflicting facts about the same topic.',
    'Surface both sides explicitly using this canonical shape:',
    '',
    '"You said X but also Y. Could you clarify which is correct?"',
    '',
    'Where X and Y are the two contradicting claims.',
    'Call the answer_contradiction tool. Do NOT free-text.',
  ].join('\n');
}

/** Build user message listing contradicting fact pairs. */
function buildUserMessage(query: string, pairs: ContradictionPair[]): string {
  const lines = [
    `User question: ${query}`,
    '',
    'Contradicting facts:',
    ...pairs.flatMap((p, i) => [
      `Pair ${i + 1}:`,
      `  FACT A: ${p.factA}`,
      `  FACT B (contradicts A): ${p.factB}`,
    ]),
  ];
  return lines.join('\n');
}

/**
 * Run the CR specialist.
 *
 * Returns handled=false when the query doesn't match the CR pattern,
 * so callers can fall through to the standard search spine.
 */
export async function runCrSpecialist(
  deps: CrSpecialistDeps,
): Promise<CrSpecialistResult> {
  if (!shouldInvokeCrSpecialist(deps.query)) {
    return { answer: '', handled: false, contradictionsFound: 0 };
  }

  const pairs = await fetchContradictions(deps);

  if (pairs.length === 0) {
    return { answer: '', handled: true, contradictionsFound: 0 };
  }

  const system = buildSystemPrompt();
  const userText = buildUserMessage(deps.query, pairs);

  const tool = await callAnthropicTool<{
    both_sides_present: boolean;
    answer_text: string;
  }>(deps.model, system, userText, CR_TOOL_SCHEMA);

  return {
    answer: tool.answer_text,
    handled: true,
    contradictionsFound: pairs.length,
  };
}
