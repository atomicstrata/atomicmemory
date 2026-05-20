/**
 * Shared LLM provider defaults.
 *
 * Runtime config and provider implementations both need these values. Keeping
 * them here avoids hidden drift between config defaults, provider fallbacks,
 * tests, and documentation snippets.
 */

export const DEFAULT_OPENAI_COMPATIBLE_LLM_MODEL = 'gpt-4o-mini';
export const DEFAULT_CODEX_LLM_MODEL = 'gpt-5.4-mini';
