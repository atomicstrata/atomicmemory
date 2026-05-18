/**
 * @file Post-run memory ingestion for OpenAI Agents SDK runs.
 */

import type {
  IngestResult,
  Message,
  MemoryClient,
  Provenance,
  Scope,
} from '@atomicmemory/sdk';
import {
  type AgentInputLike,
  type RunResultLike,
  agentInputToMessages,
  resultOutputToText,
} from './messages.js';

export interface IngestAgentTurnOptions {
  input: AgentInputLike;
  /**
   * Agents SDK `RunResult`, or any object with `finalOutput`.
   * Ignored when `output` is supplied directly.
   */
  result?: RunResultLike | unknown;
  /** Explicit assistant output text. Use this for streamed results after `completed`. */
  output?: string;
  scope: Scope;
  /**
   * Roles from the original input to include. The assistant output is
   * always appended as a trailing assistant message.
   * Default: `['user', 'assistant', 'tool']`.
   */
  includeRoles?: ReadonlyArray<Message['role']>;
  metadata?: Record<string, unknown>;
  provenance?: Provenance;
}

const DEFAULT_ROLES: ReadonlyArray<Message['role']> = ['user', 'assistant', 'tool'];

export async function ingestAgentTurn(
  client: MemoryClient,
  opts: IngestAgentTurnOptions,
): Promise<IngestResult> {
  const completion = opts.output ?? resultOutputToText(opts.result);
  if (!completion) {
    throw new Error(
      'ingestAgentTurn: assistant output is required — pass `output` or a result with `finalOutput`',
    );
  }

  const allowed = new Set(opts.includeRoles ?? DEFAULT_ROLES);
  const messages = agentInputToMessages(opts.input).filter((message) =>
    allowed.has(message.role),
  );

  return client.ingest({
    mode: 'messages',
    messages: [...messages, { role: 'assistant', content: completion }],
    scope: opts.scope,
    ...(opts.metadata !== undefined ? { metadata: opts.metadata } : {}),
    ...(opts.provenance !== undefined ? { provenance: opts.provenance } : {}),
  });
}
