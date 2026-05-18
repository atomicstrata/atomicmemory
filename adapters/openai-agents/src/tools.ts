/**
 * @file OpenAI Agents SDK function tools backed by AtomicMemory.
 */

import { tool } from '@openai/agents';
import { z } from 'zod';
import type { MemoryClient, Scope } from '@atomicmemory/sdk';

export interface CreateMemoryToolsOptions {
  scope: Scope;
  /** Default result limit for `memory_search` (default 5). */
  defaultLimit?: number;
  /** Optional metadata merged into every tool-driven ingest. */
  metadata?: Record<string, unknown>;
}

export function createMemoryTools(
  client: MemoryClient,
  opts: CreateMemoryToolsOptions,
) {
  const defaultLimit = opts.defaultLimit ?? 5;

  const memorySearch = tool({
    name: 'memory_search',
    description:
      'Search AtomicMemory for durable prior context relevant to the current task.',
    parameters: z.object({
      query: z.string().min(1).describe('Search query for the memory layer.'),
      limit: z
        .number()
        .int()
        .positive()
        .max(20)
        .nullable()
        .describe('Maximum number of results, or null to use the default.'),
    }),
    async execute({ query, limit }) {
      const page = await client.search({
        query,
        scope: opts.scope,
        limit: limit ?? defaultLimit,
      });
      return {
        results: page.results.map((result) => ({
          id: result.memory.id,
          content: result.memory.content,
          score: result.score,
        })),
      };
    },
  });

  const memoryIngest = tool({
    name: 'memory_ingest',
    description:
      'Store a durable user preference, decision, convention, or stable fact in AtomicMemory.',
    parameters: z.object({
      content: z.string().min(1).describe('Durable memory content to store.'),
    }),
    async execute({ content }) {
      const result = await client.ingest({
        mode: 'text',
        content,
        scope: opts.scope,
        ...(opts.metadata !== undefined ? { metadata: opts.metadata } : {}),
      });
      return result;
    },
  });

  return [memorySearch, memoryIngest] as const;
}
