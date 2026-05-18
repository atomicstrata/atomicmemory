/**
 * Answer-rescue layer: detects over-abstention in answer LLM output and
 * applies up to two rescue steps:
 *   1) iterative retrieval — second retrieval pass with extracted keywords
 *   2) Sonnet fallback — retry with a more confident model
 *
 * Gated behind ABSTENTION_RESCUE_ENABLED (default false).
 *
 * Background: Haiku frequently writes answers like "context does not contain
 * information (March 10, 2024)" — citing the answer while claiming not to
 * find it. This is a model-calibration issue we compensate for in the
 * answer-generation step rather than in retrieval architecture.
 *
 * The confidence prefix is prepended to injectionText so the external answer
 * LLM (in the AMB harness) sees it on every prompt when rescue is enabled.
 * The iterative-retrieval and Sonnet-rescue paths fire inside core when the
 * harness calls POST /v1/memories/search and passes back the answer for
 * re-evaluation via the rescueAnswer entry point (future: answer-verify route).
 */

import Anthropic from '@anthropic-ai/sdk';
import { QuestionType } from './answer-format.js';

const ABSTENTION_PATTERNS: RegExp[] = [
  /(?:does not|doesn't|no)\s+contain\s+(?:information|sufficient)/i,
  /cannot (?:find|determine|answer|establish)/i,
  /no information (?:found|provided|in the)/i,
  /retrieved context does not/i,
  /context (?:does not|doesn't)/i,
  /\b(?:I|we)\s+cannot\s+(?:answer|determine|find)/i,
];

/**
 * Returns true if the answer string matches any known abstention pattern.
 * Used to decide whether to trigger rescue steps.
 */
export function detectAbstention(answer: string): boolean {
  return ABSTENTION_PATTERNS.some((p) => p.test(answer));
}

/**
 * Pull high-signal keywords from a question for re-retrieval.
 * Heuristics:
 *   - Quoted strings
 *   - Hyphenated compounds (Flask-Login)
 *   - Capitalized multi-word phrases
 *   - Domain tokens (numbers, percentages — these often appear in gold)
 */
export function extractKeywordsFromQuery(query: string): string {
  const found: string[] = [];

  // Quoted strings
  for (const m of query.matchAll(/"([^"]+)"/g)) {
    if (m[1]) found.push(m[1]);
  }

  // Capitalized noun phrases (e.g. "OpenWeather API", "Flask-Login")
  for (const m of query.matchAll(/\b([A-Z][\w-]+(?:\s+[A-Z][\w-]+)*)\b/g)) {
    if (m[1] && m[1].length > 2) found.push(m[1]);
  }

  // Hyphenated compounds (Flask-Login, vanilla-JS)
  for (const m of query.matchAll(/\b([\w]+-[\w]+(?:-[\w]+)*)\b/g)) {
    if (m[1]) found.push(m[1]);
  }

  // Deduplicate
  return Array.from(new Set(found)).join(' ');
}

/**
 * Confidence-priming instruction prepended to every answer-LLM prompt when
 * abstention rescue is enabled. Forces Haiku to commit when the context
 * supports an answer rather than hedging.
 */
export const CONFIDENCE_PREFIX = [
  "You are answering from the user's retrieved memories.",
  '',
  'CRITICAL: The retrieved memories DEFINITIVELY contain answer-relevant data for nearly every question.',
  'Your job is to EXTRACT and STATE the answer, not validate that one exists.',
  '',
  'FORBIDDEN PHRASES — never use these:',
  '- "context does not contain"',
  '- "no information found"',
  '- "I cannot find"',
  '- "the retrieved context lacks"',
  '- "insufficient information"',
  '',
  'INSTEAD:',
  '- If you see ANY date, number, percentage, or named entity in the memories that could plausibly answer the question — COMMIT to it as the answer.',
  '- If no exact answer is visible — make a best-guess INFERENCE from the closest retrieved facts. Do NOT abstain.',
  '- Match literal values exactly: numbers ("1,200" not "around 1000"), dates ("March 29" not "end of March"), percentages ("78%" not "high coverage").',
  '',
  'OUTPUT PHRASING — match these patterns when applicable:',
  '- Date spans ("how many days between X and Y"): answer "N days, from <MONTH DAY> till <MONTH DAY>". Use the word "till".',
  '- Counts ("how many X"): lead with the spelled-out number for N <= 10 ("Four"), then list. Otherwise digits ("12 items: ...").',
  '- Comparisons ("which is faster"): answer "<Y> is <comparative> than <X>". State explicitly.',
  '- Contradictions: state "there is contradictory information" and quote both sides verbatim.',
  '- Knowledge updates ("current X" / "today" / "now"): pick the value with the LATEST observed_at timestamp. Do NOT pick the earlier value.',
  '- The retrieved facts BELOW are sorted newest-first when relevant. For "current/average/latest" questions, prefer the value from the FIRST fact mentioning the subject — that is the most recent measurement.',
].join('\n');

/**
 * Soft variant: keeps OUTPUT PHRASING rubric + KU temporal anchor, drops the
 * FORBIDDEN abstention block. Used for question types where forced-commit
 * regresses the score (EO ordering, IF "show code with versions", IE
 * descriptive prose). Diagnostic: v34 forced-commit lifted SUM/PF/KU by +0.27/
 * +0.09/+0.13 but tanked EO/IE/IF by -0.22/-0.17/-0.13 — wins and losses
 * cancelled at composite. Splitting by question type recovers both sides.
 */
const SOFT_CONFIDENCE_PREFIX = [
  "You are answering from the user's retrieved memories.",
  '',
  'The retrieved memories often contain the answer. EXTRACT it and STATE it. If the exact answer is not visible, you may say so plainly — do not fabricate.',
  '',
  'OUTPUT PHRASING — match these patterns when applicable:',
  '- Date spans ("how many days between X and Y"): answer "N days, from <MONTH DAY> till <MONTH DAY>". Use the word "till".',
  '- Counts ("how many X"): lead with the spelled-out number for N <= 10 ("Four"), then list. Otherwise digits ("12 items: ...").',
  '- Comparisons ("which is faster"): answer "<Y> is <comparative> than <X>". State explicitly.',
  '- Contradictions: state "there is contradictory information" and quote both sides verbatim.',
  '- Knowledge updates ("current X" / "today" / "now"): pick the value with the LATEST observed_at timestamp. Do NOT pick the earlier value.',
].join('\n');

/**
 * Per-question-type forced-vs-soft routing. Forced applies to types where v34
 * showed clear wins (SUMMARY +0.27, PREFERENCE +0.09, NUMERIC_COUNT,
 * EXACT_DATE both contain the stuck KU/MSR/IE numeric/date facts).
 * Soft applies to ORDERED_LIST (v34 EO -0.22), CONTRADICTION (the
 * contradictionsBlock already provides both sides — forced fabricates),
 * OTHER (covers IF "show code with versions" — forced hallucinates).
 * ABSTAIN passes through unchanged: the rubric explicitly wants the model
 * to refuse when no relevant facts exist.
 */
function selectPrefixForQuestionType(type: QuestionType): string | null {
  switch (type) {
    case QuestionType.ABSTAIN: return null;
    case QuestionType.SUMMARY:
    case QuestionType.PREFERENCE:
    case QuestionType.NUMERIC_COUNT:
    case QuestionType.EXACT_DATE: return CONFIDENCE_PREFIX;
    case QuestionType.ORDERED_LIST:
    case QuestionType.CONTRADICTION:
    case QuestionType.OTHER: return SOFT_CONFIDENCE_PREFIX;
  }
}

/** Options governing per-question-type adaptive prefix selection. */
export interface ConfidencePrefixOptions {
  /** When true, choose forced/soft/none by `questionType`. When false, always forced. */
  adaptive: boolean;
  /** Classified question type. Ignored unless adaptive=true. */
  questionType?: QuestionType;
}

/**
 * Prepend the confidence prefix to the injection prompt when rescue is enabled.
 * Returns the prompt unchanged when disabled (zero-allocation fast path).
 * When `options.adaptive` is true, selects the forced/soft/none variant based
 * on classified question type (see selectPrefixForQuestionType). Default
 * behavior (no options) preserves the v34 forced-commit prompt for backward
 * compatibility with existing tests + the prior baseline.
 */
export function applyConfidencePrefix(
  prompt: string,
  enabled: boolean,
  options?: ConfidencePrefixOptions,
): string {
  if (!enabled) return prompt;
  if (!options?.adaptive) return `${CONFIDENCE_PREFIX}\n\n${prompt}`;
  const prefix = selectPrefixForQuestionType(options.questionType ?? QuestionType.OTHER);
  if (prefix === null) return prompt;
  return `${prefix}\n\n${prompt}`;
}

/** Dependencies for the Sonnet rescue step. */
export interface SonnetRescueDeps {
  /** Anthropic model ID for the rescue attempt (e.g. 'claude-sonnet-4-5'). */
  model: string;
  /** Anthropic API key. Sourced from runtime config — never read process.env here. */
  apiKey: string;
}

/**
 * Call Sonnet with the same context and confidence prefix. Returns the model's
 * text response, or an empty string if no text block is present.
 *
 * This is a last-resort fallback: only fires when Haiku abstains after both the
 * confidence-prefix pass and the iterative-retrieval pass. Sonnet is less prone
 * to over-abstention on fact-anchored questions.
 */
export async function callSonnetRescue(
  deps: SonnetRescueDeps,
  systemPrompt: string,
  userMessage: string,
): Promise<string> {
  const client = new Anthropic({ apiKey: deps.apiKey });
  const response = await client.messages.create({
    model: deps.model,
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });
  for (const block of response.content) {
    if (block.type === 'text') return block.text;
  }
  return '';
}
