/**
 * @file Pre-call augmentation — convenience wrapper over `retrieve()`
 *       that prepends the rendered system message to the input array.
 *       Works for text-only conversations. For conversations that
 *       include AI SDK v5 tool-role messages (content = ToolResultPart[]),
 *       use `retrieve()` directly and inject the system message into
 *       your original ModelMessage array yourself.
 */

import type {
  Message,
  MemoryClient,
  Scope,
  SearchResult,
} from '@atomicmemory/sdk';
import { retrieve } from './retrieve.js';

export interface AugmentOptions {
  messages: readonly Message[];
  scope: Scope;
  /** Maximum number of memories to retrieve (default 5). */
  limit?: number;
  /** Override how memories are rendered into the system prompt. */
  formatter?: (results: readonly SearchResult[]) => string;
}

export interface AugmentResult {
  /** `messages` with a system message prepended when memories were found. */
  messages: Message[];
  /** The retrieved memories, for attribution or telemetry. */
  retrieved: readonly SearchResult[];
}

export async function augmentWithMemory(
  client: MemoryClient,
  opts: AugmentOptions,
): Promise<AugmentResult> {
  const { systemMessage, retrieved } = await retrieve(client, {
    messages: opts.messages,
    scope: opts.scope,
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    ...(opts.formatter !== undefined ? { formatter: opts.formatter } : {}),
  });

  if (!systemMessage) {
    return { messages: [...opts.messages], retrieved: [] };
  }
  return { messages: [systemMessage, ...opts.messages], retrieved };
}
