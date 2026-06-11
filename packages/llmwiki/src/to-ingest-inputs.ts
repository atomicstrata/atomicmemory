/**
 * Map a validated `LLMWikiExport` to one `VerbatimIngest` per page.
 *
 * Constraints — load-bearing for the bridge contract:
 *
 *   1. projectId is required. Refuses to invent one. The exporter's
 *      `--project-id` flag flows in here via `options.projectIdOverride`;
 *      when both the envelope and the override are absent, the call
 *      throws `E_LLMWIKI_PROJECT_ID_REQUIRED`.
 *   2. Always emits `mode: "verbatim"`. text/messages would re-extract
 *      and drop bridge metadata silently.
 *   3. Stable external ID `llmwiki/<projectId>/<pageDirectory>/<slug>`
 *      is attached to BOTH `provenance.sourceId` AND
 *      `metadata.externalId` so providers that look at either surface
 *      can deduplicate.
 *   4. All advisory metadata travels under
 *      `metadata.llmwiki.*` — never spread loose so an unrelated
 *      consumer who reads the memory's metadata can tell which fields
 *      came from the bridge.
 */

import type { IngestInput, Scope } from "@atomicmemory/sdk";
import { buildExternalId } from "./external-id.js";
import { buildLlmwikiMetadata } from "./metadata.js";
import { E_LLMWIKI_EXPORT_DUPLICATE_SLUG, LLMWikiBridgeError } from "./errors.js";
import type { ExportPage, LLMWikiExport } from "./schema.js";
import { validateProjectId } from "./project-id.js";

export interface ToIngestInputsOptions {
  scope: Scope;
  /**
   * Override the envelope's `projectId`. Use to override or supply
   * when the export was produced without `--project-id` and the
   * caller wants to pin one at import time.
   */
  projectIdOverride?: string;
}

export function toAtomicMemoryIngestInputs(
  exportData: LLMWikiExport,
  options: ToIngestInputsOptions,
): IngestInput[] {
  const projectId = validateProjectId(
    options.projectIdOverride ?? exportData.projectId,
  );
  // Reject duplicate (pageDirectory, slug) pairs up front so a
  // caller-driven ingest loop can't write parallel records under the
  // same external ID. Mirrors the same guard at SnapshotLLMWikiProvider
  // construction so the SDK ingest path and the read path agree.
  const seenIds = new Set<string>();
  const inputs: IngestInput[] = [];
  for (const page of exportData.pages) {
    const externalId = buildExternalId(projectId, page.pageDirectory, page.slug);
    if (seenIds.has(externalId)) {
      throw new LLMWikiBridgeError(
        E_LLMWIKI_EXPORT_DUPLICATE_SLUG,
        `Duplicate external ID "${externalId}" in export — two pages share ` +
          `(pageDirectory="${page.pageDirectory}", slug="${page.slug}").`,
      );
    }
    seenIds.add(externalId);
    inputs.push(toVerbatimIngest(page, projectId, options.scope, externalId));
  }
  return inputs;
}

function toVerbatimIngest(
  page: ExportPage,
  projectId: string,
  scope: Scope,
  externalId: string,
): IngestInput {
  return {
    mode: "verbatim",
    scope,
    // SDK `IngestInput` shape uses `content`; the CLI adapter's
    // `AdapterIngestInput` uses `text` for the same payload. Both
    // mean "the verbatim body to store" — the field name asymmetry
    // is a boundary-layer artifact, not two different concepts.
    content: page.body,
    provenance: {
      source: "llmwiki",
      sourceId: externalId,
      // `extractor: "llmwiki"` tells downstream packaging this content
      // came from an external pipeline, not from AM's own LLM
      // extraction — the closest existing SDK Provenance primitive to a
      // trust signal. Complements metadata.llmwiki.trustLevel.
      extractor: "llmwiki",
    },
    metadata: {
      externalId,
      llmwiki: buildLlmwikiMetadata(page, projectId),
    },
  };
}

