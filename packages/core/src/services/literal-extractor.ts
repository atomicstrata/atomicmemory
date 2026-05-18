/**
 * Ingest-side literal-value extractor.
 *
 * For each new fact, calls Haiku with tool-use to extract zero or more
 * (entity, attribute, value, value_type) triples. Persists them to the
 * entity_values table.
 *
 * The extractor errs on the side of NOT extracting — only literals that
 * clearly map to "what is the X" / "when does X" / "how many X" question
 * shapes are persisted. Narrative facts without a clean entity/attribute
 * structure are skipped.
 */
import { callAnthropicTool } from './llm.js';
import type { EntityValuesRepository, NewEntityValue, ValueType } from '../db/entity-values-repository.js';

export interface LiteralExtractorDeps {
  values: EntityValuesRepository;
  model: string;
}

export interface ExtractInput {
  userId: string;
  factId: string;
  factText: string;
  observedAt: Date;
}

interface ExtractedTriple {
  entity: string;
  attribute: string;
  value: string;
  value_type: ValueType;
}

const EXTRACT_TOOL_SCHEMA = {
  name: 'extract_literal_triples',
  description: 'Extract structured (entity, attribute, value) triples from a fact, if any.',
  input_schema: {
    type: 'object',
    properties: {
      triples: {
        type: 'array',
        items: {
          type: 'object',
          required: ['entity', 'attribute', 'value', 'value_type'],
          properties: {
            entity: { type: 'string', description: 'The subject. e.g. "first sprint", "API key", "test coverage"' },
            attribute: { type: 'string', description: 'The relation. e.g. "end date", "daily quota", "percentage"' },
            value: { type: 'string', description: 'LITERAL value AS IT APPEARS in the fact. Do not paraphrase.' },
            value_type: {
              type: 'string',
              enum: ['date', 'number', 'string', 'duration', 'list'],
            },
          },
        },
      },
    },
    required: ['triples'],
  },
} as const;

const EXTRACTOR_SYSTEM = `You are extracting (entity, attribute, value) triples from a single user fact.

Output triples ONLY when the fact contains a clean structured claim like:
- "first sprint ends March 29" → (first sprint, end date, March 29, date)
- "API key has 1,200 daily calls" → (API key, daily quota, 1,200 calls per day, number)
- "test coverage is 78%" → (test coverage, percentage, 78%, number)
- "uses vanilla JavaScript ES2021" → (project, technology, vanilla JavaScript ES2021, string)

Skip facts that are narrative ("the user decided to..."), opinions, or vague.

CRITICAL: the value field must be the LITERAL string from the fact. Do not paraphrase. "1,200 calls per day" not "around 1000 calls". "March 29" not "end of March". "78%" not "high coverage".

Call extract_literal_triples. If no triples, return an empty array.`;

/**
 * Extract literal (entity, attribute, value) triples from a single fact text
 * and persist them to entity_values. Returns the count of triples inserted.
 */
export async function extractLiteralsFromFact(
  deps: LiteralExtractorDeps,
  input: ExtractInput,
): Promise<number> {
  if (!input.factText.trim()) return 0;
  const result = await callAnthropicTool<{ triples: ExtractedTriple[] }>(
    deps.model,
    EXTRACTOR_SYSTEM,
    `Fact: ${input.factText}`,
    EXTRACT_TOOL_SCHEMA,
  );
  if (result.triples.length === 0) return 0;
  const rows: NewEntityValue[] = result.triples.map(t => ({
    userId: input.userId,
    entity: t.entity,
    attribute: t.attribute,
    value: t.value,
    valueType: t.value_type,
    observedAt: input.observedAt,
    factId: input.factId,
  }));
  await deps.values.insertMany(rows);
  return rows.length;
}
