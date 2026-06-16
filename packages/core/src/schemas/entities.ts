/**
 * Zod schemas for the /v1/entities route parameter, query, and body validation.
 */

import { z } from './zod-setup.js';
import { containsNoNul, NUL_REJECTION_MESSAGE } from './common.js';

/**
 * Opaque, trimmed, non-empty identifier reused for every entity_id / memory_id
 * that reaches Postgres via a path param or the merge body. The NUL refine
 * makes a `%00` path segment (e.g. `/v1/entities/user/qa%00x/profile`) 4xx at
 * validation instead of 500ing at the driver — the body/query halves of the
 * same defect class live in `common.ts`. See QA release-1.1.0
 * `core-robustness:nul.*`.
 */
const OpaqueIdField = z
  .string()
  .trim()
  .min(1)
  .refine(containsNoNul, { message: NUL_REJECTION_MESSAGE });

export const EntityTypeParamSchema = z.object({
  entity_type: z.enum(['user', 'agent', 'session']),
  entity_id: OpaqueIdField,
});

export const EntityListQuerySchema = z.object({
  entity_type: z.enum(['user', 'agent', 'session']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(200).default(50),
});

export const GetEntityQuerySchema = z.object({
  /** Optional entity name to resolve relations for. When omitted, relations are not returned
   *  because entity-graph lookup requires a semantic name, not an opaque user_id. */
  entity_name: z.string().trim().min(1).optional(),
});

export const AttributesQuerySchema = z.object({
  attribute: z.string().trim().min(1).optional(),
  entity: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const MemoryHistoryParamSchema = z.object({
  entity_type: z.enum(['user', 'agent', 'session']),
  entity_id: OpaqueIdField,
  memory_id: OpaqueIdField,
});

export const EntitySettingsPatchSchema = z
  .object({
    extraction_prompt: z.string().max(1500).optional(),
    memory_kinds: z.array(z.string()).optional(),
    decay_enabled: z.boolean().optional(),
  })
  .refine(
    (d) => d.extraction_prompt !== undefined || d.memory_kinds !== undefined || d.decay_enabled !== undefined,
    { message: 'at least one of extraction_prompt, memory_kinds, or decay_enabled is required' },
  );

export const MergeBodySchema = z.object({
  source: z.object({
    entity_type: z.enum(['user', 'agent', 'session']),
    entity_id: OpaqueIdField,
  }),
  target: z.object({
    entity_type: z.enum(['user', 'agent', 'session']),
    entity_id: OpaqueIdField,
  }),
});
