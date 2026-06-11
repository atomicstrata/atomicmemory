/**
 * @atomicmemory/llmwiki — public surface.
 *
 * Bridge adapter for importing llmwiki JSON exports into AtomicMemory
 * as one verbatim memory record per wiki page, with all advisory
 * metadata (kind, confidence, provenance state, contradictions,
 * citations, aliases, freshness) preserved under
 * `memory.metadata.llmwiki.*`.
 */

export { loadLLMWikiExport } from "./load-export.js";
export { toAtomicMemoryIngestInputs, type ToIngestInputsOptions } from "./to-ingest-inputs.js";
export {
  assertSupportsVerbatim,
  supportsVerbatim,
  verbatimUnsupportedMessage,
} from "./capability-check.js";
export { SnapshotLLMWikiProvider, type SnapshotLLMWikiProviderOptions } from "./provider.js";
export { snapshotLlmwikiProviderFactory } from "./registration.js";
export {
  buildLlmwikiMetadata,
  LLMWIKI_METADATA_VERSION,
  LLMWIKI_TRUST_LEVEL,
} from "./metadata.js";
export {
  buildExternalId,
  externalIdPrefixForProject,
  EXTERNAL_ID_PREFIX,
} from "./external-id.js";
export { validateProjectId, PROJECT_ID_PATTERN } from "./project-id.js";
export { validateSlug, SLUG_PATTERN } from "./slug.js";

export {
  LLMWikiBridgeError,
  E_LLMWIKI_COMPILER_MISSING,
  E_LLMWIKI_EXPORT_DUPLICATE_SLUG,
  E_LLMWIKI_EXPORT_INVALID_SHAPE,
  E_LLMWIKI_EXPORT_NOT_FOUND,
  E_LLMWIKI_EXPORT_OVER_LIMIT,
  E_LLMWIKI_PROJECT_ID_INVALID,
  E_LLMWIKI_PROJECT_ID_REQUIRED,
  E_LLMWIKI_PROVIDER_INVALID_BUDGET,
  E_LLMWIKI_PROVIDER_INVALID_CURSOR,
  E_LLMWIKI_PROVIDER_INVALID_LIMIT,
  E_LLMWIKI_PROVIDER_READONLY,
  E_LLMWIKI_PROVIDER_SCOPE_MISMATCH,
  E_LLMWIKI_REIMPORT_CHECK_INCONCLUSIVE,
  E_LLMWIKI_VERBATIM_UNSUPPORTED,
  type LLMWikiErrorCode,
} from "./errors.js";

export type {
  LLMWikiExport,
  ExportPage,
  Citation,
  ContradictionRef,
} from "./schema.js";

export {
  MAX_BODY_LENGTH,
  MAX_FIELD_LENGTH,
  MAX_NESTING_DEPTH,
  MAX_PAGE_COUNT,
  MAX_TOTAL_SIZE_BYTES,
} from "./limits.js";
