/**
 * Bridge import limits.
 *
 * The llmwiki export JSON is untrusted input the moment it crosses
 * out of llmwiki's process. These caps defend against the standard
 * JSON-parser DoS shapes: deep nesting, giant string fields, and
 * pathological page counts. The exact numbers come from the bridge
 * plan §Export schema validation; reproduced here so the runtime
 * guard is self-contained.
 *
 * `MAX_TOTAL_SIZE_BYTES` is enforced by `loadLLMWikiExport` before any
 * JSON parsing happens. The per-field / per-page caps are enforced by
 * the Zod schema in `schema.ts` against the parsed document.
 */

/** Maximum number of pages allowed in one export envelope. */
export const MAX_PAGE_COUNT = 100_000;

/** Maximum bytes for any single page `body` field. */
export const MAX_BODY_LENGTH = 1_048_576;

/** Maximum bytes for any non-body string field (title, summary, slug, etc.). */
export const MAX_FIELD_LENGTH = 65_536;

/** Maximum nesting depth tolerated in the parsed JSON document. */
export const MAX_NESTING_DEPTH = 16;

/** Maximum total bytes of the export file on disk. */
export const MAX_TOTAL_SIZE_BYTES = 256 * 1024 * 1024;

/**
 * Maximum length for any per-page array (sources, tags, links,
 * aliases, contradictedBy, citations). Smaller than `MAX_PAGE_COUNT`
 * because per-page arrays semantically can't be near the page-count
 * scale — they describe ONE page.
 */
export const MAX_ARRAY_LENGTH = 10_000;

/**
 * Maximum line number tolerated in a citation. Source files with
 * more than 10M lines are not credibly a wiki source; this protects
 * against the `start: 1, end: 1e9` foot-gun.
 */
export const MAX_CITATION_LINE = 10_000_000;

/**
 * Maximum serialized size of the `metadata.llmwiki.*` blob attached
 * to ONE memory record. The per-field caps individually look small,
 * but a page with 10K × 64KB tag entries plus 10K × 64KB sources
 * could ship a multi-GB metadata blob and still fit the 256 MB
 * total-file cap (JSON minified compresses well). This cap bounds
 * each per-page payload so the downstream memory store sees a
 * predictable maximum per record.
 */
export const MAX_PER_PAGE_METADATA_BYTES = 256 * 1024;
