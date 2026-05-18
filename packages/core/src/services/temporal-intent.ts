/**
 * BEAM v38: read-time temporal intent classifier.
 *
 * Pure regex/keyword classification — no LLM call, no DB lookup.
 * Used by `memory-search.ts` to decide whether to rerank candidates
 * by `state_key` activity (CURRENT_STATE) or leave ordering alone.
 *
 * Scope: only CURRENT_STATE is "live" today — the other labels are
 * recorded for observability but produce no rerank. Keeping the surface
 * narrow avoids speculative knobs while leaving room to grow.
 */

/** Intent labels recognized at read time. */
export enum TemporalIntent {
  /**
   * "What is X now?" / "Where do I live?" — answer should reflect the
   * active state. Triggers the state_key rerank.
   */
  CURRENT_STATE = 'current_state',
  /**
   * "What was X in March?" / "What was my salary last year?" — answer
   * needs a snapshot at a past time. No rerank today; reserved.
   */
  HISTORICAL_AT_TIME = 'historical_at_time',
  /**
   * "How long have I had X?" — duration question. No rerank today.
   */
  DURATION = 'duration',
  /** Everything else — no temporal intent inferred. */
  NONE = 'none',
}

const HISTORICAL_AT_TIME_PATTERNS: RegExp[] = [
  /\bwhat was (?:my|the|his|her|their)\b/,
  /\bin (?:january|february|march|april|may|june|july|august|september|october|november|december)\b/,
  /\b(?:last|previous) (?:year|month|week|quarter)\b/,
  /\bback in\b/,
  /\bduring (?:the\s+)?\d{4}\b/,
  /\bas of\b/,
  /\bbefore (?:switching|moving|changing|leaving)\b/,
];

const DURATION_PATTERNS: RegExp[] = [
  /\bhow long (?:have|has|did|do)\b/,
  /\bfor how long\b/,
  /\b(?:since|over) the (?:past|last)\b/,
  /\bduration of\b/,
];

const CURRENT_STATE_PATTERNS: RegExp[] = [
  /\bcurrent(?:ly)?\b/,
  /\b(?:right )?now\b/,
  /\btoday\b/,
  /\bat (?:the )?(?:moment|present)\b/,
  /\bwhere do (?:i|you|we) live\b/,
  /\bwhat(?:'|\s)?s? (?:my|your|his|her|their) current\b/,
  /\bwhat (?:is|are) (?:my|your|his|her|their) (?:current|now)\b/,
  /\bwhere (?:am|are) (?:i|you|we) (?:living|working|based)\b/,
  /\b(?:as of|by) (?:today|now)\b/,
];

/**
 * Classify a query into a TemporalIntent. Order matters:
 *   - HISTORICAL and DURATION are tested first because they may share
 *     phrasing ("how long have I lived…" reads like duration even if
 *     "current" appears in the question).
 *   - CURRENT_STATE is the catch-all for active-state phrasings.
 *   - Everything else returns NONE.
 */
export function classifyTemporalIntent(query: string): TemporalIntent {
  const normalized = query.toLowerCase();
  if (DURATION_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return TemporalIntent.DURATION;
  }
  if (HISTORICAL_AT_TIME_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return TemporalIntent.HISTORICAL_AT_TIME;
  }
  if (CURRENT_STATE_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return TemporalIntent.CURRENT_STATE;
  }
  return TemporalIntent.NONE;
}
