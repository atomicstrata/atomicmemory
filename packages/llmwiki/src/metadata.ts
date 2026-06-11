/**
 * Shared `metadata.llmwiki.*` builder.
 *
 * Used by:
 *   - `to-ingest-inputs.ts` to populate `VerbatimIngest.metadata.llmwiki`.
 *   - `provider.ts` to populate `Memory.metadata.llmwiki`.
 *   - `@atomicmemory/cli` (`memory/import-llmwiki.ts`) to populate
 *     `AdapterIngestInput.metadata.llmwiki`.
 *
 * Three call sites, one shape. If a new field lands in `ExportPage`,
 * it must be wired here AND mirrored in the corresponding read-side
 * consumers; the build artifact has no way to enforce that across the
 * SDK/CLI boundary.
 *
 * **Versioning contract.** Every memory carries
 * `metadata.llmwiki.version = LLMWIKI_METADATA_VERSION`. Consumers
 * reading bridge-produced memories MUST check this field before
 * accessing any other `llmwiki.*` field. An unknown version is a
 * signal that the metadata shape may have changed — read code should
 * reject or fall back to advisory-only handling rather than guess.
 * Bumping the version is a deliberate, semver-significant act.
 *
 * **Trust level.** Every memory carries
 * `metadata.llmwiki.trustLevel = LLMWIKI_TRUST_LEVEL`. The body
 * content of an imported wiki page is plain text written by a third
 * party — it can contain prompt-injection payloads that try to
 * subvert the consuming LLM. Downstream packaging is responsible
 * for surfacing this signal in a way the LLM can act on (e.g.
 * wrapping in `<untrusted-source>` tags when injecting into a
 * prompt). The bridge does NOT sanitize content; the trust marker
 * IS the bridge's only defense against this attack surface.
 *
 * The trust level lives on `metadata.llmwiki.*` rather than on the
 * SDK's `Provenance` interface because `Provenance` doesn't yet
 * declare a `trustLevel` field. A follow-up SDK extension should
 * mirror this value onto `provenance.trustLevel` so it travels
 * through the standard packaging surface; until then, packagers
 * that need the signal read it from `metadata.llmwiki.trustLevel`.
 */

import { E_LLMWIKI_EXPORT_OVER_LIMIT, LLMWikiBridgeError } from "./errors.js";
import { MAX_PER_PAGE_METADATA_BYTES } from "./limits.js";
import type { ExportPage } from "./schema.js";

/**
 * Schema version stamped onto every produced metadata blob.
 * Exported so downstream consumers can branch on it. Bumping this
 * value is a breaking change to the bridge contract.
 */
export const LLMWIKI_METADATA_VERSION = 1;

/**
 * Trust level stamped onto every produced metadata blob. Imported
 * wiki content is by definition externally-authored text; downstream
 * LLM-facing packaging must treat it as untrusted relative to
 * operator-authored prompts and tool definitions.
 */
export const LLMWIKI_TRUST_LEVEL = "external-import" as const;

export function buildLlmwikiMetadata(
  page: ExportPage,
  projectId: string,
): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    version: LLMWIKI_METADATA_VERSION,
    trustLevel: LLMWIKI_TRUST_LEVEL,
    projectId,
    path: page.path,
    pageDirectory: page.pageDirectory,
    slug: page.slug,
    title: page.title,
    summary: page.summary,
    sources: page.sources,
    tags: page.tags,
    citations: page.citations,
    advisoryFreshnessStatus: page.advisoryFreshnessStatus,
  };
  if (page.kind !== undefined) meta.kind = page.kind;
  if (page.advisoryConfidence !== undefined) meta.advisoryConfidence = page.advisoryConfidence;
  if (page.provenanceState !== undefined) meta.provenanceState = page.provenanceState;
  if (page.contradictedBy !== undefined) meta.contradictedBy = page.contradictedBy;
  if (page.aliases !== undefined) meta.aliases = page.aliases;
  assertMetadataSizeSafe(meta, page);
  return meta;
}

function assertMetadataSizeSafe(meta: Record<string, unknown>, page: ExportPage): void {
  const serialized = JSON.stringify(meta);
  const bytes = Buffer.byteLength(serialized, "utf-8");
  if (bytes > MAX_PER_PAGE_METADATA_BYTES) {
    throw new LLMWikiBridgeError(
      E_LLMWIKI_EXPORT_OVER_LIMIT,
      `Page "${page.path}" metadata blob is ${bytes} bytes; per-page cap is ${MAX_PER_PAGE_METADATA_BYTES}.`,
    );
  }
}
