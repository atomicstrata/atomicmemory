/**
 * Shared context-packaging constants, default tokenizer, and the untrusted-content
 * fence required by README:128.
 *
 * These are shared between SnapshotLLMWikiProvider and LiveLLMWikiProvider so
 * there is exactly ONE source of truth for the constants and fencing logic.
 * Duplication would mean divergent fence tags, making the downstream LLM's
 * structural prompting unreliable.
 */

/**
 * Approximate characters per token for English prose. 4 is a commonly used
 * heuristic — accurate for plain English, wrong for code/CJK/dense markup.
 * Callers needing precision should supply a real tokenizer.
 */
// fallow-ignore-next-line unused-export
export const CHARS_PER_TOKEN = 4;

/**
 * Default token budget applied by package() when the caller omits tokenBudget.
 * 32K matches the smaller end of modern LLM context windows.
 */
export const DEFAULT_TOKEN_BUDGET = 32_000;

/**
 * Default tokenizer: rough chars-per-token estimate. Suitable as a fallback
 * when no tiktoken/gpt-tokenizer is wired in.
 */
export const defaultTokenize = (text: string): number =>
  Math.ceil(text.length / CHARS_PER_TOKEN);

const FENCE_TAG = "untrusted-llmwiki-source";

/**
 * Wrap an untrusted source body in an explicit fence the consuming LLM can act on.
 *
 * The `id` is a path-safe external id (format: `llmwiki-source/<projectId>/<encodeURIComponent(filename)>`
 * or `llmwiki/<projectId>/<pageDir>/<slug>`). These ids contain only URL-safe characters,
 * so no `"` can appear in the id attribute — no additional escaping is needed.
 *
 * The body is neutralized against fence-break injection: any close-tag variant matching
 * `</ untrusted-llmwiki-source >` (case-insensitive, optional surrounding whitespace) is
 * defanged with a zero-width space inside the slash. This covers the exact-lowercase form
 * as well as UPPERCASE and whitespace-padded variants that could otherwise break the fence.
 *
 * **Security scope:** this defanging is a string-level best-effort defence. It is NOT a
 * parser-enforced boundary. A sufficiently clever prompt-injection (e.g. prose that instructs
 * the model to "ignore the fence above") cannot be prevented by string manipulation alone.
 * Consumers should pair this fence with explicit system-prompt instructions that tell the
 * model to treat `<untrusted-llmwiki-source>` content as untrusted. For higher assurance,
 * consider nonce-delimited fences that are unknown to the attacker at injection time.
 */
export function fenceUntrustedSource(id: string, body: string): string {
  // Insert a zero-width space (U+200B) after `</` to break any close-tag variant.
  // The regex matches case-insensitive and optional whitespace around the tag name so
  // UPPERCASE and whitespace-padded variants are also defanged.
  const closeTagRe = /<\/(\s*untrusted-llmwiki-source\s*)>/gi;
  const safeBody = body.replace(closeTagRe, `<​/$1>`);
  return `<${FENCE_TAG} id="${id}">\n${safeBody}\n</${FENCE_TAG}>`;
}
