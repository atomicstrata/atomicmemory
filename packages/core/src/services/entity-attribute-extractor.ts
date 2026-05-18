/**
 * Entity-Attribute Index (EAI) extractor — Sprint 4.
 *
 * For each ingest with stored memories, runs an LLM pass that extracts
 * (entity_name, attribute_key, attribute_value, value_type) quadruples
 * from the conversation text. The triples populate the entity_attributes
 * table for later lookup by specific-fact retrieval.
 *
 * Example extractions:
 *   - "I added two columns: category and notes" →
 *       (transactions_table, columns, "[category, notes]", list)
 *       (transactions_table, columns_count, "2", number)
 *   - "completed 25 problems with 90% accuracy" →
 *       (problems, count, "25", number)
 *       (problems, accuracy, "90%", string)
 *
 * Fire-and-forget from ingest. Fail-closed on parse errors (throws). The
 * caller wraps in try/catch so failures never block the ingest path.
 */
import type { ChatMessage, LLMProvider } from './llm.js';
import { llm as defaultLlm } from './llm.js';
import { extractFirstJsonObject } from './extraction.js';
import type { MemoryServiceDeps } from './memory-service-types.js';
import type { EntityAttributeInput, ValueType } from '../db/repository-entity-attributes.js';

const EXTRACT_MAX_TOKENS = 1024;
const MAX_TRIPLES_PER_CALL = 24;
const MAX_INPUT_CHARS = 6000;
const ALLOWED_VALUE_TYPES: ReadonlySet<string> = new Set(['number', 'string', 'list', 'boolean', 'date']);

const SYSTEM_PROMPT = [
  'You extract (entity, attribute, value, value_type) quadruples from a user conversation.',
  '',
  'Rules:',
  '- Each quadruple captures one specific fact the user stated or that the assistant confirmed about the user.',
  '- entity_name: the noun phrase the fact is about (e.g. "transactions_table", "weather_app", "triangle_problems").',
  '- attribute_key: a short snake_case key naming what is being measured/described (e.g. "columns_count", "accuracy", "features_list", "api_quota").',
  '- attribute_value: the exact value as a string (e.g. "25", "90%", "category, notes", "1200/day", "true").',
  '- value_type: one of: number, string, list, boolean, date.',
  '- Extract specific facts: counts, names, dates, percentages, lists. Skip vague generalities.',
  '- Do NOT speculate or infer beyond what the conversation directly states.',
  '- Output a JSON object: {"triples": [{"entity_name": "...", "attribute_key": "...", "attribute_value": "...", "value_type": "..."}, ...]}.',
  '- Output up to ' + String(MAX_TRIPLES_PER_CALL) + ' triples.',
  '- No markdown fences. No prose around the JSON.',
].join('\n');

export class EntityAttributeExtractorError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'EntityAttributeExtractorError';
  }
}

interface RawTriple {
  entity_name?: unknown;
  attribute_key?: unknown;
  attribute_value?: unknown;
  value_type?: unknown;
}

/** Extract triples from raw conversation text via the LLM. */
export async function extractEntityAttributes(
  conversationText: string,
  llmClient: LLMProvider = defaultLlm,
): Promise<Array<Omit<EntityAttributeInput, 'userId' | 'sourceMemoryId' | 'observedAt'>>> {
  const text = conversationText.slice(0, MAX_INPUT_CHARS);
  if (text.trim().length === 0) {
    throw new EntityAttributeExtractorError('empty input text');
  }
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: 'CONVERSATION:\n' + text + '\n\nReturn JSON {"triples": [...]}.' },
  ];
  let raw: string;
  try {
    raw = await llmClient.chat(messages, {
      temperature: 0,
      jsonMode: true,
      maxTokens: EXTRACT_MAX_TOKENS,
    });
  } catch (err) {
    throw new EntityAttributeExtractorError(`extractor LLM call failed: ${(err as Error).message}`, err);
  }
  if (!raw) throw new EntityAttributeExtractorError('extractor returned empty content');
  const cleaned = extractFirstJsonObject(raw);
  let parsed: { triples?: unknown };
  try {
    parsed = JSON.parse(cleaned) as { triples?: unknown };
  } catch (err) {
    throw new EntityAttributeExtractorError(`extractor returned non-JSON: ${cleaned.slice(0, 200)}`, err);
  }
  if (!Array.isArray(parsed.triples)) {
    throw new EntityAttributeExtractorError('extractor JSON missing "triples" array');
  }
  return parsed.triples.flatMap((t) => validateTriple(t as RawTriple));
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asValueType(value: unknown): ValueType | null {
  if (typeof value !== 'string') return null;
  return ALLOWED_VALUE_TYPES.has(value) ? (value as ValueType) : null;
}

function validateTriple(t: RawTriple): Array<Omit<EntityAttributeInput, 'userId' | 'sourceMemoryId' | 'observedAt'>> {
  const entityName = asTrimmedString(t.entity_name);
  const attributeKey = asTrimmedString(t.attribute_key);
  const attributeValue = asTrimmedString(t.attribute_value);
  const valueType = asValueType(t.value_type);
  if (!entityName || !attributeKey || !attributeValue || !valueType) return [];
  return [{ entityName, attributeKey, attributeValue, valueType }];
}

/**
 * Post-write fire-and-forget extractor. Pulls the conversation text + the
 * stored memory IDs from the caller, runs the LLM pass, bulk-inserts.
 * Errors are caught and logged; never throws to the caller.
 */
export async function maybeExtractEntityAttributesForIngest(
  deps: MemoryServiceDeps,
  userId: string,
  conversationText: string,
  sessionTimestamp: Date | undefined,
  storedMemoryIds: string[],
): Promise<number> {
  if (!deps.config.entityAttributesEnabled) return 0;
  const repo = deps.stores.entityAttributes;
  if (!repo) return 0;
  if (storedMemoryIds.length === 0) return 0;
  try {
    const triples = await extractEntityAttributes(conversationText);
    if (triples.length === 0) return 0;
    const observedAt = sessionTimestamp ?? new Date();
    const sourceMemoryId = storedMemoryIds[0]; // attribute provenance to the first new memory
    const rows = triples.map((t) => ({
      userId,
      entityName: t.entityName,
      attributeKey: t.attributeKey,
      attributeValue: t.attributeValue,
      valueType: t.valueType,
      sourceMemoryId,
      observedAt,
    }));
    return await repo.bulkInsert(rows);
  } catch (err) {
    console.warn(`[eai] extraction failed for user=${userId}: ${(err as Error).message}`);
    return 0;
  }
}
