/**
 * Map a llmwiki SourceRecord to an AtomicMemory Memory, stamping the same prompt-injection
 * trust markers (`metadata.llmwiki.trustLevel = "external-import"`) used for snapshot pages —
 * live source bodies are untrusted text and package()/search() are injection-facing.
 */
import type { SourceRecord } from "llm-wiki-compiler";
import type { Memory, Scope } from "@atomicmemory/sdk";
import { LLMWIKI_METADATA_VERSION, LLMWIKI_TRUST_LEVEL } from "../metadata.js";
import { buildLiveExternalId } from "./live-external-id.js";
import { cloneScope } from "../scope.js";
import { parseDate } from "../dates.js";

/** Builds the `metadata.llmwiki` blob for a live source memory. */
export function buildLiveSourceMetadata(rec: SourceRecord, projectId: string): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    version: LLMWIKI_METADATA_VERSION,
    trustLevel: LLMWIKI_TRUST_LEVEL,
    projectId,
    sourceId: rec.id,
    source: rec.source,
    sourceType: rec.sourceType,
  };
  if (rec.ingestedAt !== undefined) meta.ingestedAt = rec.ingestedAt;
  return meta;
}

/** Maps a SourceRecord to a Memory with llmwiki trust markers. */
export function sourceToMemory(rec: SourceRecord, projectId: string, scope: Scope): Memory {
  const id = buildLiveExternalId(projectId, rec.id);
  const memory: Memory = {
    id,
    content: rec.body ?? "",
    scope: cloneScope(scope),
    kind: "document",
    createdAt: rec.ingestedAt !== undefined ? parseDate(rec.ingestedAt) : new Date(0),
    provenance: { source: "llmwiki", sourceId: id, extractor: "llmwiki-source" },
    metadata: { externalId: id, llmwiki: buildLiveSourceMetadata(rec, projectId) },
  };
  return memory;
}
