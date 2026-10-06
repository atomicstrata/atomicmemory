/** Strict schemas for trusted configuration and model-controlled tool arguments. */
import { z } from 'zod/v3';

// This subpath has the same schema API in both supported Zod major versions.

const MAX_USER_LENGTH = 256;
const MAX_QUERY_LENGTH = 4096;
const MAX_CONTENT_LENGTH = 32768;
const MAX_SEARCH_LIMIT = 20;

function nonblank(max: number) {
  return z.string().min(1).max(max).refine(value => value.trim().length > 0);
}

export const searchInputSchema = z.object({
  query: nonblank(MAX_QUERY_LENGTH),
  limit: z.number().int().min(1).max(MAX_SEARCH_LIMIT).default(5),
}).strict();

export const ingestInputSchema = z.object({
  content: nonblank(MAX_CONTENT_LENGTH),
}).strict();

export const optionsSchema = z.object({
  client: z.object({ ingest: z.function(), search: z.function() }).passthrough(),
  scope: z.object({
    user: nonblank(MAX_USER_LENGTH).refine(value => !value.trim().startsWith('project:')),
  }).strict(),
}).strict();

/** Parsed model search arguments; omitted limit defaults to five. */
export type MemorySearchInput = z.input<typeof searchInputSchema>;
/** Model ingest arguments. Identity and transport options are not model inputs. */
export type MemoryIngestInput = z.infer<typeof ingestInputSchema>;
