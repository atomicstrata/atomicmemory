/**
 * Keyword derivation for compact extraction backfill.
 * Uses Unicode letter/number classes so international facts retain retrievable terms.
 */

const KEYWORDS_MAX = 8;
const CONTENT_WORD_MIN_LENGTH_ASCII = 4;
const CONTENT_WORD_MIN_LENGTH_UNICODE = 2;

const KEYWORD_STOPWORDS = new Set([
  'user', 'users', 'assistant', 'the', 'a', 'an', 'this', 'that', 'it', 'they',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'has', 'have', 'had',
  'does', 'did', 'do', 'will', 'would', 'can', 'could', 'should', 'may', 'might',
  'and', 'or', 'but', 'for', 'with', 'from', 'into', 'about', 'over', 'under',
  'of', 'in', 'on', 'at', 'to', 'as', 'by', 'not', 'no', 'than', 'then', 'also',
  'instead', 'earlier', 'now', 'still', 'always', 'never', 'their', 'there',
  'which', 'when', 'where', 'while', 'because', 'these', 'those', 'some', 'any',
  'all', 'both', 'each', 'more', 'most', 'other', 'such', 'only', 'very',
  'lives', 'live', 'vive', 'usuario',
  'el', 'la', 'los', 'las', 'en', 'de',
]);

/** Title-case or all-caps word runs, including accented Latin (Zürich, São Paulo). */
const PROPER_NOUN_RUN = /\b[\p{Lu}][\p{L}\p{M}'’-]*(?:\s+[\p{Lu}][\p{L}\p{M}'’-]*)*/gu;
/** Mixed-case technical tokens: PostgreSQL, Qwen3, GPT-4. */
const TECHNICAL_TOKEN = /\b(?=[\p{L}\p{N}_-]*[\p{Lu}])(?=[\p{L}\p{N}_-]*[\p{Ll}\p{N}])[\p{L}\p{N}_-]+\b|\b[\p{Ll}]+\d[\p{L}\p{N}_-]*/gu;
const DATE_LIKE =
  /\b(?:\d{4}-\d{2}-\d{2}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s*\d{4}?|\b(?:19|20)\d{2})\b/g;

interface KeywordAccumulator {
  seen: Set<string>;
  terms: string[];
}

function normalizeKeywordTerm(raw: string): string {
  return raw.trim().replace(/[.,;:]+$/, '').replace(/['’]s$/iu, '');
}

function addKeyword(acc: KeywordAccumulator, raw: string): void {
  const term = normalizeKeywordTerm(raw);
  if (term.length < 2) return;
  const key = term.toLowerCase();
  if (KEYWORD_STOPWORDS.has(key) || acc.seen.has(key)) return;
  if (acc.terms.some((existing) => existing.toLowerCase().includes(key))) return;
  acc.seen.add(key);
  acc.terms.push(term);
}

function trimLeadingStopwords(run: string[]): string[] {
  let start = 0;
  while (start < run.length - 1 && KEYWORD_STOPWORDS.has(run[start].toLowerCase())) start += 1;
  return run.slice(start);
}

function collectPatternKeywords(fact: string, acc: KeywordAccumulator): void {
  for (const pattern of [DATE_LIKE, PROPER_NOUN_RUN, TECHNICAL_TOKEN]) {
    for (const match of fact.matchAll(pattern)) {
      addKeyword(acc, trimLeadingStopwords(match[0].split(/\s+/)).join(' '));
      if (acc.terms.length >= KEYWORDS_MAX) return;
    }
  }
}

function isMostlyAscii(text: string): boolean {
  return !/[^\x00-\x7F]/.test(text);
}

function contentWordMinLength(word: string): number {
  return isMostlyAscii(word) ? CONTENT_WORD_MIN_LENGTH_ASCII : CONTENT_WORD_MIN_LENGTH_UNICODE;
}

function collectContentWordKeywords(fact: string, acc: KeywordAccumulator): void {
  for (const word of fact.split(/[^\p{L}\p{N}'’-]+/u)) {
    if (word.length >= contentWordMinLength(word)) addKeyword(acc, word);
    if (acc.terms.length >= KEYWORDS_MAX) return;
  }
}

const MIN_PATTERN_KEYWORDS = 2;

/** Derive keyword-search terms from fact text when the model omits them. */
export function deriveKeywordsFromFact(fact: string): string[] {
  if (!fact.trim()) return [];
  const acc: KeywordAccumulator = { seen: new Set(), terms: [] };
  collectPatternKeywords(fact, acc);
  if (acc.terms.length < MIN_PATTERN_KEYWORDS) collectContentWordKeywords(fact, acc);
  return acc.terms;
}

/** Keep trimmed non-empty strings from a model-provided keyword array. */
export function sanitizeKeywords(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
