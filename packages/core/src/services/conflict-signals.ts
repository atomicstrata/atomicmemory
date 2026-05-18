/**
 * Text-pattern signal detectors shared by the AUDN conflict-policy pipeline.
 *
 * Pure-function module: every export takes plain strings and returns a
 * primitive. No `CandidateMemory` or `AUDNDecision` types live here — those
 * keep their AUDN-domain coupling in `conflict-policy.ts`. Extracted so
 * `conflict-policy.ts` stays under the repo's 400-LOC ceiling and so these
 * text patterns can be exercised independently of the policy pipeline.
 *
 * Marker arrays are intentionally module-private: they are tuning data for
 * the predicates exported below, not part of the public surface. Callers
 * that need a yes/no answer call the predicate; nobody downstream needs to
 * read the literal vocabulary.
 */

/** Hedging words that mark the new fact as not-confident. */
const UNCERTAIN_MARKERS: readonly string[] = [
  'maybe', 'might', 'not sure', 'i think', 'perhaps', 'tomorrow',
];

/** Phrases that signal the speaker plans to verify later rather than assert. */
const UNCERTAIN_PATTERNS: readonly RegExp[] = [
  /\b(?:need|needs|needed|will|should)\s+to\s+check\b/i,
  /\bcheck\s+(?:later|tomorrow|again|back)\b/i,
];

/**
 * Words that match too broadly to be useful as "shared keyword" evidence —
 * filtered out of `extractConflictKeywords` so e.g. the month "march"
 * doesn't cause two unrelated date sentences to look related.
 */
const GENERIC_CONFLICT_MARKERS: readonly string[] = [
  'user', 'users',
  'january', 'february', 'march', 'april', 'june', 'july',
  'august', 'september', 'october', 'november', 'december',
];

/** Safety-critical phrases in the *candidate* memory that demand clarification. */
const SAFETY_RISK_MARKERS: readonly string[] = [
  'allergic', 'life-threatening', 'anaphyl', 'avoid', 'cannot eat', "can't eat", 'severe',
];

/** Phrases in the *new fact* that would clear / contradict a safety-critical memory. */
const SAFETY_CLEARANCE_MARKERS: readonly string[] = [
  'ate', 'eat', 'eating', 'cookie', 'meal', 'dish', 'okay', 'fine', 'safe',
];

/** Phrases that turn an UPDATE into a historical-transition ADD rather than overwrite. */
const TRANSITION_MARKERS: readonly string[] = [
  'switched away from', 'switched from', 'migrated from', 'moved from', 'previously used',
];

/** Patterns that mean "this fact is an explicit correction of an older memory". */
const EXPLICIT_REPLACEMENT_PATTERNS: readonly RegExp[] = [
  /\breplac(?:e|ed|ing)\b/i,
  /\bno longer\b/i,
  /\binstead of\b/i,
  /\bcorrect(?:ed|ion)\b/i,
];

const CONFLICT_KEYWORD_REGEX = /[a-z]{4,}/g;

/** True when any of `markers` appears (case-insensitively) inside `text`. */
function containsAny(text: string, markers: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return markers.some((marker) => lower.includes(marker));
}

/**
 * Extract conflict-comparison keywords from text: lowercase ≥4-char words,
 * deduplicated, minus the uncertain/generic noise. Used by both keyword-
 * overlap heuristics and the negation pattern in `containsContradictionSignal`.
 */
export function extractConflictKeywords(text: string): string[] {
  const words = text.toLowerCase().match(CONFLICT_KEYWORD_REGEX) ?? [];
  const filtered = words.filter(
    (word) => !UNCERTAIN_MARKERS.includes(word) && !GENERIC_CONFLICT_MARKERS.includes(word),
  );
  return [...new Set(filtered)];
}

/** True when `left` and `right` share at least one conflict keyword. */
export function hasSharedKeyword(left: string, right: string): boolean {
  const leftWords = new Set(extractConflictKeywords(left));
  return extractConflictKeywords(right).some((word) => leftWords.has(word));
}

/** True when the new fact carries an explicit correction marker. */
export function containsExplicitReplacementSignal(factText: string): boolean {
  return EXPLICIT_REPLACEMENT_PATTERNS.some((pattern) => pattern.test(factText));
}

/**
 * True when the new fact either explicitly says it's a replacement, or
 * negates one of the candidate's distinguishing keywords (e.g., candidate
 * says "user uses MongoDB" and fact says "no longer MongoDB").
 */
export function containsContradictionSignal(factText: string, candidateText: string): boolean {
  if (containsExplicitReplacementSignal(factText)) return true;
  return extractConflictKeywords(candidateText).some((keyword) => {
    const negated = new RegExp(`(not|no longer|stopped|quit|don'?t)\\s+\\w*\\s*${keyword}`, 'i');
    return negated.test(factText);
  });
}

/**
 * Safety check: candidate carries a risk marker (allergy, anaphylaxis, …)
 * AND the new fact carries a clearance marker (ate, fine, …). Treat as a
 * critical conflict that needs explicit clarification before resolving.
 */
export function hasSafetyConflictSignal(factText: string, candidateText: string): boolean {
  return containsAny(candidateText, SAFETY_RISK_MARKERS)
    && containsAny(factText, SAFETY_CLEARANCE_MARKERS);
}

/** True when the new fact uses transition-narrative language. */
export function isStateTransitionFact(text: string): boolean {
  return containsAny(text, TRANSITION_MARKERS);
}

/**
 * True when `text` contains hedging vocabulary or "I'll check later" phrasing.
 * Pure text predicate; the caller decides what to do with it (`isUncertainConflict`
 * in `conflict-policy.ts` additionally requires at least one candidate to be
 * present before treating it as an uncertain conflict).
 */
export function hasUncertainLanguage(text: string): boolean {
  if (containsAny(text, UNCERTAIN_MARKERS)) return true;
  return UNCERTAIN_PATTERNS.some((pattern) => pattern.test(text));
}
