/**
 * External-id scheme for live source memories: `llmwiki-source/<projectId>/<encodeURIComponent(filename)>`.
 * Distinct from the page scheme (`llmwiki/<projectId>/<pageDir>/<slug>`). The id is OPAQUE — never a
 * filesystem path; parsing rejects wrong prefix/project, traversal, separators, and non-`.md` basenames.
 */
import { validateProjectId } from "../project-id.js";
import { LLMWikiBridgeError, E_LLMWIKI_EXPORT_INVALID_SHAPE, E_LLMWIKI_PROJECT_ID_INVALID } from "../errors.js";

export const LIVE_EXTERNAL_ID_PREFIX = "llmwiki-source";

/** Builds a live source external ID from a projectId and a safe `.md` basename. */
export function buildLiveExternalId(projectId: string, filename: string): string {
  validateProjectId(projectId);
  assertSafeFilename(filename);
  return `${LIVE_EXTERNAL_ID_PREFIX}/${projectId}/${encodeURIComponent(filename)}`;
}

/** Parses a live source external ID, returning the decoded filename. Throws on any mismatch or unsafe content. */
// fallow-ignore-next-line complexity
export function parseLiveExternalId(externalId: string, expectedProjectId: string): { filename: string } {
  validateProjectId(expectedProjectId);
  const parts = externalId.split("/");
  if (parts.length !== 3 || parts[0] !== LIVE_EXTERNAL_ID_PREFIX) {
    throw new LLMWikiBridgeError(E_LLMWIKI_EXPORT_INVALID_SHAPE, `not a live source id: "${externalId}"`);
  }
  const encodedProjectId = parts[1];
  const encodedFilename = parts[2];
  if (encodedProjectId !== expectedProjectId) {
    throw new LLMWikiBridgeError(E_LLMWIKI_PROJECT_ID_INVALID, `id projectId "${encodedProjectId}" != "${expectedProjectId}"`);
  }
  let filename: string;
  try {
    filename = decodeURIComponent(encodedFilename ?? "");
  } catch {
    throw new LLMWikiBridgeError(E_LLMWIKI_EXPORT_INVALID_SHAPE, `undecodable filename in "${externalId}"`);
  }
  assertSafeFilename(filename);
  return { filename };
}

/** A live source filename is a bare `sources/` basename ending in `.md` (no separators/traversal/NUL). */
// fallow-ignore-next-line complexity
function assertSafeFilename(filename: string): void {
  if (
    typeof filename !== "string" ||
    filename.length === 0 ||
    !filename.endsWith(".md") ||
    filename.includes("/") ||
    filename.includes("\\") ||
    filename.includes("\0") ||
    filename.includes("..")
  ) {
    throw new LLMWikiBridgeError(E_LLMWIKI_EXPORT_INVALID_SHAPE, `unsafe source filename: "${filename}"`);
  }
}
