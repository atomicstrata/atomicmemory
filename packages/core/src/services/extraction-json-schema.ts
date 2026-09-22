/**
 * Structured JSON schemas for extraction/AUDN LLM calls.
 * AUDN uses an explicit schema so am-local-slm does not route it through
 * the extraction-only `core_extraction_schema()` grammar.
 */

import type { ChatOptions } from './llm.js';

export const AUDN_SCHEMA_NAME = 'core_audn';

/** Matches the AUDN parser fields in extraction.ts. */
const AUDN_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: ['ADD', 'UPDATE', 'SUPERSEDE', 'DELETE', 'NOOP', 'CLARIFY'],
    },
    target_memory_id: { type: ['string', 'null'] },
    updated_content: { type: ['string', 'null'] },
    clarification_note: { type: ['string', 'null'] },
    contradiction_confidence: { type: ['number', 'null'] },
  },
  // OpenAI strict json_schema requires every property in `required`;
  // nullable types represent optional values.
  required: [
    'action',
    'target_memory_id',
    'updated_content',
    'clarification_note',
    'contradiction_confidence',
  ],
};

/** Chat options that request the AUDN grammar instead of generic json_object. */
export function audnJsonChatOptions(maxTokens: number): Pick<ChatOptions, 'jsonMode' | 'jsonSchema' | 'maxTokens'> {
  return {
    jsonMode: true,
    maxTokens,
    jsonSchema: {
      name: AUDN_SCHEMA_NAME,
      strict: true,
      schema: AUDN_RESPONSE_SCHEMA,
    },
  };
}

/**
 * Prompt variant and wire format are independent axes. Send json_schema
 * only when the provider can honor a client grammar (am-local-slm with
 * AM_SLM_CORE_JSON_SCHEMA=1). Groq and other OpenAI-compatible hosts that
 * reject strict Structured Outputs stay on json_object.
 */
export function audnChatOptions(
  useJsonSchema: boolean,
  maxTokens: number,
): Pick<ChatOptions, 'jsonMode' | 'jsonSchema' | 'maxTokens'> {
  if (useJsonSchema) return audnJsonChatOptions(maxTokens);
  return { jsonMode: true, maxTokens };
}
