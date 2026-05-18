/**
 * Shared query keyword matching utilities for retrieval-time reranking.
 */

const IRREGULAR_KEYWORD_NORMALIZATION: Record<string, string> = {
  won: 'win',
  winning: 'win',
  met: 'meet',
  meeting: 'meet',
  began: 'begin',
  begun: 'begin',
  started: 'start',
  starting: 'start',
  moved: 'move',
  moving: 'move',
  dated: 'date',
  dating: 'date',
  adopted: 'adopt',
  adopting: 'adopt',
  adoption: 'adopt',
  expanded: 'expand',
  expanding: 'expand',
};
const KEYWORD_STEM_SUFFIXES = ['ing', 'ed', 'es', 's'];

/** Collapse light verb-form differences so event matching is less brittle. */
export function normalizeKeywordToken(token: string): string {
  const irregular = IRREGULAR_KEYWORD_NORMALIZATION[token];
  if (irregular) return irregular;
  for (const suffix of KEYWORD_STEM_SUFFIXES) {
    if (token.length > suffix.length + 2 && token.endsWith(suffix)) {
      return token.slice(0, -suffix.length);
    }
  }
  return token;
}

/** Normalize free text into a whitespace-joined token string. */
function normalizeKeywordText(text: string): string {
  return text
    .toLowerCase()
    .replace(/\b([a-z]+)'s\b/g, '$1')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map(normalizeKeywordToken)
    .join(' ');
}

export function countKeywordMatches(content: string, keywords: string[]): number {
  const normalizedContent = normalizeKeywordText(content);
  const contentTokens = new Set(normalizedContent.split(/\s+/).filter(Boolean));
  const normalizedKeywords = [...new Set(
    keywords
      .map(normalizeKeywordText)
      .filter(Boolean),
  )];

  return normalizedKeywords.filter((keyword) => (
    keyword.includes(' ')
      ? normalizedContent.includes(keyword)
      : contentTokens.has(keyword)
  )).length;
}
