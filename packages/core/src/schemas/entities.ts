/**
 * Zod schemas for the /v1/entities route parameter, query, and body validation.
 */

import { z } from './zod-setup.js';

export const EntityTypeParamSchema = z.object({
  entity_type: z.enum(['user', 'agent', 'session']),
  entity_id: z.string().trim().min(1),
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
  entity_id: z.string().trim().min(1),
  memory_id: z.string().trim().min(1),
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
    entity_id: z.string().trim().min(1),
  }),
  target: z.object({
    entity_type: z.enum(['user', 'agent', 'session']),
    entity_id: z.string().trim().min(1),
  }),
});
