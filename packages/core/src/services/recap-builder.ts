/**
 * Recap layer (Sprint 3 v1) — pre-computed cross-session synthesis.
 *
 * For each cluster of N+ memories that share a conceptual topic, generate
 * an LLM-synthesized narrative ("Episode") and store it as a separate
 * retrievable unit with its own embedding. Cross-session questions ("how
 * did the auth design evolve across sessions?") retrieve the Recap
 * directly instead of re-synthesizing N raw facts at query time.
 *
 * Cog-sci analogue: hippocampal consolidation. Three of the four next-gen
 * memory systems converge on this primitive (Hindsight observations,
 * Honcho dreaming, X-Mem Episodes, EverMemOS multi-pass restructuring).
 *
 * Cluster pivot: `topic_abstraction` field. Requires topic-abstraction
 * layer to be ON during ingest so memories carry topic tags. The clustering
 * is simple grouping by exact topic string + user; embedding-based nearest-
 * neighbor clustering is a v1.1 enhancement.
 *
 * Trigger: post-write hook checks if any topic for the user crosses
 * recapMinClusterSize un-consolidated memories. Builder fires async
 * (no await) so ingest latency is unaffected.
 *
 * Feature flag: recapLayerEnabled (default OFF).
 *
 * See benchmarks-sprint3/2026-05-10-am-baseline-and-rerank-design.md.
 */

import type { ChatMessage, LLMProvider } from './llm.js';
import { llm as defaultLlm } from './llm.js';
import { extractFirstJsonObject } from './extraction.js';
import { embedText } from './embedding.js';
import type { MemoryServiceDeps } from './memory-service-types.js';

const RECAP_MAX_TOKENS = 1024;
const RECAP_MAX_MEMBER_CONTENT_CHARS = 600;
const RECAP_TARGET_WORD_COUNT = 200;

const RECAP_SYSTEM_PROMPT = [
  'You synthesize a coherent narrative from a cluster of related memories.',
  '',
  'Rules:',
  '- The cluster shares a conceptual topic (given). Combine the memories into',
  `  a single narrative of ~${RECAP_TARGET_WORD_COUNT} words capturing how the`,
  '  topic evolved across the cluster.',
  '- Preserve specific facts (names, dates, numbers, decisions).',
  '- Use temporal connectives ("first ... then ... after ... by") so the order',
  '  is explicit.',
  '- Do NOT speculate or add information not in the source memories.',
  '- Output a JSON object: {"narrative": "<200-word narrative>"}.',
  '- No markdown fences. No prose around the JSON.',
].join('\n');

export interface RecapContent {
  narrative: string;
}

export class RecapBuilderError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'RecapBuilderError';
  }
}

interface RawRecapResponse {
  narrative?: unknown;
}

/**
 * Synthesize an episode narrative from a cluster of memory contents.
 * Fail-closed: throws RecapBuilderError. Caller decides whether to fail
 * the post-write step or just log.
 */
export async function synthesizeRecap(
  topic: string,
  memberContents: string[],
  llmClient: LLMProvider = defaultLlm,
): Promise<RecapContent> {
  if (memberContents.length === 0) {
    throw new RecapBuilderError('cannot synthesize recap from zero members');
  }
  const messages: ChatMessage[] = [
    { role: 'system', content: RECAP_SYSTEM_PROMPT },
    { role: 'user', content: buildEpisodeUserMessage(topic, memberContents) },
  ];
  let raw: string;
  try {
    raw = await llmClient.chat(messages, {
      temperature: 0,
      jsonMode: true,
      maxTokens: RECAP_MAX_TOKENS,
    });
  } catch (err) {
    throw new RecapBuilderError(`recap synthesis LLM call failed: ${(err as Error).message}`, err);
  }
  if (!raw) throw new RecapBuilderError('recap synthesis returned empty content');
  const cleaned = extractFirstJsonObject(raw);
  let parsed: RawRecapResponse;
  try {
    parsed = JSON.parse(cleaned) as RawRecapResponse;
  } catch (err) {
    throw new RecapBuilderError(`recap synthesis returned non-JSON: ${cleaned.slice(0, 200)}`, err);
  }
  return validateEpisode(parsed);
}

function buildEpisodeUserMessage(topic: string, memberContents: string[]): string {
  const truncated = memberContents.map((c, i) =>
    `[${i + 1}] ${c.trim().slice(0, RECAP_MAX_MEMBER_CONTENT_CHARS)}`,
  );
  return [
    `TOPIC: ${topic}`,
    '',
    `MEMORIES (${memberContents.length}):`,
    truncated.join('\n\n'),
    '',
    'Return JSON: {"narrative": "<200-word narrative weaving the memories together>"}',
  ].join('\n');
}

function validateEpisode(parsed: RawRecapResponse): RecapContent {
  const narrative = typeof parsed.narrative === 'string' ? parsed.narrative.trim() : null;
  if (!narrative) {
    throw new RecapBuilderError(`recap response missing narrative: ${JSON.stringify(parsed).slice(0, 200)}`);
  }
  if (narrative.split(/\s+/).filter(Boolean).length < 20) {
    throw new RecapBuilderError(`episode narrative too short: "${narrative.slice(0, 100)}"`);
  }
  return { narrative };
}

/**
 * Background trigger for episode building. Checks each user-topic pair for
 * un-consolidated clusters meeting the size threshold; for each qualifying
 * cluster, synthesizes + stores a Recap.
 *
 * Fire-and-forget from post-write — never throws to caller.
 */
export async function maybeBuildRecapsForUser(
  deps: MemoryServiceDeps,
  userId: string,
): Promise<number> {
  if (!deps.config.recapLayerEnabled) return 0;
  const recap = deps.stores.recap;
  if (!recap) return 0;
  const minSize = deps.config.recapMinClusterSize;
  const pivot = deps.config.recapClusterPivot ?? 'topic';
  let created = 0;
  try {
    const clusters = await recap.findUnconsolidatedClusters(userId, minSize, pivot);
    for (const cluster of clusters) {
      try {
        const { narrative } = await synthesizeRecap(cluster.topic, cluster.member_contents);
        const embedding = await embedText(narrative, 'document');
        await recap.storeRecap({
          userId,
          recapText: narrative,
          recapEmbedding: embedding,
          topic: cluster.topic,
          memberMemoryIds: cluster.member_ids,
          timeRangeStart: cluster.time_range_start,
          timeRangeEnd: cluster.time_range_end,
        });
        created += 1;
      } catch (err) {
        // Per-cluster fail-soft: log and continue with the next cluster.
        // The cluster will be retried on the next post-write trigger if the
        // member count still meets threshold.
        console.warn(`[episode] synthesis failed for topic="${cluster.topic}" (${cluster.member_ids.length} members): ${(err as Error).message}`);
      }
    }
  } catch (err) {
    console.warn(`[episode] background pass failed for user=${userId}: ${(err as Error).message}`);
  }
  return created;
}
