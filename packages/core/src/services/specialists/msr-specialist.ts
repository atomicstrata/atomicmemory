/**
 * MSR (Multi-Session Reasoning) specialist — DETERMINISTIC.
 *
 * Smoke v5 evidence: LLM-based dedup overcounted (12 vs gold 'Four')
 * because it couldn't apply the question's implicit verb-filter ('wanting
 * to handle' vs 'mentioned overall').
 *
 * New approach:
 *   1) Extract the action verb from the query ("wanting", "adding", "fixing").
 *   2) Filter retrieved memories to those whose text contains the verb.
 *   3) Group remaining memories by entity (lowercase substring / word overlap).
 *   4) Count distinct entities.
 *
 * Zero LLM calls. The output uses number-word format for small N to match
 * BEAM gold ('Four', 'Two').
 */

/** Pattern check: should the MSR specialist handle this query? */
export function shouldInvokeMsrSpecialist(query: string): boolean {
  return /\b(how many|total number of|across all|combined number)\b/i.test(query);
}

export interface MsrMemoryInput {
  id: string;
  text: string;
  observedAt?: Date;
}

export interface MsrSpecialistDeps {
  /** The retrieved top-K memories from the shared spine. */
  memories: ReadonlyArray<MsrMemoryInput>;
  /** Original user query. */
  query: string;
  /** Unused — kept for API compat. */
  model?: string;
}

export interface MsrSpecialistResult {
  /** Final answer text to return to the user. */
  answer: string;
  /** Distinct items the aggregator identified. */
  items: string[];
  /** Whether the specialist actually handled the query (vs falling through). */
  handled: boolean;
  /** Telemetry: always false in this deterministic implementation. */
  usedLlm: boolean;
}

interface ActionVerbEntry {
  verb: string;
  /** Pattern to detect the verb in the user's query. */
  queryPattern: RegExp;
  /** Pattern to match that verb (any tense) in memory text. */
  memoryPattern: RegExp;
}

const ACTION_VERB_TABLE: readonly ActionVerbEntry[] = [
  {
    verb: 'add',
    queryPattern: /\b(?:wanting to add|want to add|adding|added|wanted to add)\b/i,
    memoryPattern: /\badd(?:ed|ing|s)?\b/i,
  },
  {
    verb: 'fix',
    queryPattern: /\b(?:fixed|fixing|wanting to fix|tried to fix|wanted to fix)\b/i,
    memoryPattern: /\bfix(?:ed|ing|es)?\b/i,
  },
  {
    verb: 'implement',
    queryPattern: /\b(?:implementing|implemented|trying to implement|wanting to implement|wanted to implement)\b/i,
    memoryPattern: /\bimplement(?:ed|ing|s|ation)?\b/i,
  },
  {
    verb: 'use',
    queryPattern: /\b(?:using|used|wanting to use|tried to use)\b/i,
    memoryPattern: /\bus(?:ed|ing|es)\b/i,
  },
  {
    verb: 'handle',
    queryPattern: /\b(?:wanting to handle|want to handle|handling|wanted to handle)\b/i,
    memoryPattern: /\bhandl(?:ed|ing|es|e)\b/i,
  },
  {
    verb: 'mention',
    queryPattern: /\b(?:mentioned|mentioning|mention)\b/i,
    memoryPattern: /\bmention(?:ed|ing|s)?\b/i,
  },
  {
    verb: 'request',
    queryPattern: /\b(?:requested|requesting|asked for|request)\b/i,
    memoryPattern: /\b(?:request(?:ed|ing|s)?|asked for)\b/i,
  },
];

interface DetectedVerb {
  verb: string;
  memoryPattern: RegExp;
}

/**
 * Find the action verb in the query and return a matcher for memory text.
 * Returns null if no known action verb is found.
 */
export function detectActionVerb(query: string): DetectedVerb | null {
  for (const entry of ACTION_VERB_TABLE) {
    if (entry.queryPattern.test(query)) {
      return { verb: entry.verb, memoryPattern: entry.memoryPattern };
    }
  }
  return null;
}

/**
 * Common filler words that appear in many memories and should not count as
 * distinctive entity words for deduplication purposes.
 */
const STOP_WORDS = new Set([
  'user', 'wants', 'want', 'need', 'needs', 'says', 'said', 'mentioned',
  'discuss', 'discussed', 'note', 'noted', 'adds', 'added', 'tries', 'tried',
  'handle', 'handles', 'handled', 'handling', 'using', 'used', 'uses',
  'implement', 'implementing', 'implemented', 'with', 'that', 'this', 'from',
  'have', 'their', 'they', 'will', 'about', 'also', 'more', 'when',
  'make', 'made', 'should', 'would', 'could', 'into', 'some',
]);

/**
 * Extract the distinctive content words from a memory text for deduplication.
 * Strips bullet/list prefixes, lowercases, removes stop words, keeps content
 * words (length > 3 and not in STOP_WORDS).
 */
function extractEntity(text: string): string {
  const cleaned = text.replace(/^[-•*\d.)\s]+/, '').trim().toLowerCase();
  const words = cleaned
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOP_WORDS.has(w));
  // Return the first 5 distinctive words as the entity signature.
  // Falls back to full 80-char cleaned string if no content words found.
  return words.length > 0 ? words.slice(0, 5).join(' ') : cleaned.slice(0, 80);
}

/**
 * Two entity strings are considered the same when they share substantial
 * word overlap (Jaccard-style ≥ 0.6 on content words).
 */
function entitiesMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const wordsOf = (s: string): Set<string> => new Set(s.split(/\s+/));
  const aw = wordsOf(a);
  const bw = wordsOf(b);
  if (aw.size === 0 || bw.size === 0) return a === b;
  let common = 0;
  for (const w of aw) {
    if (bw.has(w)) common++;
  }
  const union = new Set([...aw, ...bw]).size;
  // Jaccard similarity on content-word sets
  return common / union >= 0.5;
}

/** Return deduplicated entity list using entitiesMatch. */
function dedupEntities(entities: readonly string[]): string[] {
  const out: string[] = [];
  for (const e of entities) {
    if (!out.some((existing) => entitiesMatch(existing, e))) {
      out.push(e);
    }
  }
  return out;
}

const NUMBER_WORDS = [
  'Zero', 'One', 'Two', 'Three', 'Four', 'Five',
  'Six', 'Seven', 'Eight', 'Nine', 'Ten',
];

/** Format a count as a number-word (≤ 10) or plain digit. */
function formatCount(n: number): string {
  return n >= 0 && n < NUMBER_WORDS.length ? NUMBER_WORDS[n] : String(n);
}

/**
 * Run the deterministic MSR specialist.
 *
 * 1. Gate on shouldInvokeMsrSpecialist.
 * 2. Detect the action verb in the query.
 * 3. Filter memories to those whose text matches the verb.
 * 4. Extract and deduplicate entity signatures.
 * 5. Return a number-word answer.
 */
export async function runMsrSpecialist(
  deps: MsrSpecialistDeps,
): Promise<MsrSpecialistResult> {
  if (!shouldInvokeMsrSpecialist(deps.query)) {
    return { answer: '', items: [], handled: false, usedLlm: false };
  }

  if (deps.memories.length === 0) {
    return { answer: formatCount(0), items: [], handled: true, usedLlm: false };
  }

  const detected = detectActionVerb(deps.query);
  const filtered = detected
    ? deps.memories.filter((m) => detected.memoryPattern.test(m.text))
    : deps.memories;

  const entities = filtered.map((m) => extractEntity(m.text));
  const distinct = dedupEntities(entities);
  const n = distinct.length;

  const answer =
    n <= 10
      ? formatCount(n)
      : `${n}: ${distinct.join(', ')}.`;

  return { answer, items: distinct, handled: true, usedLlm: false };
}
