/**
 * @file register-internals
 *
 * Internal implementation helpers shared between register.ts and its tests.
 * This module is intentionally NOT listed in the package.json exports map —
 * the exports map already prevents consumers from deep-importing it, so
 * it is invisible to the public API surface.
 */

import { LLMWikiBridgeError, E_LLMWIKI_COMPILER_MISSING } from "./errors.js";

/**
 * The `llm-wiki-compiler` peer range as declared in package.json.
 * Used to keep the error-message install hint in sync with the declared range.
 * A test in register.test.ts asserts this matches
 * package.json `peerDependencies["llm-wiki-compiler"]`, so it cannot drift.
 */
export const LLMWIKI_COMPILER_PEER_RANGE = "^0.9.0";

/**
 * Map a dynamic-import failure to a stable, actionable error — but ONLY when the
 * missing module is `llm-wiki-compiler` itself. Node's ERR_MODULE_NOT_FOUND message
 * QUOTES the unresolved specifier ("Cannot find package 'llm-wiki-compiler' …"), so
 * match the quoted exact name. Do NOT use /\bllm-wiki-compiler\b/: `-` is a non-word
 * char, so \b matches inside hyphenated specifiers and a missing package named
 * `llm-wiki-compiler-anything` would be mislabeled as the peer. A different missing
 * module returns `undefined` and the caller rethrows the original.
 */
export function mapCompilerLoadError(cause: unknown): LLMWikiBridgeError | undefined {
  const err = cause as NodeJS.ErrnoException & { message?: string };
  if (err?.code === "ERR_MODULE_NOT_FOUND" && /'llm-wiki-compiler'/.test(String(err.message))) {
    return new LLMWikiBridgeError(
      E_LLMWIKI_COMPILER_MISSING,
      `The live llmwiki provider requires the optional peer "llm-wiki-compiler". Install it (e.g. \`npm i llm-wiki-compiler@${LLMWIKI_COMPILER_PEER_RANGE}\`) to use @atomicmemory/llmwiki/register.`,
      { cause },
    );
  }
  return undefined;
}
