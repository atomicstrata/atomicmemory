/**
 * Scope boundary utilities shared by both llmwiki providers.
 *
 * Provides a defensive copy of a Scope value (cloneScope) and a field-presence
 * check (assertRequiredScopeFields) used in provider constructors to validate
 * the construction scope against `capabilities().requiredScope.default`.
 *
 * The construction-time check ensures that every operation path — including
 * `compile()`, which uses an exact-match guard rather than routing through
 * `runOperation` — is protected from a misconfigured `scope: {}` provider.
 */
import type { Scope } from "@atomicmemory/sdk";
import { LLMWikiBridgeError, E_LLMWIKI_PROVIDER_SCOPE_MISMATCH } from "./errors.js";

/**
 * Returns a fresh Scope object with only the defined fields from the input.
 * This ensures that mutations to the original or to the copy cannot cross-affect
 * each other, closing the reference-aliasing leak at both provider boundaries.
 *
 * Only defined fields are copied so the result satisfies `exactOptionalPropertyTypes`
 * and `assertScope`'s `undefined === undefined` comparisons.
 *
 * @param scope - The Scope to clone.
 * @returns A new Scope object with the same defined fields.
 */
export function cloneScope(scope: Scope): Scope {
  const SCOPE_FIELDS = ["user", "agent", "namespace", "thread"] as const;
  return Object.fromEntries(
    SCOPE_FIELDS.filter((f) => scope[f] !== undefined).map((f) => [f, scope[f]]),
  ) as Scope;
}

/**
 * Assert that every field listed in `requiredFields` is present and non-empty
 * in `scope`. Throws `E_LLMWIKI_PROVIDER_SCOPE_MISMATCH` with a message
 * naming the provider and missing field on the first violation.
 *
 * Called from provider constructors so the check applies to every operation
 * path (including ones that bypass `runOperation`).
 *
 * @param scope - The construction scope to validate (already cloned).
 * @param requiredFields - Fields that must be present (from capabilities().requiredScope.default).
 * @param providerName - Class name used in the error message.
 */
export function assertRequiredScopeFields(
  scope: Scope,
  requiredFields: readonly string[],
  providerName: string,
): void {
  for (const field of requiredFields) {
    const v = scope[field as keyof Scope];
    if (v === undefined || v === "") {
      throw new LLMWikiBridgeError(
        E_LLMWIKI_PROVIDER_SCOPE_MISMATCH,
        `${providerName} construction scope is missing the required field "${field}".`,
      );
    }
  }
}
