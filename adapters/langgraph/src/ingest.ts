/**
 * @file `ingestTurn()` - persist a completed turn to memory.
 *       Uses the SDK's `messages` ingest mode so AUDN
 *       deduplicates facts across turns.
 *
 *       System messages are excluded by default (applications
 *       typically use them for hidden instructions/policies).
 */

import type {
  IngestResult,
  Message,
  MemoryClient,
  Scope,
} from '@atomicmemory/sdk';

export interface IngestTurnOptions {
  messages: readonly Message[];
  /** The assistant's response text - appended as a final assistant message. */
  completion: string;
  scope: Scope;
  /** Roles to include. Default `['user', 'assistant', 'tool']`. */
  includeRoles?: ReadonlyArray<Message['role']>;
}

const DEFAULT_ROLES: ReadonlyArray<Message['role']> = ['user', 'assistant', 'tool'];

export async function ingestTurn(
  client: MemoryClient,
  opts: IngestTurnOptions,
): Promise<IngestResult> {
  const allowed = new Set(opts.includeRoles ?? DEFAULT_ROLES);
  const filtered = opts.messages.filter((m) => allowed.has(m.role));
  const assistant: Message = { role: 'assistant', content: opts.completion };
  return client.ingest({
    mode: 'messages',
    messages: [...filtered, assistant],
    scope: opts.scope,
  });
}
