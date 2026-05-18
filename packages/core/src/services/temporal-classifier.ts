/**
 * BEAM v38: write-time temporal classifier.
 *
 * Given a freshly-extracted memory text plus its observed timestamp, the
 * classifier returns either:
 *   - { stateKey, eventStart, eventEnd: null }  for stateful facts
 *     (e.g. "user lives in Austin", "API response time is 200ms")
 *   - null for non-stateful memories (events, one-time mentions)
 *
 * The classifier is a thin LLM wrapper that uses Anthropic forced
 * tool-use for a deterministic JSON output. The prompt is small and
 * cache-friendly. The classifier fails CLOSED — when the LLM call
 * throws, the caller decides whether to abort the ingest or fall
 * through; this module never silently returns null on a transport
 * error. (See `classifyTemporalState` for the exact contract.)
 */

import { callAnthropicTool } from './llm.js';

/** Output of the classifier when the memory describes a stateful fact. */
export interface TemporalStateClassification {
  /** Stable identifier for the evolving fact (e.g. `user:1:location`). */
  stateKey: string;
  /** When the fact became true (ISO string at the in-LLM API surface). */
  eventStart: Date;
  /**
   * When the fact stopped being true. Always `null` at classification
   * time — supersede logic lives in `memory-storage.ts`. Kept on the
   * type for callers that destructure the row shape directly.
   */
  eventEnd: null;
}

/** Input bag for `classifyTemporalState`. */
export interface TemporalClassifyInput {
  /** Extracted memory text (`FactInput.fact`). */
  memoryText: string;
  /**
   * Resolved observed_at for the conversation turn (logical timestamp).
   * Used as the default eventStart when the model does not surface one.
   */
  observedAt: Date;
  /**
   * Stable per-user namespace used to scope the state_key. The classifier
   * prepends `user:<userId>:` to the model-emitted key so two users with
   * the same key string ("location") don't collide.
   */
  userId: string;
  /** Anthropic model ID. Pinned by the caller (typically the reflect model). */
  model: string;
}

interface ToolOutput {
  /**
   * "stateful" → the memory describes an evolving fact.
   * "non_stateful" → one-time event, summary, or factoid. No state_key.
   */
  kind: 'stateful' | 'non_stateful';
  /**
   * Slug-cased key, with optional namespace dots — e.g. `location`,
   * `job.employer`, `api.dashboard.response_time`. Empty when non-stateful.
   */
  state_key: string;
  /**
   * Optional ISO-8601 timestamp for event_start. Empty when the memory
   * does not anchor to a specific date — caller falls back to observed_at.
   */
  event_start_iso: string;
  /** One-sentence rationale. Discarded; useful for prompt iteration. */
  rationale: string;
}

const SYSTEM_PROMPT = `You are a temporal-state classifier. Given one extracted memory and the date it was observed, decide whether the memory describes a STATEFUL fact (an evolving value of some attribute for some subject) or a NON_STATEFUL event/mention/summary.

STATEFUL examples:
  "User lives in Austin, TX" → { kind: stateful, state_key: "location" }
  "Alice's job title is Staff Engineer" → { kind: stateful, state_key: "job.title" }
  "Dashboard API response time is 200ms" → { kind: stateful, state_key: "api.dashboard.response_time" }
  "User's current diet is vegetarian" → { kind: stateful, state_key: "diet" }
  "Project lead is Bob" → { kind: stateful, state_key: "project.lead" }

NON_STATEFUL examples:
  "User flew to Tokyo last week" → { kind: non_stateful }  (one-time event)
  "Asked about pricing on March 3rd" → { kind: non_stateful }
  "Discussed AUDN architecture in the standup" → { kind: non_stateful }
  "Mentioned that Q3 was tough" → { kind: non_stateful }

Rules:
- state_key must be a slug: lowercase ascii letters, digits, underscores, and dots only.
- state_key names the ATTRIBUTE, not the value. "lives in Austin" → "location", not "austin".
- event_start_iso, when surfaced, must be ISO-8601 with timezone. Leave empty when unsure.
- Be conservative: prefer non_stateful when the memory could be either.`;

const TOOL_SCHEMA = {
  name: 'emit_temporal_state',
  description: 'Emit the classifier output as structured JSON.',
  input_schema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['stateful', 'non_stateful'] },
      state_key: { type: 'string' },
      event_start_iso: { type: 'string' },
      rationale: { type: 'string' },
    },
    required: ['kind', 'state_key', 'event_start_iso', 'rationale'],
  },
} as const;

// Slug: lowercase ascii + digits + underscore, joined by dots.
const SLUG_PATTERN = /^[a-z0-9_]+(?:\.[a-z0-9_]+)*$/;

/**
 * Classify a single memory. Returns `null` for non-stateful memories or
 * when the classifier rejects the model output (empty/invalid key).
 *
 * Throws on transport / API failures so the caller can fail closed.
 */
export async function classifyTemporalState(
  input: TemporalClassifyInput,
): Promise<TemporalStateClassification | null> {
  const userMessage = buildUserMessage(input);
  const output = await callAnthropicTool<ToolOutput>(
    input.model,
    SYSTEM_PROMPT,
    userMessage,
    TOOL_SCHEMA,
  );
  return interpretToolOutput(output, input);
}

function buildUserMessage(input: TemporalClassifyInput): string {
  const isoObserved = input.observedAt.toISOString();
  return `Observed at: ${isoObserved}\nMemory: ${input.memoryText}\n\nReturn STATEFUL only when this memory describes a value that can later change. Otherwise NON_STATEFUL.`;
}

function interpretToolOutput(
  output: ToolOutput,
  input: TemporalClassifyInput,
): TemporalStateClassification | null {
  if (output.kind !== 'stateful') return null;
  const rawKey = (output.state_key ?? '').trim().toLowerCase();
  if (!rawKey || !SLUG_PATTERN.test(rawKey)) return null;
  const eventStart = parseIso(output.event_start_iso) ?? input.observedAt;
  return {
    stateKey: scopedKey(input.userId, rawKey),
    eventStart,
    eventEnd: null,
  };
}

function parseIso(value: string | undefined): Date | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Scope an LLM-emitted slug into the per-user namespace. */
export function scopedKey(userId: string, slug: string): string {
  return `user:${userId}:${slug}`;
}
