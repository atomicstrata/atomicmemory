/**
 * MSR (Multi-Session Reasoning) query detector — pure regex, no LLM.
 *
 * Distinct from the Phase 2 deterministic specialist in
 * `services/specialists/msr-specialist.ts`. That module is an ANSWER-side
 * specialist: it short-circuits the answer LLM and emits a number-word.
 *
 * THIS module is a RETRIEVAL-side classifier: when true, the caller (see
 * `memory-search.ts`) inserts a cross-conversation aggregation channel into
 * the injection text BEFORE the answer LLM sees the retrieved chunks.
 *
 * MSR queries explicitly span multiple conversations or sessions, e.g.
 * "across my conversations", "different X I mentioned", "throughout all my
 * chats". Single-conversation queries (KU, IE, SUM, CR) return false.
 *
 * v39-multihop diagnostic on v26 MSR failures showed gold facts WERE in the
 * top-K but spread across 2-4 conversations; the answer LLM could not
 * synthesize across them and gave inflated or noisy counts.
 */

/**
 * MSR trigger patterns. Each pattern targets a phrase that explicitly signals
 * cross-conversation aggregation. Patterns are tested case-insensitively and
 * combined via OR — any match returns true.
 */
const MSR_PATTERNS: readonly RegExp[] = [
  // "across my conversations / sessions / chats / weather app conversations"
  /\bacross (?:my |all (?:my )?)?(?:conversations?|sessions?|chats?)\b/i,
  /\bacross (?:my |all (?:my )?)?\w+(?:\s+\w+)?\s+(?:conversations?|sessions?|chats?)\b/i,
  // "throughout all my conversations / chats"
  /\bthroughout (?:all )?(?:my )?(?:conversations?|sessions?|chats?)\b/i,
  // "different X I mentioned / talked about / discussed"
  /\bdifferent\b[^?.]*\b(?:mentioned|talked|discussed|brought up|wanted|tried)\b/i,
  // "how many X did I talk about / discuss / mention"
  /\bhow many\b[^?.]*\b(?:talked|discussed|mentioned|chatted|wrote)\b/i,
  // "what (different) topics / features / concerns have I (ever) X across"
  /\b(?:what|which)\b[^?.]*\bacross (?:my |all (?:my )?)?(?:conversations?|sessions?|chats?)\b/i,
  // "across (my|all (my)?) sessions" with possessive forms
  /\bacross\s+all\s+(?:my\s+)?(?:conversations?|sessions?|chats?)\b/i,
  // "in (any of|all of) my conversations / chats"
  /\bin (?:any|all) of (?:my )?(?:conversations?|sessions?|chats?)\b/i,
];

/**
 * Returns true iff the query explicitly references cross-conversation /
 * cross-session aggregation. Pure regex, deterministic, no side effects.
 *
 * Examples that return true:
 *   - "How many different user roles ... across my sessions?"
 *   - "How many different features ... across my weather app conversations?"
 *   - "What different topics have I discussed across all my chats?"
 *
 * Examples that return false:
 *   - "What's the latest version of my dashboard?" (KU)
 *   - "When does my first sprint end?" (IE)
 *   - "Summarize my budget tracker project" (SUM)
 *   - "Have I ever worked on Flask routes?" (CR — single-conversation lookup)
 */
export function isMsrQuery(query: string): boolean {
  if (!query || query.length === 0) return false;
  for (const pattern of MSR_PATTERNS) {
    if (pattern.test(query)) return true;
  }
  return false;
}
