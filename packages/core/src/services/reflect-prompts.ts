/**
 * Prompt assembly + Anthropic tool-use schema for the async Reflect step.
 *
 * The Reflect call presents Sonnet with a chronologically-sorted list of the
 * session's raw memories (each with its memory id and observed_at) and asks
 * Sonnet to consolidate them into a small set of typed observations. Each
 * observation MUST cite the memory_ids it draws from, so retrieval can verify
 * evidence still exists when the observation is later read by the answer LLM.
 *
 * Tool-use guarantees structured output — Sonnet returns a JSON payload that
 * matches REFLECT_TOOL_SCHEMA, eliminating the freeform-prose parsing failures
 * we saw with the Sprint 3 verifier pass.
 */

export interface ReflectMemoryInput {
  id: string;
  text: string;
  observedAt: Date;
}

export interface ReflectMessages {
  system: string;
  user: string;
}

const SYSTEM_PROMPT = [
  'You are consolidating a single conversation\'s raw memories into a small set of typed observations.',
  'Each observation must (a) be answerable from the cited evidence_memory_ids alone, (b) prefer concrete factual claims over narrative, (c) avoid restating the raw facts verbatim.',
  '',
  'Observation types (use exactly one per observation):',
  '- entity_state: the current value of an attribute on an entity, with the latest-known value',
  '- event_summary: a discrete event or action that happened',
  '- preference: a stated user preference, opinion, or choice',
  '- contradiction: two facts in the session that disagree (include both sides)',
  '- decision: a user decision made during the session',
  '- numeric_value: a numeric fact (count, amount, duration, percentage)',
  '',
  'REQUIRED FIRST OBSERVATION — topic inventory:',
  'Always emit FIRST an event_summary observation whose text BEGINS with "TOPIC_INVENTORY: " followed by a comma-separated list of the 3–8 distinct top-level concerns/topics/features discussed in this session. GROUP related items into broad categories (e.g. "error handling for 404", "error handling for 401", and "retry logic" → ONE category "API error handling"). The count of items in this list will be used to answer "how many distinct X did I mention" questions, so prefer the smallest reasonable number of broad categories. Cite all relevant memory_ids as evidence.',
  '',
  'Output 5–15 observations TOTAL (including the required topic inventory). Call the record_observations tool.',
].join('\n');

export const REFLECT_TOOL_SCHEMA = {
  name: 'record_observations',
  description: 'Persist the consolidated observations for this conversation.',
  input_schema: {
    type: 'object',
    properties: {
      observations: {
        type: 'array',
        items: {
          type: 'object',
          required: ['text', 'type', 'evidence_memory_ids'],
          properties: {
            text: { type: 'string' },
            type: {
              type: 'string',
              enum: [
                'entity_state', 'event_summary', 'preference',
                'contradiction', 'decision', 'numeric_value',
              ],
            },
            evidence_memory_ids: {
              type: 'array',
              items: { type: 'string' },
            },
          },
        },
      },
    },
    required: ['observations'],
  },
} as const;

export function buildReflectMessages(memories: readonly ReflectMemoryInput[]): ReflectMessages {
  const lines = memories.map(
    m => `[${m.id}] (${m.observedAt.toISOString().slice(0, 10)}) ${m.text}`,
  );
  const user = ['Memories from this conversation (chronological):', '', ...lines].join('\n');
  return { system: SYSTEM_PROMPT, user };
}

/**
 * Input shape for entity-card synthesis. One observation per row, with the
 * observation_id citation, observation date, and observation text. Used by
 * the always-on ENTITY_CARD channel synthesizer.
 */
export interface EntityCardObservationInput {
  id: string;
  text: string;
  observedAt: Date;
}

const ENTITY_CARD_SYSTEM_PROMPT = (entityName: string): string => [
  `You maintain a durable summary card for entity "${entityName}".`,
  '',
  'The card is read by an answer LLM that must respond to questions about this entity',
  'across multiple sessions without re-retrieving raw memories. The card must be',
  'self-contained, dated where relevant, and capture:',
  '- identity',
  '- current_values (latest known values)',
  '- preferences',
  '- decisions',
  '- contradictions (both sides if any)',
  '- open_threads',
  '',
  'Hard limit: 250 tokens. Prefer short bulleted lines over prose.',
].join('\n');

/**
 * Assemble the messages for an entity-card synthesis call. The model sees the
 * prior card (if any) and a list of new observations citing their obs_ids
 * and dates, and is asked to output ONLY the updated card text.
 */
export function buildEntityCardMessages(
  entityName: string,
  priorCardText: string | null,
  observations: readonly EntityCardObservationInput[],
): ReflectMessages {
  const obsLines = observations.map(
    o => `[${o.id}] (${o.observedAt.toISOString().slice(0, 10)}) ${o.text}`,
  );
  const user = [
    'Prior card:',
    priorCardText && priorCardText.trim().length > 0 ? priorCardText : '(none)',
    '',
    'New observations:',
    ...obsLines,
    '',
    'Output ONLY the updated card text. No preamble.',
  ].join('\n');
  return { system: ENTITY_CARD_SYSTEM_PROMPT(entityName), user };
}
