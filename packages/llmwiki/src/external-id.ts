/**
 * Deterministic external ID builder for bridge memories.
 *
 * Shape: `llmwiki/<projectId>/<pageDirectory>/<slug>`
 *
 * Pinned exactly so two collaborators ingesting the same export
 * produce byte-identical memory records. The `pageDirectory` segment
 * keeps concept-vs-query slugs disambiguated when a wiki contains
 * both an idea and a saved query with the same slug.
 *
 * `projectId` and `slug` are both validated as a defense-in-depth
 * tripwire: even when the schema has already accepted these values,
 * we re-check before letting them participate in identifier
 * construction. Unchecked input here enables identifier injection
 * (e.g. a slug `"../queries/anything"` would cross a `pageDirectory`
 * boundary in the produced ID).
 */

import { validateProjectId } from "./project-id.js";
import { validateSlug } from "./slug.js";

export const EXTERNAL_ID_PREFIX = "llmwiki";

export function buildExternalId(
  projectId: string,
  pageDirectory: "concepts" | "queries",
  slug: string,
): string {
  return `${EXTERNAL_ID_PREFIX}/${validateProjectId(projectId)}/${pageDirectory}/${validateSlug(slug)}`;
}

/** Prefix used when listing or deleting every memory imported under a project. */
export function externalIdPrefixForProject(projectId: string): string {
  return `${EXTERNAL_ID_PREFIX}/${projectId}/`;
}
