/**
 * @file MetaFactFilter
 *
 * Post-retrieval filter that drops "meta-facts" — extraction artifacts that
 * describe the conversation itself rather than recording a durable fact about
 * the user.
 *
 * Empirically motivated by AlignBench v0 (benchmarks/alignbench/RESULTS.md):
 * when extraction-style meta-facts ("The user asked for the user's name.",
 * "As of <date>, X is a term mentioned in the conversation.") sit in the
 * recall pool alongside real user facts, they often outrank the real fact
 * for pronoun and temporal queries — at thin cosine margins (~0.05). The
 * pre-registered "fix the query side" hypothesis was falsified; the dominant
 * fixable lift came from removing meta-facts from the pool.
 *
 * Long-term, core should not emit these facts at extraction time. This
 * SDK-side filter is the safety net so apps consuming the SDK today see
 * cleaner recall results without waiting on a core release.
 *
 * Default patterns target the verbatim shapes observed in partner demos.
 * Apps can extend or replace them via
 * `MetaFactFilterConfig.patterns`.
 *
 * This filter is intentionally:
 *   - pure (no I/O, no LLM calls — deterministic regex application);
 *   - opt-in (off unless explicitly enabled in provider config);
 *   - case-insensitive;
 *   - additive (apps may add patterns without losing the defaults).
 */

/**
 * Built-in patterns observed in real partner demos. Each is a case-insensitive
 * regex matched against the memory's content. A match drops the memory from
 * the result set.
 *
 * Patterns capture the three meta-fact families that AlignBench's distractor
 * pool was built from:
 *   1. "The user asked/requested/said …" — meta-facts about user actions in
 *      the conversation, not about the user.
 *   2. "As of <date>, X is a term mentioned in the conversation." — vacuous
 *      acknowledgements of vocabulary, not durable facts.
 *   3. "A name was mentioned." / "The conversation involves the user." —
 *      observations about the chat session, not about the user.
 */
export const DEFAULT_META_FACT_PATTERNS: readonly RegExp[] = Object.freeze([
  /^\s*the user (asked|requested|said|is asking|is me)\b/i,
  /^\s*as of [^,]+,\s+.+\s+is a term mentioned in the conversation\.?$/i,
  /^\s*a name was mentioned\b/i,
  /^\s*the conversation involves the user\b/i,
  /^\s*the user has started a conversation\b/i,
]);

export interface MetaFactFilterConfig {
  /**
   * Master switch. When `false` (the default), the filter is a no-op and
   * all results pass through.
   *
   * Apps explicitly opt in by setting `true`. We do not infer this from
   * environment variables in the SDK to keep behaviour deterministic across
   * Node / browser / Workers runtimes.
   */
  enabled: boolean;

  /**
   * Patterns to match against `memory.content`. When omitted, the built-in
   * `DEFAULT_META_FACT_PATTERNS` are used.
   *
   * When `mode === 'replace'` (the default when `patterns` is set), only the
   * provided patterns are applied. Set `mode: 'extend'` to apply the provided
   * patterns *and* the built-in defaults.
   */
  patterns?: readonly RegExp[];

  /**
   * How `patterns` interacts with `DEFAULT_META_FACT_PATTERNS`. Defaults to
   * `'replace'` (the provided list fully replaces defaults). `'extend'` is
   * the union — useful when an app wants to add its own meta-fact shapes
   * without losing the SDK's baseline coverage.
   */
  mode?: 'replace' | 'extend';

  /**
   * Optional callback invoked once per dropped result. Useful for telemetry
   * or tests. Receives the memory content and the pattern index that matched.
   * Exceptions thrown by `onDrop` are swallowed so they cannot break recall.
   */
  onDrop?: (content: string, patternIndex: number) => void;
}

/**
 * Resolve the effective pattern list for a config.
 *
 * Pure; safe to call repeatedly. Used in two places — at filter time, and
 * in tests that want to introspect the effective rule set without filtering
 * a result list.
 */
export function resolveMetaFactPatterns(
  config: MetaFactFilterConfig,
): readonly RegExp[] {
  if (!config.patterns) return DEFAULT_META_FACT_PATTERNS;
  if (config.mode === 'extend') {
    return [...config.patterns, ...DEFAULT_META_FACT_PATTERNS];
  }
  return config.patterns;
}

/**
 * Return `true` when `content` matches any of `patterns`.
 *
 * Defensive against non-string input (returns `false`) so a malformed result
 * doesn't crash the filter pipeline.
 */
export function isMetaFact(
  content: unknown,
  patterns: readonly RegExp[] = DEFAULT_META_FACT_PATTERNS,
): boolean {
  if (typeof content !== 'string' || content.length === 0) return false;
  for (const p of patterns) {
    if (p.test(content)) return true;
  }
  return false;
}

/**
 * Filter a list of items by removing entries whose `getContent(item)` matches
 * any active meta-fact pattern.
 *
 * Generic over `T` so callers can filter `SearchResult` / `Memory` / raw
 * backend shapes with the same primitive. Pure and synchronous.
 */
export function filterMetaFacts<T>(
  items: readonly T[],
  getContent: (item: T) => unknown,
  config: MetaFactFilterConfig,
): T[] {
  if (!config.enabled) return [...items];
  const patterns = resolveMetaFactPatterns(config);
  if (patterns.length === 0) return [...items];
  const kept: T[] = [];
  for (const item of items) {
    const content = getContent(item);
    let matchedIndex = -1;
    if (typeof content === 'string' && content.length > 0) {
      for (let i = 0; i < patterns.length; i++) {
        if (patterns[i].test(content)) {
          matchedIndex = i;
          break;
        }
      }
    }
    if (matchedIndex >= 0) {
      if (config.onDrop) {
        try {
          config.onDrop(content as string, matchedIndex);
        } catch {
          // Swallow — filter must never break recall.
        }
      }
      continue;
    }
    kept.push(item);
  }
  return kept;
}
