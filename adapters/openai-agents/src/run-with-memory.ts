/**
 * @file Convenience wrapper around an arbitrary OpenAI Agents SDK run call.
 */

import type {
  IngestResult,
  MemoryClient,
  Provenance,
  Scope,
  SearchResult,
} from '@atomicmemory/sdk';
import type { AgentInputItem } from '@openai/agents';
import { augmentInputWithMemory } from './augment.js';
import type { AgentInputLike, RunResultLike } from './messages.js';
import { ingestAgentTurn } from './ingest.js';

export interface RunWithMemoryOptions<TResult extends RunResultLike | unknown> {
  client: MemoryClient;
  scope: Scope;
  input: AgentInputLike;
  search?: {
    query?: string;
    limit?: number;
    formatter?: (results: readonly SearchResult[]) => string;
  };
  /** Default: true. Set false to skip post-run ingestion. */
  ingestOnFinish?: boolean;
  ingest?: {
    includeRoles?: Parameters<typeof ingestAgentTurn>[1]['includeRoles'];
    metadata?: Record<string, unknown>;
    provenance?: Provenance;
    /**
     * Override how the assistant output is read from the run result.
     * Useful for structured outputs or custom streamed result handling.
     */
    output?: (result: TResult) => string;
  };
  run: (input: readonly AgentInputItem[]) => Promise<TResult>;
}

export interface RunWithMemoryResult<TResult> {
  result: TResult;
  input: readonly AgentInputItem[];
  retrieved: readonly SearchResult[];
  ingestResult?: IngestResult;
}

export async function runWithMemory<TResult extends RunResultLike | unknown>(
  opts: RunWithMemoryOptions<TResult>,
): Promise<RunWithMemoryResult<TResult>> {
  const { input, retrieved } = await augmentInputWithMemory(opts.client, {
    input: opts.input,
    scope: opts.scope,
    ...(opts.search ?? {}),
  });

  const result = await opts.run(input);
  let ingestResult: IngestResult | undefined;

  if (opts.ingestOnFinish !== false) {
    const output = opts.ingest?.output?.(result);
    ingestResult = await ingestAgentTurn(opts.client, {
      input: opts.input,
      result,
      scope: opts.scope,
      ...(output !== undefined ? { output } : {}),
      ...(opts.ingest?.includeRoles !== undefined
        ? { includeRoles: opts.ingest.includeRoles }
        : {}),
      ...(opts.ingest?.metadata !== undefined ? { metadata: opts.ingest.metadata } : {}),
      ...(opts.ingest?.provenance !== undefined
        ? { provenance: opts.ingest.provenance }
        : {}),
    });
  }

  return { result, input, retrieved, ...(ingestResult ? { ingestResult } : {}) };
}
