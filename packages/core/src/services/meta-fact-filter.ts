/**
 * @file Meta-fact filter for the extraction pipeline.
 *
 * Drops extraction-style "meta-facts" — outputs that describe the
 * conversation itself ("The user asked for the user's name.", "As of
 * <date>, X is a term mentioned in the conversation.") rather than
 * recording a durable fact about the user.
 *
 * Empirically motivated by the AlignBench v0 results. When meta-facts sit in the recall
 * pool alongside durable facts, they outrank real facts at thin cosine
 * margins, producing partner-visible "I don't recall..." failures and the 31%
 * "no info" refusal rate on LongMemEval-S.
 *
 * Cleaning at extraction time means meta-facts never enter the
 * database, so every downstream search-style query (semantic, BM25,
 * package, temporal) is uniformly cleaner. The SDK ships a complementary
 * post-retrieval filter for deployments running an older
 * core release.
 *
 * This filter is intentionally:
 *   - pure (deterministic regex, no I/O, no LLM calls);
 *   - on by default (the patterns describe outputs that are never
 *     useful durable facts — there is no defensible reason to keep
 *     them);
 *   - configurable via an environment flag for emergency disable;
 *   - logged when it drops, so operators can audit extractor noise.
 */

/**
 * Minimal shape probed by the filter. Real `ExtractedFact` instances carry
 * the durable text on `.fact`; we tolerate `.statement` (the raw LLM key,
 * before normalization) too so the filter is safe to apply earlier in the
 * pipeline as well.
 */
export interface MetaFactCandidate {
  fact?: string;
  statement?: string;
}

/**
 * Extract the durable-fact text from a candidate. Prefers `.fact` (the
 * normalized post-process shape) and falls back to `.statement` (the raw
 * LLM key) so this filter is safe to apply pre- or post-normalization.
 */
function readFactText(fact: MetaFactCandidate): string {
  if (typeof fact.fact === 'string') return fact.fact;
  if (typeof fact.statement === 'string') return fact.statement;
  return '';
}

/**
 * Default regex set targeting the verbatim meta-fact shapes observed in
 * the Filecoin partner demo and in AlignBench v0's distractor pool.
 *
 *   1. "The user asked/requested/said/is asking/is me ..." — meta-facts
 *      about user actions in the conversation, not about the user.
 *   2. "As of <date>, X is a term mentioned in the conversation." —
 *      vacuous acknowledgements of vocabulary.
 *   3. "A name was mentioned." — observation about the chat session.
 *   4. "The conversation involves the user." — meta-observation.
 *   5. "The user has started a conversation." — meta-observation.
 *
 * Patterns are case-insensitive and anchored at the start so legitimate
 * sentences like "The user lives in Lisbon, where they asked their
 * landlord about renewal." are preserved.
 */
export const DEFAULT_META_FACT_PATTERNS: readonly RegExp[] = Object.freeze([
  /^\s*the user (asked|requested|said|is asking|is me)\b/i,
  /^\s*as of [^,]+,\s+.+\s+is a term mentioned in the conversation\.?$/i,
  /^\s*a name was mentioned\b/i,
  /^\s*the conversation involves the user\b/i,
  /^\s*the user has started a conversation\b/i,
]);

/**
 * Test whether a text string matches any active meta-fact pattern. Pure;
 * defensive against non-string input. Exposed for callers that already
 * have the raw text (e.g. tests, ad-hoc audits).
 */
export function isMetaFactStatement(
  text: unknown,
  patterns: readonly RegExp[] = DEFAULT_META_FACT_PATTERNS,
): boolean {
  if (typeof text !== 'string' || text.length === 0) return false;
  for (const p of patterns) {
    if (p.test(text)) return true;
  }
  return false;
}

/**
 * Default master-switch resolver. Operators can disable the filter
 * entirely with `ATOMICMEMORY_META_FACT_FILTER=off` (used for incident
 * response — never recommended for steady state). Defaults to ON.
 */
export function metaFactFilterEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.ATOMICMEMORY_META_FACT_FILTER;
  if (raw == null) return true;
  return !['off', 'false', '0', 'disabled'].includes(raw.trim().toLowerCase());
}

/**
 * Process-lifetime counters keyed by pattern index. Lets operators
 * aggregate filter activity without needing log scraping. Exposed via
 * `getMetaFactDropStats()` and reset between tests with
 * `resetMetaFactDropStats()`.
 */
const dropCounts: number[] = new Array(DEFAULT_META_FACT_PATTERNS.length).fill(0);
let dropTotal = 0;

export interface MetaFactDropStats {
  total: number;
  byPattern: ReadonlyArray<number>;
}

export function getMetaFactDropStats(): MetaFactDropStats {
  return { total: dropTotal, byPattern: [...dropCounts] };
}

export function resetMetaFactDropStats(): void {
  for (let i = 0; i < dropCounts.length; i++) dropCounts[i] = 0;
  dropTotal = 0;
}

/**
 * Emit a structured, grep-friendly drop event. Format:
 *
 *   [meta-fact-filter] dropped pattern=2 len=47 source=extract
 *
 * Use `source` to disambiguate runtime extraction drops from migration
 * runs (cleanup-meta-facts.ts emits its own audit JSONL — this log line
 * is for the live pipeline).
 */
function recordDrop(
  patternIndex: number,
  statementLength: number,
  source: string,
): void {
  if (patternIndex >= 0 && patternIndex < dropCounts.length) {
    dropCounts[patternIndex] += 1;
  }
  dropTotal += 1;
  // Single-line log, no PII (no statement text). Operators correlate by
  // conversation_id at the call site, not here.
  console.info(
    `[meta-fact-filter] dropped pattern=${patternIndex} len=${statementLength} source=${source}`,
  );
}

export interface FilterMetaFactsOptions {
  /** Override the default regex set. */
  patterns?: readonly RegExp[];
  /** Force-enable / disable, bypassing `metaFactFilterEnabled`. */
  enabled?: boolean;
  /**
   * Telemetry hook fired once per dropped fact. Receives the statement
   * and the pattern index that matched. Exceptions are swallowed so
   * telemetry can never break extraction.
   *
   * When `null` is passed, telemetry is fully suppressed (useful for
   * tests). When `undefined` (the default), the structured drop logger
   * fires automatically via `source` below.
   */
  onDrop?: ((statement: string, patternIndex: number) => void) | null;
  /**
   * Tag identifying the call site for the structured drop log line
   * (`extract`, `migration`, `test`, etc.). Ignored when `onDrop` is
   * supplied explicitly. Defaults to `'extract'` to match the most
   * common call site.
   */
  source?: string;
}

/**
 * Return the index of the first pattern that matches `text`, or -1 if
 * none match or `text` is empty. Pulled out of `filterMetaFacts` so the
 * loop body stays simple.
 */
function findMetaFactPatternIndex(
  text: string,
  patterns: readonly RegExp[],
): number {
  if (text.length === 0) return -1;
  for (let i = 0; i < patterns.length; i++) {
    if (patterns[i].test(text)) return i;
  }
  return -1;
}

/**
 * Invoke a drop hook safely, then always update process counters /
 * structured log unless the caller explicitly opted out by passing
 * `onDrop: null`. The default path (no `onDrop` supplied) records via
 * `recordDrop` keyed on the caller's `source` tag.
 */
function safeOnDrop(
  onDrop: FilterMetaFactsOptions['onDrop'],
  text: string,
  patternIndex: number,
  source: string,
): void {
  // Explicit opt-out: don't touch counters or log.
  if (onDrop === null) return;
  if (onDrop) {
    try {
      onDrop(text, patternIndex);
    } catch {
      // Intentional: telemetry must never break extraction.
    }
    return;
  }
  // Default path: structured log + counter update.
  recordDrop(patternIndex, text.length, source);
}

/**
 * Drop meta-facts from an extracted-fact array. Returns a new array;
 * does not mutate the input. When the filter is disabled (env flag or
 * `enabled: false`), returns a shallow copy of the input unchanged.
 *
 * Generic over `T` so callers can pass `ExtractedFact[]`, raw LLM
 * output, or any other shape that exposes `.fact` or `.statement`.
 */
export function filterMetaFacts<T extends MetaFactCandidate>(
  facts: readonly T[],
  options: FilterMetaFactsOptions = {},
): T[] {
  const enabled = options.enabled ?? metaFactFilterEnabled();
  if (!enabled) return [...facts];
  const patterns = options.patterns ?? DEFAULT_META_FACT_PATTERNS;
  if (patterns.length === 0) return [...facts];

  const source = options.source ?? 'extract';
  const kept: T[] = [];
  for (const fact of facts) {
    const text = readFactText(fact);
    const matchedIndex = findMetaFactPatternIndex(text, patterns);
    if (matchedIndex >= 0) {
      safeOnDrop(options.onDrop, text, matchedIndex, source);
      continue;
    }
    kept.push(fact);
  }
  return kept;
}
