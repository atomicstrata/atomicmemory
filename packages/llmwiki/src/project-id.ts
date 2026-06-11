/**
 * Project ID validation.
 *
 * **MIRROR OF** `llm-wiki-compiler/src/export/project-id.ts`. The
 * regex `PROJECT_ID_PATTERN` MUST match byte-for-byte across both
 * files; the importer side rejects a `projectId` the exporter would
 * have produced anyway is harmless, but the reverse (importer accepts
 * what exporter rejected) is the foot-gun this duplication exists to
 * prevent. When you change either file, change both, and run the
 * contract test in both repos.
 *
 * Treated as a security boundary, not a dedup aid. Under current
 * AtomicMemory verbatim semantics — which are append-only by
 * external ID — collision does NOT produce a silent overwrite; it
 * produces **silent duplicate amplification**. Two projects sharing
 * a `projectId` write parallel record streams under the same
 * external-ID prefix, polluting each other's namespace without
 * either side noticing until a list/search pulls back records they
 * didn't author. The boundary discipline matters either way; only
 * the failure mode differs.
 */

import {
  E_LLMWIKI_PROJECT_ID_INVALID,
  E_LLMWIKI_PROJECT_ID_REQUIRED,
  LLMWikiBridgeError,
} from "./errors.js";

export const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * Throws a stable-coded error when the candidate does not match the
 * documented regex. Returns the input on success.
 */
export function validateProjectId(candidate: unknown): string {
  if (candidate === undefined || candidate === null || candidate === "") {
    throw new LLMWikiBridgeError(
      E_LLMWIKI_PROJECT_ID_REQUIRED,
      "projectId is required — supply it via the export envelope or CLI --project-id.",
    );
  }
  if (typeof candidate !== "string") {
    throw new LLMWikiBridgeError(
      E_LLMWIKI_PROJECT_ID_INVALID,
      `projectId must be a string; received ${typeof candidate}.`,
    );
  }
  if (!PROJECT_ID_PATTERN.test(candidate)) {
    throw new LLMWikiBridgeError(
      E_LLMWIKI_PROJECT_ID_INVALID,
      `Invalid projectId "${candidate}". Must match /^[a-z0-9][a-z0-9-]{0,62}$/.`,
    );
  }
  return candidate;
}
