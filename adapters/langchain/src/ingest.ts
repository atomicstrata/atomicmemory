/**
 * @file `ingestTurn()` - persist a completed turn to memory.
 *       Uses the SDK's `messages` ingest mode so AUDN
 *       (add / update / delete / no-op) deduplicates facts
 *       across turns.
 *
 *       System messages are excluded by default because
 *       applications typically use them for hidden
 *       instructions/policies that should never become durable
 *       memory. Callers can opt in via `includeRoles`.
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
  /**
   * Roles from `messages` to include. The assistant completion is
   * always appended regardless of this list. Default:
   * `['user', 'assistant', 'tool']` - system messages are excluded
   * because they typically contain application policy not user
   * content.
   */
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
