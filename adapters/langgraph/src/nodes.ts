/**
 * @file Node factories - emit plain async
 *       `(state) => Partial<state>` functions that LangGraph
 *       can register directly with `.addNode()`. The functions
 *       are generic over the caller's state type so they fit
 *       any graph shape (`MessagesState`, custom state
 *       channels, etc.) without dragging in a LangGraph type
 *       dependency at runtime.
 */

import type {
  IngestResult,
  Message,
  MemoryClient,
  Scope,
  SearchResult,
} from '@atomicmemory/sdk';
import { searchMemory } from './search.js';
import { ingestTurn } from './ingest.js';

export interface CreateMemoryRetrieveNodeOptions<TState, TUpdate> {
  /** Scope every search is bound to. */
  scope: Scope;
  /** Extract the search query from current state. */
  getQuery: (state: TState) => string;
  /**
   * Build the partial-state update that exposes the rendered
   * context to downstream nodes. Called with `null` when no
   * memories matched so the node can still record an explicit
   * "nothing found" outcome if desired.
   */
  applyContext: (state: TState, context: string | null) => TUpdate;
  /** Maximum memories to retrieve (default 5). */
  limit?: number;
  /** Override how memories are rendered into the context block. */
  formatter?: (results: readonly SearchResult[]) => string;
}

export interface CreateMemoryIngestNodeOptions<TState, TUpdate> {
  scope: Scope;
  /** Extract the message transcript to ingest. */
  getMessages: (state: TState) => readonly Message[];
  /** Extract the assistant completion text. */
  getCompletion: (state: TState) => string;
  /**
   * Optional state update emitted after a successful ingest.
   * Defaults to `{}` - most graphs don't want the ingest node
   * to mutate state. Use this when you want to surface
   * AUDN-result counters on a state channel.
   */
  applyIngestResult?: (state: TState, result: IngestResult) => TUpdate;
  /** Roles to include (default `['user', 'assistant', 'tool']`). */
  includeRoles?: ReadonlyArray<Message['role']>;
}

export type MemoryRetrieveNode<TState, TUpdate> = (state: TState) => Promise<TUpdate>;
export type MemoryIngestNode<TState, TUpdate> = (state: TState) => Promise<TUpdate>;

const EMPTY_UPDATE = Object.freeze({}) as Readonly<Record<string, never>>;

export function createMemoryRetrieveNode<TState, TUpdate>(
  client: MemoryClient,
  opts: CreateMemoryRetrieveNodeOptions<TState, TUpdate>,
): MemoryRetrieveNode<TState, TUpdate> {
  return async (state: TState): Promise<TUpdate> => {
    const query = opts.getQuery(state);
    const result = await searchMemory(client, {
      query,
      scope: opts.scope,
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
      ...(opts.formatter ? { formatter: opts.formatter } : {}),
    });
    return opts.applyContext(state, result.context);
  };
}

export function createMemoryIngestNode<TState, TUpdate>(
  client: MemoryClient,
  opts: CreateMemoryIngestNodeOptions<TState, TUpdate>,
): MemoryIngestNode<TState, TUpdate | Readonly<Record<string, never>>> {
  return async (state: TState): Promise<TUpdate | Readonly<Record<string, never>>> => {
    const result = await ingestTurn(client, {
      messages: opts.getMessages(state),
      completion: opts.getCompletion(state),
      scope: opts.scope,
      ...(opts.includeRoles ? { includeRoles: opts.includeRoles } : {}),
    });
    return opts.applyIngestResult ? opts.applyIngestResult(state, result) : EMPTY_UPDATE;
  };
}
