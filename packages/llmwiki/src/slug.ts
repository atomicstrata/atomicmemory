/**
 * Slug validation for the bridge JSON export contract.
 *
 * The page slug participates in the deterministic external ID
 * (`llmwiki/<projectId>/<pageDirectory>/<slug>`), so it is just as
 * identity-bearing as `projectId`. An unconstrained slug enables
 * identifier injection: a slug like `"../queries/anything"` produces
 * an external ID that crosses a `pageDirectory` boundary; a slug
 * containing `/` lets a forged record's external ID begin with a
 * legitimate project's prefix.
 *
 * The regex below mirrors the exporter's filesystem-slug discipline
 * (lowercase letters, digits, hyphens; starts with letter or digit;
 * 1..128 characters). When you change either side, change the other.
 *
 * `validateSlug` is also called as a tripwire inside `buildExternalId`
 * so identifier injection is impossible even if a caller bypasses
 * schema validation.
 */

import { E_LLMWIKI_EXPORT_INVALID_SHAPE, LLMWikiBridgeError } from "./errors.js";

/** Regex pinning the on-wire slug format. */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/;

/**
 * Throw `E_LLMWIKI_EXPORT_INVALID_SHAPE` when the slug fails the
 * documented regex. Returns the input on success. Used both at
 * schema-validation time and as a defense-in-depth tripwire in
 * `buildExternalId`.
 */
export function validateSlug(candidate: unknown): string {
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new LLMWikiBridgeError(
      E_LLMWIKI_EXPORT_INVALID_SHAPE,
      `slug must be a non-empty string; received ${typeof candidate}`,
    );
  }
  if (!SLUG_PATTERN.test(candidate)) {
    throw new LLMWikiBridgeError(
      E_LLMWIKI_EXPORT_INVALID_SHAPE,
      `Invalid slug "${candidate}". Must match /^[a-z0-9][a-z0-9-]{0,127}$/.`,
    );
  }
  return candidate;
}
