/**
 * Zod schema for the llmwiki bridge JSON export envelope.
 *
 * Matches the exporter's `ExportPage` contract one-for-one. Enforces:
 *
 *   1. Page count cap.
 *   2. Per-field length caps (body has a higher cap than other fields).
 *   3. ProjectId regex when present (the CLI may also supply it).
 *
 * Nesting-depth caps are enforced separately by
 * `assertNestingDepthSafe` in `nesting-guard.ts` because Zod doesn't
 * expose a depth-limit primitive — that guard runs before the schema
 * to bound the parser cost.
 */

import { z } from "zod";
import {
  MAX_ARRAY_LENGTH,
  MAX_BODY_LENGTH,
  MAX_CITATION_LINE,
  MAX_FIELD_LENGTH,
  MAX_PAGE_COUNT,
} from "./limits.js";
import { SLUG_PATTERN } from "./slug.js";

const boundedString = (max: number) => z.string().max(max);
const boundedShortString = boundedString(MAX_FIELD_LENGTH);
const boundedLineNumber = z.number().int().positive().max(MAX_CITATION_LINE);

/**
 * Unknown-fields policy: `.passthrough()`. New advisory fields added
 * to a future export shape (e.g. signature, audit token) survive the
 * importer unchanged so downstream consumers can read them. Strict
 * mode (`.strict()`) was rejected because forward-compat is more
 * important than catching producer typos at the bridge boundary —
 * the export's own schema is the source of truth for those.
 */
export const CitationSchema = z
  .object({
    file: boundedShortString,
    start: boundedLineNumber.optional(),
    end: boundedLineNumber.optional(),
  })
  .passthrough()
  .refine(
    ({ start, end }) => start === undefined || end === undefined || end >= start,
    { message: "citation end must be >= start" },
  );

export const ContradictionRefSchema = z
  .object({
    slug: boundedShortString.min(1),
    reason: boundedShortString.optional(),
  })
  .passthrough();

export const PageKindSchema = z.enum(["concept", "entity", "comparison", "overview"]);
export const ProvenanceStateSchema = z.enum(["extracted", "merged", "inferred", "ambiguous"]);
export const PageDirectorySchema = z.enum(["concepts", "queries"]);
export const AdvisoryFreshnessStatusSchema = z.literal("unverified");

export const ExportPageSchema = z
  .object({
    title: boundedShortString.min(1),
    slug: z.string().regex(SLUG_PATTERN, "slug does not match /^[a-z0-9][a-z0-9-]{0,127}$/"),
    pageDirectory: PageDirectorySchema,
    path: boundedShortString.min(1),
    summary: boundedShortString,
    sources: z.array(boundedShortString).max(MAX_ARRAY_LENGTH),
    tags: z.array(boundedShortString).max(MAX_ARRAY_LENGTH),
    createdAt: boundedShortString,
    updatedAt: boundedShortString,
    links: z.array(boundedShortString).max(MAX_ARRAY_LENGTH),
    body: boundedString(MAX_BODY_LENGTH),
    kind: PageKindSchema.optional(),
    advisoryConfidence: z.number().min(0).max(1).optional(),
    provenanceState: ProvenanceStateSchema.optional(),
    contradictedBy: z.array(ContradictionRefSchema).max(MAX_ARRAY_LENGTH).optional(),
    citations: z.array(CitationSchema).max(MAX_ARRAY_LENGTH),
    aliases: z.array(boundedShortString).max(MAX_ARRAY_LENGTH).optional(),
    advisoryFreshnessStatus: AdvisoryFreshnessStatusSchema,
  })
  .passthrough();

export const LLMWikiExportSchema = z
  .object({
    exportedAt: boundedShortString,
    pageCount: z.number().int().nonnegative(),
    // Schema accepts any bounded string here so a buggy or
    // older-version export can still be loaded — CLI callers may
    // pass `--project-id` to override an envelope projectId that
    // wouldn't pass the strict regex. The strict
    // `PROJECT_ID_PATTERN` check happens after override resolution
    // via `validateProjectId`.
    projectId: boundedShortString.optional(),
    pages: z.array(ExportPageSchema).max(MAX_PAGE_COUNT),
  })
  .passthrough()
  .refine(
    (envelope) => envelope.pageCount === envelope.pages.length,
    { message: "pageCount must equal pages.length" },
  );

export type LLMWikiExport = z.infer<typeof LLMWikiExportSchema>;
export type ExportPage = z.infer<typeof ExportPageSchema>;
export type Citation = z.infer<typeof CitationSchema>;
export type ContradictionRef = z.infer<typeof ContradictionRefSchema>;
