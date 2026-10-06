/**
 * @file Convenience wrapper — composes `augmentWithMemory` (pre-call)
 *       and `ingestTurn` (post-call) around an arbitrary model call.
 *       The caller supplies the `run` function, so this works with
 *       `streamText`, `generateText`, a direct provider SDK call, or a
 *       custom HTTP request — anything that returns `{ text }`.
 *
 *       Keeping `run` framework-agnostic insulates the adapter from
 *       Vercel AI SDK version churn: we never import `ai` directly.
 */

import type {
  Message,
  MemoryClient,
  Scope,
  SearchResult,
} from '@atomicmemory/sdk';
import { augmentWithMemory } from './augment.js';
import { ingestTurn } from './ingest.js';

export interface WithMemoryOptions<TExtra> {
  client: MemoryClient;
  scope: Scope;
  messages: readonly Message[];
  /** Retrieval controls passed through to `augmentWithMemory`. */
  search?: {
    limit?: number;
    formatter?: (results: readonly SearchResult[]) => string;
  };
  /** Default: true. Set false to skip the post-call ingest. */
  ingestOnFinish?: boolean;
  /**
   * Execute the model call with the augmented messages. Must return a
   * result containing the assistant's final text. Additional fields on
   * the returned object flow through to the caller unchanged.
   */
  run: (messages: readonly Message[]) => Promise<{ text: string } & TExtra>;
}

export type WithMemoryResult<TExtra> = TExtra & {
  text: string;
  /** Memories retrieved before the model call (empty if none matched). */
  retrieved: readonly SearchResult[];
};

/**
 * Run a model call with memory: search first, ingest after. Retrieval
 * failures surface as thrown errors; ingest failures do too — the
 * caller decides whether they are recoverable.
 */
export async function withMemory<TExtra = Record<string, never>>(
  opts: WithMemoryOptions<TExtra>,
): Promise<WithMemoryResult<TExtra>> {
  const { messages: augmented, retrieved } = await augmentWithMemory(
    opts.client,
    {
      messages: opts.messages,
      scope: opts.scope,
      ...(opts.search ?? {}),
    },
  );

  const runResult = await opts.run(augmented);

  if (opts.ingestOnFinish !== false) {
    await ingestTurn(opts.client, {
      messages: opts.messages,
      completion: runResult.text,
      scope: opts.scope,
    });
  }

  return { ...runResult, retrieved };
}
