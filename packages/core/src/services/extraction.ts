/**
 * Memory extraction and AUDN resolution.
 * Step 1: Extract discrete facts from conversation text.
 * Step 2: For each fact with similar existing memories, LLM decides:
 *   Add (new), Update (merge), Delete (outdated), or Noop (skip).
 * Uses the LLM provider abstraction for model-agnostic operation.
 */

import { llm } from './llm.js';
import { withCostStage } from './cost-telemetry.js';
import { timed, timedSync } from './timing.js';
import { normalizeExtractedFacts } from './fact-normalization.js';
import { enrichExtractedFacts } from './extraction-enrichment.js';
import { mergeSupplementalFacts } from './supplemental-extraction.js';
import {
  applyObservationDateAnchors,
  buildExtractionUserMessage,
  type ExtractionOptions,
} from './observation-date-extraction.js';
import { filterMetaFacts } from './meta-fact-filter.js';

const EXTRACTION_MAX_TOKENS = 4096;
const AUDN_MAX_TOKENS = 2048;

export type { ExtractionOptions };

/** Strip markdown code fences (```json ... ```) that some LLMs wrap around JSON output. */
function stripJsonFences(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('```')) {
    const firstNewline = trimmed.indexOf('\n');
    if (firstNewline < 0) return trimmed;
    const lastFence = trimmed.lastIndexOf('```');
    if (lastFence > firstNewline) {
      // Both opening and closing fences present
      return trimmed.slice(firstNewline + 1, lastFence).trim();
    }
    // Opening fence but no closing fence (truncated response) — strip the opening fence
    return trimmed.slice(firstNewline + 1).trim();
  }
  return trimmed;
}

/** Return the first complete JSON object, tolerating prose before/after it. */
export function extractFirstJsonObject(raw: string): string {
  const cleaned = stripJsonFences(raw);
  if (isValidJson(cleaned)) return cleaned;

  const start = cleaned.indexOf('{');
  if (start < 0) return cleaned;

  const end = findBalancedJsonObjectEnd(cleaned, start);
  return end < 0 ? cleaned : cleaned.slice(start, end + 1);
}

function isValidJson(value: string): boolean {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

interface JsonScanState {
  depth: number;
  inString: boolean;
  escaped: boolean;
}

function findBalancedJsonObjectEnd(input: string, start: number): number {
  const state: JsonScanState = { depth: 0, inString: false, escaped: false };
  for (let i = start; i < input.length; i++) {
    if (advanceJsonScanState(state, input[i]!)) return i;
  }
  return -1;
}

function advanceJsonScanState(state: JsonScanState, char: string): boolean {
  if (state.escaped) {
    state.escaped = false;
    return false;
  }
  if (char === '\\') {
    state.escaped = state.inString;
    return false;
  }
  if (char === '"') {
    state.inString = !state.inString;
    return false;
  }
  if (state.inString) return false;
  return updateJsonDepth(state, char);
}

function updateJsonDepth(state: JsonScanState, char: string): boolean {
  if (char === '{') state.depth++;
  if (char === '}') state.depth--;
  return state.depth === 0;
}

/**
 * Attempts to recover a valid JSON object from truncated LLM output.
 * Finds the last complete object boundary, closes unterminated strings/arrays/objects,
 * and wraps in the expected `{"memories": [...]}` structure if needed.
 */
function repairTruncatedJson(raw: string): string | null {
  const lastBrace = raw.lastIndexOf('}');
  if (lastBrace <= 0) return null;

  const candidate = removeTrailingJsonCommas(raw.slice(0, lastBrace + 1));
  if (isValidJson(candidate)) return candidate;

  const repaired = closeAtLastCompleteArrayEntry(candidate);
  return repaired && isValidJson(repaired) ? repaired : null;
}

function removeTrailingJsonCommas(value: string): string {
  return value.replace(/,\s*\]/, ']').replace(/,\s*\}/, '}');
}

function closeAtLastCompleteArrayEntry(candidate: string): string | null {
  // Walk backwards to find the last complete array entry boundary
  // Look for `},` or `}]` patterns that mark a complete object in the memories array
  const lastCompleteEntry = candidate.lastIndexOf('},');
  const lastArrayClose = candidate.lastIndexOf('}]');
  const cutPoint = Math.max(lastCompleteEntry, lastArrayClose);
  if (cutPoint <= 0) return null;

  return closeOpenJsonContainers(candidate.slice(0, cutPoint + 1));
}

function closeOpenJsonContainers(value: string): string {
  const openBrackets = Math.max(0, countMatches(value, '[') - countMatches(value, ']'));
  const openBraces = Math.max(0, countMatches(value, '{') - countMatches(value, '}'));
  return value + ']'.repeat(openBrackets) + '}'.repeat(openBraces);
}

function countMatches(value: string, char: string): number {
  return [...value].filter((candidate) => candidate === char).length;
}

export interface ExtractedEntity {
  name: string;
  type: 'person' | 'tool' | 'project' | 'organization' | 'place' | 'concept';
}

export type ExtractedRelationType =
  | 'uses' | 'works_on' | 'works_at' | 'located_in' | 'knows'
  | 'prefers' | 'created' | 'belongs_to' | 'studies' | 'manages';

export interface ExtractedRelation {
  source: string;
  target: string;
  type: ExtractedRelationType;
}

export interface ExtractedFact {
  fact: string;
  headline: string;
  importance: number;
  type: 'preference' | 'project' | 'knowledge' | 'person' | 'plan';
  keywords: string[];
  entities: ExtractedEntity[];
  relations: ExtractedRelation[];
  /** Memory network classification (set post-extraction by classifyNetwork). */
  network?: 'world' | 'experience' | 'opinion' | 'observation';
  /** Opinion confidence [0,1], only set when network='opinion'. */
  opinionConfidence?: number | null;
}

export type AUDNAction = 'ADD' | 'UPDATE' | 'DELETE' | 'SUPERSEDE' | 'NOOP' | 'CLARIFY';

export interface AUDNDecision {
  action: AUDNAction;
  targetMemoryId: string | null;
  updatedContent: string | null;
  clarificationNote?: string | null;
  contradictionConfidence: number | null;
}

export interface ExistingMemory {
  id: string;
  content: string;
  similarity: number;
}

export const EXTRACTION_PROMPT = `You are a memory extraction system. Extract discrete, self-contained facts from the conversation below. Each fact should be useful if retrieved months later in a completely different conversation.

RULES:
- Each fact must be a single, atomic statement.
- **AGGRESSIVE TECHNOLOGY SPLITTING**: Every named tool, framework, library, or technology MUST become its own separate fact. Never combine multiple technologies into a single fact.
  WRONG: "User is building a React project with Tailwind CSS and Supabase."
  RIGHT: Three separate facts:
    1. "As of January 2026, user is building a personal finance tracker using React."
    2. "As of January 2026, user is using Tailwind CSS for styling in the finance tracker project."
    3. "As of January 2026, user is using Supabase for the backend and database in the finance tracker project."
- If a sentence contains multiple independent attributes of the same project or tool, split them into separate facts.
- If a sentence contains both a technical choice and who recommended it, extract separate facts for the choice and the recommendation.
- Each technology fact MUST include the project name, the current date (if available), and the specific role of the technology.
- Include enough context to be understood in isolation.
- Replace pronouns with specific names/references.
- Convert relative times to absolute when possible.
- Always include dates and timestamps in extracted facts when available (e.g. "As of January 2026, user prefers Vite" not just "User prefers Vite").
- If the conversation has a date/session header, use it to anchor facts temporally.
- **ENTITY-FOCUSED EXTRACTION**: Every named person, institution, organization, specific number, or score mentioned by the user MUST appear in at least one extracted fact. Scan the conversation for these and create dedicated facts:
  - People: names, roles, relationships (e.g. "Dr. Chen is user's advisor at Microsoft Research")
  - Institutions: universities, companies, labs (e.g. "User got BS in Computer Science from UC Berkeley")
  - Numbers/scores: test scores, percentages, counts (e.g. "User scored 170 on GRE quant")
  - Licenses/certifications: specific names (e.g. "User plans to use MIT license for dotctl")
  - Future plans: specific tools or techniques planned (e.g. "User plans to add ML classification using TensorFlow.js")
  If you find a name, number, or institution in the conversation that is NOT in any extracted fact, you MUST add a fact for it.
- **CORRECTION/REVISION PRESERVATION**: When the conversation contains an explicit correction, revision, or supersession of a previous statement (e.g. "Correction:", "Actually,", "Changed my mind"), the extracted fact MUST preserve the corrective relationship. Include phrasing like "instead of Y", "replacing Y", "corrected from Y", or "no longer Y" so the system can detect the supersession.
  WRONG: "User wants PostgreSQL for the production backend."
  RIGHT: "User wants PostgreSQL for the production backend, replacing the earlier MongoDB choice."
- Skip pleasantries, filler, acknowledgments, and meta-conversation.
- Skip generic assistant chatter (acknowledgments, "sure!", "got it", "as an AI").
- **Extract durable facts about the user or the world. Do NOT extract observations about the conversation itself.** A meta-observation describes the chat session (who is speaking, what was just asked, that a term appeared) rather than recording any durable state. If a turn contains only a question or a meta-observation and no new durable fact, emit nothing for that turn. When in doubt, ask: "would this fact still be useful months later in a completely different conversation?" — if no, drop it.
- DO extract specific factual content from assistant responses: named entities, recommendations with proper nouns, schedules, data tables, creative writing with specific details. Prefix these with "Assistant mentioned:" or "Assistant recommended:".
- SHORT INPUTS: Length is NOT a reason to skip a fact. A single user sentence that names a person, place, profession, possession, preference, allergy, hobby, or any other durable attribute of the user IS extractable. Examples:
  - "I'm Alex." → fact: user's name is Alex.
  - "My email is bob@example.com" → fact: user's email is bob@example.com.
  - "I live in Lisbon." → fact: user lives in Lisbon.
  - "I play piano." → fact: user plays piano.
  - "I have a golden retriever named Apollo." → fact: user has a golden retriever named Apollo.
  - "I'm vegetarian." → fact: user is vegetarian.
  Do NOT classify short user statements as "pleasantries" or "filler" when they contain a named entity or durable attribute.
- CONTACT INFO: Email addresses, phone numbers, home addresses, and similar personal details are always extractable facts with importance >= 0.5.
- Rate importance 0.0-1.0:
  0.0-0.3 = trivial (greeting style, minor preferences)
  0.4-0.6 = useful (project details, tools mentioned)
  0.7-0.9 = important (core preferences, key decisions, recurring patterns)
  1.0 = critical (explicit instructions for future, strong opinions)

CATEGORIES:
- preference: Likes, dislikes, opinions, style choices
- project: What the user is building, tools used, architecture decisions
- knowledge: Patterns learned, problems solved, techniques discovered
- person: People mentioned, relationships, roles
- plan: Goals, intentions, scheduled activities, future work

KEYWORDS:
For each fact, extract keywords that a keyword search should match. Include:
- Proper nouns (people, companies, products, tools): "Jake", "Supabase", "TanStack Virtual"
- Dates and time references: "January 15 2026", "February 5 2026"
- Project names and domains: "fintrack.app", "dotctl"
- Technical terms that might be lost in paraphrasing: "tRPC", "LoRA", "EMNLP"
- Organization names: "Stanford", "Microsoft Research", "MIT"
Keywords preserve the original spelling and casing from the conversation.

HEADLINE:
For each fact, write a short headline (max 10 words) that captures the key point.
The headline is used as a compact preview when listing memories. It should contain
the most important entity and action from the fact.
Example: "User prefers Vite over Webpack for all React projects" → "Prefers Vite over Webpack for React"

ENTITIES:
For each fact, extract the named entities mentioned. Each entity has:
- name: The entity's canonical name (e.g. "Jake", "PostgreSQL", "Dataflow Inc")
- type: One of: person, tool, project, organization, place, concept
Entity types:
- person: Named individuals (e.g. "Jake", "Dr. Chen", "Sarah")
- tool: Software, libraries, frameworks (e.g. "PostgreSQL", "Vite", "React")
- project: Named projects or products (e.g. "DataFlow", "MealMate", "dotctl")
- organization: Companies, universities, teams (e.g. "MIT", "Google", "Dataflow Inc")
- place: Cities, countries, addresses (e.g. "San Francisco", "Berlin")
- concept: Abstract concepts, methodologies (e.g. "microservices", "TDD")
Only extract entities explicitly named in the fact. Do not infer entities not mentioned.

RELATIONS:
For each fact, extract relationships between entities mentioned in that fact.
Each relation has:
- source: Name of the source entity (must match an entity name above)
- target: Name of the target entity (must match an entity name above)
- type: One of: uses, works_on, works_at, located_in, knows, prefers, created, belongs_to, studies, manages
Relation types:
- uses: Person/project uses a tool/technology
- works_on: Person works on a project
- works_at: Person works at an organization
- located_in: Person/organization is located in a place
- knows: Person knows another person
- prefers: Person prefers a tool/concept
- created: Person created a project/tool
- belongs_to: Entity belongs to an organization/group
- studies: Person studies a concept/field
- manages: Person manages a project/team
Only extract relations between entities explicitly mentioned in the fact. If a fact has fewer than 2 entities, return an empty relations array.

OUTPUT FORMAT (JSON):
{
  "memories": [
    {
      "fact": "User prefers Vite over Webpack for all React projects",
      "headline": "Prefers Vite over Webpack for React",
      "importance": 0.7,
      "type": "preference",
      "keywords": ["Vite", "Webpack", "React"],
      "entities": [
        {"name": "Vite", "type": "tool"},
        {"name": "Webpack", "type": "tool"},
        {"name": "React", "type": "tool"}
      ],
      "relations": [
        {"source": "User", "target": "Vite", "type": "prefers"}
      ]
    }
  ]
}

If no extractable facts exist, return: {"memories": []}`;

export async function extractFacts(
  conversationText: string,
  options: ExtractionOptions = {},
): Promise<ExtractedFact[]> {
  const content = await timed('ingest.extract.llm', () => withCostStage('extract', () => llm.chat(
    [
      { role: 'system', content: EXTRACTION_PROMPT },
      { role: 'user', content: buildExtractionUserMessage(conversationText, options) },
    ],
    { temperature: 0, jsonMode: true, maxTokens: EXTRACTION_MAX_TOKENS },
  )));

  if (!content) return [];

  const rawFacts = timedSync('ingest.extract.parse', () => parseExtractionResponse(content));
  if (!rawFacts) return [];

  return timedSync('ingest.extract.post-process', () => {
    const normalized: ExtractedFact[] = rawFacts.map((m) => normalizeRawFact(m));
    const anchoredFacts = applyObservationDateAnchors(normalized, conversationText, options);
    const baseFacts = enrichExtractedFacts(normalizeExtractedFacts(anchoredFacts));
    const merged = mergeSupplementalFacts(baseFacts, conversationText);
    // Drop extraction-style meta-facts that describe the conversation
    // itself rather than recording a durable user fact. These poison
    // the embedding pool downstream. The filter is on by default;
    // operators can disable for incident response via
    // ATOMICMEMORY_META_FACT_FILTER=off. See
    // src/services/meta-fact-filter.ts for rationale + AlignBench v0
    // (the AlignBench v0 results) for evidence.
    // Drops are logged structured ("[meta-fact-filter] dropped …") and
    // counted via getMetaFactDropStats() for operator monitoring.
    return filterMetaFacts(merged, { source: 'extract' });
  });
}

type RawExtractedFact = ExtractedFact & {
  statement?: string;
  keywords?: string[];
  headline?: string;
  entities?: ExtractedEntity[];
  relations?: ExtractedRelation[];
};

/** Parse and validate LLM extraction response, returning raw facts or null on failure. */
function parseExtractionResponse(content: string): (RawExtractedFact | LeafFact)[] | null {
  const cleanedContent = stripJsonFences(content);
  const parsed = parseJsonWithRepair(cleanedContent);
  if (!parsed) return null;
  return resolveFactArray(parsed, content);
}

/** Parse JSON, falling back to truncated-JSON repair on failure. */
function parseJsonWithRepair(
  cleanedContent: string,
): Record<string, unknown> | null {
  try {
    return JSON.parse(cleanedContent);
  } catch (err) {
    console.warn(`[extractFacts] JSON parse failed (${(err as Error).message}); attempting repair`);
  }
  const repaired = repairTruncatedJson(cleanedContent);
  if (!repaired) {
    console.warn('[extractFacts] No valid JSON found; returning empty. Raw:', cleanedContent.slice(0, 300));
    return null;
  }
  try {
    return JSON.parse(repaired);
  } catch {
    console.warn('[extractFacts] JSON repair failed; returning empty. Raw:', cleanedContent.slice(0, 300));
    return null;
  }
}

/** Extract a fact array from parsed JSON, trying standard keys then fallbacks. */
function resolveFactArray(
  parsed: Record<string, unknown>,
  rawContent: string,
): (RawExtractedFact | LeafFact)[] | null {
  const standardArray = (parsed as { memories?: unknown[]; facts?: unknown[] }).memories
    ?? (parsed as { memories?: unknown[]; facts?: unknown[] }).facts;
  if (Array.isArray(standardArray)) return standardArray as RawExtractedFact[];

  const found = findFactArray(parsed) as RawExtractedFact[] | null;
  if (found) return found;

  const leafFacts = extractLeafFacts(parsed);
  if (leafFacts.length > 0) {
    console.warn(`[extractFacts] Recovered ${leafFacts.length} facts from non-standard JSON structure`);
    return leafFacts;
  }
  console.warn('[extractFacts] LLM returned no memories array; raw:', rawContent.slice(0, 200));
  return null;
}

/** Normalize a single raw extracted fact into the canonical ExtractedFact shape. */
function normalizeRawFact(m: RawExtractedFact | LeafFact): ExtractedFact {
  const rawEntry = m as RawExtractedFact;
  const fact = rawEntry.fact ?? rawEntry.statement ?? '';
  const rawImportance = Number(m.importance);
  const importance = Number.isFinite(rawImportance) ? Math.max(0, Math.min(1, rawImportance)) : 0.5;
  const VALID_TYPES = new Set<ExtractedFact['type']>(['preference', 'project', 'knowledge', 'person', 'plan']);
  const rawType = typeof m.type === 'string' ? m.type.toLowerCase() : '';
  return {
    fact,
    importance,
    type: VALID_TYPES.has(rawType as ExtractedFact['type']) ? rawType as ExtractedFact['type'] : 'knowledge',
    keywords: Array.isArray(m.keywords) ? m.keywords : [],
    headline: typeof m.headline === 'string' && m.headline.trim() ? m.headline.trim() : generateFallbackHeadline(fact),
    entities: normalizeExtractedEntities(m.entities),
    relations: normalizeExtractedRelations(m.relations),
  };
}

/**
 * Search parsed JSON for the first array value containing fact-like objects
 * (objects with a 'fact' or 'statement' string field).
 */
function findFactArray(obj: Record<string, unknown>): unknown[] | null {
  for (const value of Object.values(obj)) {
    if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'object' && value[0] !== null) {
      const first = value[0] as Record<string, unknown>;
      if (typeof first.fact === 'string' || typeof first.statement === 'string') {
        return value;
      }
    }
  }
  return null;
}

const MIN_LEAF_FACT_LENGTH = 30;
const MAX_LEAF_FACT_LENGTH = 500;

/**
 * Extract leaf string values from arbitrarily nested JSON as bare facts.
 * Handles cases where the LLM returns structured objects like:
 *   {"user_activities": {"return_boots": {"date": "Feb 5", "action": "exchange"}}}
 * Converts key-value pairs into fact strings.
 */
interface LeafFact {
  fact: string;
  importance: number;
  headline: string;
  type: 'knowledge';
  keywords: string[];
  entities: ExtractedEntity[];
  relations: ExtractedRelation[];
}

function extractLeafFacts(obj: unknown, path: string[] = []): LeafFact[] {
  if (obj === null || obj === undefined) return [];

  if (typeof obj === 'string') {
    return extractLeafFromString(obj);
  }
  if (Array.isArray(obj)) {
    return obj.flatMap((item) => extractLeafFacts(item, path));
  }
  if (typeof obj === 'object') {
    return extractLeafFromObject(obj as Record<string, unknown>, path);
  }
  return [];
}

/** Build a LeafFact with default fields. */
function makeLeafFact(fact: string, headline: string): LeafFact {
  return { fact, importance: 0.5, headline, type: 'knowledge', keywords: [], entities: [], relations: [] };
}

/** Extract a leaf fact from a string if it meets length requirements. */
function extractLeafFromString(text: string): LeafFact[] {
  if (text.length >= MIN_LEAF_FACT_LENGTH && text.length <= MAX_LEAF_FACT_LENGTH) {
    return [makeLeafFact(text, text.slice(0, 60))];
  }
  return [];
}

/** Try to combine an object's string values into a fact, or recurse into children. */
function extractLeafFromObject(record: Record<string, unknown>, path: string[]): LeafFact[] {
  const combinedFact = tryCombineStringEntries(record, path);
  if (combinedFact) return [combinedFact];

  const facts: LeafFact[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (key === 'error' || key === 'response') continue;
    facts.push(...extractLeafFacts(value, [...path, key]));
  }
  return facts;
}

/** Combine 2-6 short string entries into a single fact, or return null. */
function tryCombineStringEntries(record: Record<string, unknown>, path: string[]): LeafFact | null {
  const stringEntries = Object.entries(record).filter(
    ([, v]) => typeof v === 'string' && (v as string).length > 3,
  );
  if (stringEntries.length < 2 || stringEntries.length > 6) return null;

  const combined = stringEntries
    .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`)
    .join('. ');
  if (combined.length < MIN_LEAF_FACT_LENGTH || combined.length > MAX_LEAF_FACT_LENGTH) return null;

  const headline = path.length > 0 ? path[path.length - 1].replace(/_/g, ' ') : combined.slice(0, 60);
  return makeLeafFact(combined, headline);
}

const AUDN_PROMPT = `You manage a memory store. Given a NEW fact extracted from a conversation and EXISTING memories that are semantically similar, decide what to do.

ACTIONS:
- ADD: The new fact contains information not already covered by existing memories. Store it as a new memory. This is the DEFAULT action — when in doubt, ADD.
- UPDATE: The new fact is a minor correction or clarification of an existing memory (e.g. fixing a typo, adding a small qualifier). The updated_content replaces the existing memory. Use ONLY when the result would be roughly the same length as the original.
- SUPERSEDE: The new fact explicitly contradicts an existing memory (e.g. user changed preference, switched tools, reversed a decision). The old memory is marked as superseded and the new fact is stored. This is the PREFERRED action for contradictions — do NOT use UPDATE to merge contradictory facts.
- DELETE: The existing memory is completely wrong or obsolete and should be removed. Use SUPERSEDE instead when the new fact replaces the old one.
- NOOP: The new fact is EXACTLY the same information as an existing memory, just rephrased. Only use when NO new information would be gained by storing the fact.
- CLARIFY: The new fact conflicts with an existing memory but the confidence is low, or it's a critical safety conflict that requires user confirmation.

RULES:
- **Prefer ADD over UPDATE.** Two separate facts about the same topic should be stored as two memories, not merged into one. For example, "user uses Go for dotctl" and "user plans to open source dotctl under MIT" are two separate facts even though both are about dotctl.
- **NEVER MERGE TECHNICAL DETAILS**: If a project uses multiple tools (e.g. Vite, React, Supabase), each MUST be a separate memory. Do NOT update a "project uses React" memory to include "and Vite". Use ADD instead.
- Only use NOOP when the new fact is truly redundant — it adds zero new information beyond what's already stored.
- Only use UPDATE for minor corrections (typos, small qualifiers), NOT for combining related facts. If the updated_content would be substantially longer than the original, use ADD instead.
- Use SUPERSEDE (not UPDATE) when the new fact contradicts or replaces an old one. Never merge contradictory facts into one statement.
- Use DELETE only for removing clearly wrong or spam content, not for preference changes.
- Use CLARIFY if you detect a conflict but:
  1. The user sounds uncertain ('I think...', 'maybe...', 'not sure').
  2. The existing fact is critical (Importance >= 0.9) and the new input is brief or lacks explanation.
  3. The conflict is complex and merging them into an 'UPDATE' would lose important nuance.
- **CRITICAL**: If you are unsure whether to SUPERSEDE or CLARIFY, you MUST choose **CLARIFY**. It is better to ask for confirmation than to store potentially false information.
- The updated_content for UPDATE should be a single self-contained statement roughly the same length as the original.

OUTPUT FORMAT (JSON):
{
  "action": "ADD" | "UPDATE" | "SUPERSEDE" | "DELETE" | "NOOP" | "CLARIFY",
  "target_memory_id": null | "id of existing memory to update or delete",
  "updated_content": null | "merged content for UPDATE action",
  "clarification_note": null | "description of the conflict for CLARIFY action",
  "contradiction_confidence": null | 0.0-1.0
}

Return only the JSON object. Do not wrap it in markdown fences. Do not explain your reasoning.
`;

export async function resolveAUDN(
  newFact: string,
  existingMemories: ExistingMemory[],
): Promise<AUDNDecision> {
  const memoriesBlock = existingMemories
    .map((m) => `[ID: ${m.id}] (similarity: ${m.similarity.toFixed(2)}) ${m.content}`)
    .join('\n');

  const content = await llm.chat(
    [
      { role: 'system', content: AUDN_PROMPT },
      { role: 'user', content: `NEW FACT: ${newFact}\n\nEXISTING MEMORIES:\n${memoriesBlock}` },
    ],
    { temperature: 0, jsonMode: true, maxTokens: AUDN_MAX_TOKENS },
  );

  if (!content) {
    return defaultDecision();
  }

  const cleanedAudn = extractFirstJsonObject(content);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(cleanedAudn) as Record<string, unknown>;
  } catch {
    console.error('AUDN JSON parse failed, defaulting to ADD. Raw:', content.slice(0, 200));
    return defaultDecision();
  }

  return {
    action: normalizeAction(parsed.action as string | undefined),
    targetMemoryId: sanitizeUuid(parsed.target_memory_id as string | null),
    updatedContent: (parsed.updated_content as string | null) ?? null,
    clarificationNote: (parsed.clarification_note as string | null) ?? null,
    contradictionConfidence: normalizeConfidence(
      parsed.contradiction_confidence as number | null | undefined,
      (parsed.action as string) ?? 'ADD',
      newFact,
    ),
  };
}

const QUERY_REWRITE_PROMPT = `You rewrite user messages into better memory retrieval queries. The goal is to find stored facts about the user that are relevant to their current message.

RULES:
- Expand the query to cover related topics the memory store might contain.
- **DO NOT** introduce new concepts, entities, or requirements not present in the original query.
- **PRESERVE ALL ENTITIES**: Keep all specific names (Dr. Chen, Stanford, dotctl, etc.) from the original.
- If the query mentions "backup plan", do not assume it means data backups unless specified.
- Keep it concise — a single paragraph of search terms and phrases.
- Do NOT answer the question — only rewrite it for retrieval.
- If the query is already specific and factual, return it mostly unchanged.

OUTPUT: Return ONLY the rewritten query text, nothing else.`;

/**
 * LRU cache for query rewrites — avoids redundant LLM calls for identical queries.
 * Temperature=0 makes output deterministic, so caching is safe.
 */
const REWRITE_CACHE_MAX = 128;
const rewriteCache = new Map<string, string>();

export async function rewriteQuery(query: string): Promise<string> {
  const cached = rewriteCache.get(query);
  if (cached !== undefined) {
    // Move to end (most recently used)
    rewriteCache.delete(query);
    rewriteCache.set(query, cached);
    return cached;
  }

  const content = await llm.chat(
    [
      { role: 'system', content: QUERY_REWRITE_PROMPT },
      { role: 'user', content: query },
    ],
    { temperature: 0, maxTokens: 200 },
  );
  const rewritten = content.trim() || query;

  if (rewriteCache.size >= REWRITE_CACHE_MAX) {
    const oldest = rewriteCache.keys().next().value;
    if (oldest !== undefined) rewriteCache.delete(oldest);
  }
  rewriteCache.set(query, rewritten);
  return rewritten;
}

/** Clear the rewrite cache (for testing). */
export function clearRewriteCache(): void {
  rewriteCache.clear();
}

/** Get rewrite cache size (for testing/monitoring). */
export function getRewriteCacheSize(): number {
  return rewriteCache.size;
}

const MULTI_QUERY_PROMPT = `You generate alternative search queries for a memory retrieval system. Given a user question, produce exactly 3 alternative phrasings that might match stored facts differently.

RULES:
- Each variant should emphasize different aspects, synonyms, or entity names from the question
- Keep variants concise (1-2 sentences each)
- Do NOT answer the question — only rephrase it for retrieval
- Include entity names, proper nouns, and specific terms likely stored in memory

OUTPUT: Return exactly 3 lines, one query variant per line. No numbering, no bullets, no extra text.`;

async function generateQueryVariants(query: string): Promise<string[]> {
  const content = await llm.chat(
    [
      { role: 'system', content: MULTI_QUERY_PROMPT },
      { role: 'user', content: query },
    ],
    { temperature: 0.3, maxTokens: 300 },
  );
  if (!content) return [];
  return content.trim().split('\n').filter((line) => line.trim().length > 0).slice(0, 3);
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Sanitize a UUID string from LLM output: trim whitespace, validate format. */
function sanitizeUuid(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.replace(/\s+/g, '').trim();
  return UUID_REGEX.test(trimmed) ? trimmed : null;
}

/** Normalize a raw action string to a valid AUDNAction, defaulting to ADD. */
export function normalizeAction(raw: string | undefined | null): AUDNAction {
  if (!raw) return 'ADD';
  const upper = raw.toUpperCase().trim();
  if (upper === 'ADD' || upper === 'UPDATE' || upper === 'DELETE' || upper === 'SUPERSEDE' || upper === 'NOOP' || upper === 'CLARIFY') {
    return upper;
  }
  return 'ADD';
}

/** Return the default ADD decision (no target, no content). */
export function defaultDecision(): AUDNDecision {
  return {
    action: 'ADD',
    targetMemoryId: null,
    updatedContent: null,
    clarificationNote: null,
    contradictionConfidence: null,
  };
}

/** Normalize contradiction confidence: clamp to [0,1] or infer from action. */
export function normalizeConfidence(
  value: number | null | undefined,
  rawAction: string,
  newFact: string,
): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.min(1, value));
  }
  const action = normalizeAction(rawAction);
  if (action === 'CLARIFY') return inferConflictConfidence(newFact, true);
  if (action === 'SUPERSEDE' || action === 'DELETE') {
    return inferConflictConfidence(newFact, false);
  }
  return null;
}

/** Infer conflict confidence from fact text; forceLow=true returns 0.35. */
export function inferConflictConfidence(newFact: string, forceLow: boolean): number {
  if (forceLow) return 0.35;
  const lower = newFact.toLowerCase();
  const uncertainMarkers = ['maybe', 'might', 'not sure', 'i think', 'perhaps', 'guess', 'check'];
  return uncertainMarkers.some((marker) => lower.includes(marker)) ? 0.35 : 0.9;
}

const VALID_ENTITY_TYPES = new Set(['person', 'tool', 'project', 'organization', 'place', 'concept']);
const VALID_RELATION_TYPES = new Set([
  'uses', 'works_on', 'works_at', 'located_in', 'knows',
  'prefers', 'created', 'belongs_to', 'studies', 'manages',
]);

/** Normalize and validate extracted entities, filtering out invalid entries. */
export function normalizeExtractedEntities(raw: unknown): ExtractedEntity[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e): e is { name: string; type: string } =>
      typeof e === 'object' && e !== null &&
      typeof e.name === 'string' && e.name.trim().length > 0 &&
      typeof e.type === 'string' && VALID_ENTITY_TYPES.has(e.type),
    )
    .map((e) => ({ name: e.name.trim(), type: e.type as ExtractedEntity['type'] }));
}

/** Normalize and validate extracted relations, filtering out invalid entries. */
export function normalizeExtractedRelations(raw: unknown): ExtractedRelation[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r): r is { source: string; target: string; type: string } =>
      typeof r === 'object' && r !== null &&
      typeof r.source === 'string' && r.source.trim().length > 0 &&
      typeof r.target === 'string' && r.target.trim().length > 0 &&
      typeof r.type === 'string' && VALID_RELATION_TYPES.has(r.type),
    )
    .map((r) => ({ source: r.source.trim(), target: r.target.trim(), type: r.type as ExtractedRelationType }));
}

const HEADLINE_MAX_WORDS = 10;

/** Truncate a fact to its first ~10 words as a fallback headline. */
export function generateFallbackHeadline(fact: string): string {
  const words = fact.split(/\s+/);
  if (words.length <= HEADLINE_MAX_WORDS) return fact;
  return words.slice(0, HEADLINE_MAX_WORDS).join(' ') + '...';
}
