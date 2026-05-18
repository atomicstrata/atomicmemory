/**
 * IE/KU (Information Extraction / Knowledge Update) specialist.
 *
 * BEAM IE/KU questions ask for literal values ("what is the X", "when
 * does X"). LLMs paraphrase, judges do literal-string match → score zero.
 *
 * Flow:
 *   1) Pattern-match the query
 *   2) Use a tiny Haiku tool-use call to extract (entity, attribute) from
 *      the query itself
 *   3) SQL lookup against entity_values for the most recent matching row
 *   4) Return the literal value as the answer
 *   5) On miss, return handled=false → shared spine takes over
 */

import type { EntityValuesRepository } from '../../db/entity-values-repository.js';
import { callAnthropicTool } from '../llm.js';

/**
 * Returns true when the query matches IE/KU question shapes: "what is the X",
 * "when does/did X", "what date", "the deadline for".
 */
export function shouldInvokeIeKuSpecialist(query: string): boolean {
  // "what is the X", "when does/did", "what date X" (when X is a noun phrase)
  return /\b(what is the|what'?s the|when does|when did|what date|the deadline for)\b/i.test(query);
}

export interface IeKuSpecialistDeps {
  values: EntityValuesRepository;
  query: string;
  userId: string;
  model: string;
}

export interface IeKuSpecialistResult {
  answer: string;
  handled: boolean;
  matchedEntity: string | null;
  matchedAttribute: string | null;
}

const QUERY_PARSE_SCHEMA = {
  name: 'parse_factual_query',
  description: 'Extract the (entity, attribute) the user is asking about.',
  input_schema: {
    type: 'object',
    properties: {
      entity: { type: 'string', description: 'The subject of the question.' },
      attribute: { type: 'string', description: 'The specific property being asked about.' },
    },
    required: ['entity', 'attribute'],
  },
} as const;

const QUERY_PARSE_SYSTEM = `Extract the (entity, attribute) pair the user is asking about.

Examples:
- "What is the daily call quota for the API key?" → entity="API key", attribute="daily quota"
- "When does my first sprint end?" → entity="first sprint", attribute="end date"
- "What is the test coverage?" → entity="test coverage", attribute="percentage"

Call parse_factual_query.`;

/**
 * Run the IE/KU specialist against a factual query.
 * Returns the literal stored value on a SQL hit, or handled=false on miss.
 */
export async function runIeKuSpecialist(
  deps: IeKuSpecialistDeps,
): Promise<IeKuSpecialistResult> {
  if (!shouldInvokeIeKuSpecialist(deps.query)) {
    return { answer: '', handled: false, matchedEntity: null, matchedAttribute: null };
  }

  const parsed = await callAnthropicTool<{ entity: string; attribute: string }>(
    deps.model, QUERY_PARSE_SYSTEM, `Query: ${deps.query}`, QUERY_PARSE_SCHEMA,
  );

  const row = await deps.values.findLatest(deps.userId, parsed.entity, parsed.attribute);
  if (!row) {
    return { answer: '', handled: false, matchedEntity: parsed.entity, matchedAttribute: parsed.attribute };
  }

  return {
    answer: row.value,
    handled: true,
    matchedEntity: parsed.entity,
    matchedAttribute: parsed.attribute,
  };
}
