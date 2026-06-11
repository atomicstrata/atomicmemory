/**
 * Light, lazy registration surface for the live llmwiki provider.
 *
 * Importing this module loads NO heavy dependency — `llm-wiki-compiler` and the
 * live provider load only when the returned factory is invoked (i.e. only if a
 * caller actually configures + initializes the `llmwiki-live` provider). For
 * eager/direct construction, use `@atomicmemory/llmwiki/live`.
 */
import type { MemoryProviderRegistration, Scope } from "@atomicmemory/sdk";
import type { LiveLLMWikiProviderOptions } from "./live/provider.js"; // TYPE-ONLY → erased; body-only
import { mapCompilerLoadError } from "./register-internals.js";

// Re-export the error surface so register-only consumers can branch on the named
// constant (`e.code === E_LLMWIKI_COMPILER_MISSING`) and use `instanceof
// LLMWikiBridgeError` without importing the root barrel. errors.ts is light,
// so the import boundary is unaffected.
export { LLMWikiBridgeError, E_LLMWIKI_COMPILER_MISSING } from "./errors.js";

/** Self-contained light config; mirrors the required fields of LiveLLMWikiProviderOptions. */
export interface LiveLlmwikiLazyConfig {
  root: string;
  projectId: string;
  scope: Scope;
  tokenize?: (text: string) => number;
}

/**
 * Returns an async ProviderRegistry factory that constructs a LiveLLMWikiProvider on
 * first use, dynamically importing the heavy live module (and thus llm-wiki-compiler) only then.
 *
 * The factory takes a {@link LiveLlmwikiLazyConfig} (`root`, `projectId`, `scope`,
 * optional `tokenize`); the `satisfies` mirror against `LiveLLMWikiProviderOptions`
 * is compile-time-only — nothing from the live module is loaded to validate it.
 *
 * Throws (from the returned factory): a {@link LLMWikiBridgeError} with code
 * `E_LLMWIKI_COMPILER_MISSING` when the optional peer `llm-wiki-compiler` is not
 * installed; any other dynamic-import failure is rethrown unchanged.
 */
export function liveLlmwikiLazyEntry(): (config: LiveLlmwikiLazyConfig) => Promise<MemoryProviderRegistration> {
  return async (config) => {
    const opts = config satisfies LiveLLMWikiProviderOptions; // compile-time required-field mirror
    let mod: typeof import("./live/provider.js");
    try {
      mod = await import("./live/provider.js");
    } catch (cause) {
      throw mapCompilerLoadError(cause) ?? cause;
    }
    return { provider: new mod.LiveLLMWikiProvider(opts) };
  };
}
