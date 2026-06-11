/**
 * Stable error codes the bridge adapter throws. CLI callers and other
 * consumers branch on `.code`, not on message wording. Adding new codes
 * is fine; renaming an existing one is a breaking change.
 *
 * **Inheritance contract.** `LLMWikiBridgeError extends
 * MemoryProviderError` so SDK consumers writing generic
 * `catch (e instanceof MemoryProviderError)` handlers catch every
 * bridge error too. Specific consumers branch on `.code` for the
 * `E_LLMWIKI_*` discriminator. `.provider` is always `"llmwiki"`;
 * `.operation` is the originating method name when the throw site
 * has natural context (e.g. `"search"`, `"list"`) or the error code
 * itself when not.
 */

import { MemoryProviderError } from "@atomicmemory/sdk";

export const E_LLMWIKI_EXPORT_INVALID_SHAPE = "E_LLMWIKI_EXPORT_INVALID_SHAPE";
export const E_LLMWIKI_EXPORT_OVER_LIMIT = "E_LLMWIKI_EXPORT_OVER_LIMIT";
export const E_LLMWIKI_EXPORT_NOT_FOUND = "E_LLMWIKI_EXPORT_NOT_FOUND";
export const E_LLMWIKI_PROJECT_ID_REQUIRED = "E_LLMWIKI_PROJECT_ID_REQUIRED";
export const E_LLMWIKI_PROJECT_ID_INVALID = "E_LLMWIKI_PROJECT_ID_INVALID";
export const E_LLMWIKI_VERBATIM_UNSUPPORTED = "E_LLMWIKI_VERBATIM_UNSUPPORTED";
export const E_LLMWIKI_PROVIDER_READONLY = "E_LLMWIKI_PROVIDER_READONLY";
export const E_LLMWIKI_PROVIDER_SCOPE_MISMATCH = "E_LLMWIKI_PROVIDER_SCOPE_MISMATCH";
export const E_LLMWIKI_PROVIDER_INVALID_CURSOR = "E_LLMWIKI_PROVIDER_INVALID_CURSOR";
export const E_LLMWIKI_PROVIDER_INVALID_LIMIT = "E_LLMWIKI_PROVIDER_INVALID_LIMIT";
export const E_LLMWIKI_PROVIDER_DISPOSED = "E_LLMWIKI_PROVIDER_DISPOSED";
export const E_LLMWIKI_EXPORT_DUPLICATE_SLUG = "E_LLMWIKI_EXPORT_DUPLICATE_SLUG";
export const E_LLMWIKI_REIMPORT_CHECK_INCONCLUSIVE = "E_LLMWIKI_REIMPORT_CHECK_INCONCLUSIVE";
export const E_LLMWIKI_PROVIDER_INVALID_BUDGET = "E_LLMWIKI_PROVIDER_INVALID_BUDGET";
export const E_LLMWIKI_COMPILER_MISSING = "E_LLMWIKI_COMPILER_MISSING";

export type LLMWikiErrorCode =
  | typeof E_LLMWIKI_EXPORT_INVALID_SHAPE
  | typeof E_LLMWIKI_EXPORT_OVER_LIMIT
  | typeof E_LLMWIKI_EXPORT_NOT_FOUND
  | typeof E_LLMWIKI_EXPORT_DUPLICATE_SLUG
  | typeof E_LLMWIKI_PROJECT_ID_REQUIRED
  | typeof E_LLMWIKI_PROJECT_ID_INVALID
  | typeof E_LLMWIKI_VERBATIM_UNSUPPORTED
  | typeof E_LLMWIKI_PROVIDER_READONLY
  | typeof E_LLMWIKI_PROVIDER_SCOPE_MISMATCH
  | typeof E_LLMWIKI_PROVIDER_INVALID_CURSOR
  | typeof E_LLMWIKI_PROVIDER_INVALID_LIMIT
  | typeof E_LLMWIKI_PROVIDER_INVALID_BUDGET
  | typeof E_LLMWIKI_PROVIDER_DISPOSED
  | typeof E_LLMWIKI_REIMPORT_CHECK_INCONCLUSIVE
  | typeof E_LLMWIKI_COMPILER_MISSING;

/**
 * Error thrown by every public function in this package. Carries a
 * stable `code` so CLI callers can branch without depending on
 * message wording, and propagates the originating error via `cause`
 * so the underlying ENOENT/EACCES/etc. survives the wrap.
 */
export class LLMWikiBridgeError extends MemoryProviderError {
  readonly code: LLMWikiErrorCode;

  constructor(
    code: LLMWikiErrorCode,
    message: string,
    options?: { cause?: unknown; operation?: string },
  ) {
    const cause = options?.cause instanceof Error ? options.cause : undefined;
    super(message, "llmwiki", options?.operation ?? code, cause);
    this.code = code;
    // Assign in the constructor body rather than via an `override`
    // readonly field. With useDefineForClassFields=true the field
    // initializer would run after super(), which works in current TS
    // but historically interacted badly with the override modifier
    // when the base class declares `name` as a prototype property.
    // The constructor-body assignment is bulletproof across the modes
    // a future TS upgrade might select.
    this.name = "LLMWikiBridgeError";
  }
}
