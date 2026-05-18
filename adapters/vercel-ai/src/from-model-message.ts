/**
 * @file Bridge from Vercel AI SDK v5 `ModelMessage` (content-part
 *       arrays) to the SDK's `Message` (text `content: string`).
 *
 *       The AtomicMemory SDK stores memory as text; content parts are
 *       flattened with a lossy, best-effort projection:
 *         - text parts → concatenated verbatim
 *         - tool-call / tool-result parts → JSON-stringified
 *         - image / file parts → replaced with `[image]` / `[file]`
 *           placeholders; raw bytes are never stored
 *
 *       If you need richer handling, skip this helper and build your
 *       own `Message[]` projection before calling the adapter.
 */

import type { Message } from '@atomicmemory/sdk';

/**
 * Structural shape matching AI SDK v5 `ModelMessage`. Kept local so
 * the adapter does not import from `ai` — avoids version coupling.
 */
export interface ModelMessageLike {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | ReadonlyArray<ModelMessagePartLike>;
}

export type ModelMessagePartLike =
  | { type: 'text'; text: string }
  | { type: 'image'; image?: unknown }
  | { type: 'file'; mediaType?: string; filename?: string }
  | { type: 'tool-call'; toolCallId?: string; toolName: string; args?: unknown }
  | { type: 'tool-result'; toolCallId?: string; toolName: string; output?: unknown }
  | { type: string; [key: string]: unknown };

function renderPart(part: ModelMessagePartLike): string {
  switch (part.type) {
    case 'text':
      return typeof part.text === 'string' ? part.text : '';
    case 'image':
      return '[image]';
    case 'file': {
      const name = typeof part.filename === 'string' ? part.filename : 'file';
      return `[file: ${name}]`;
    }
    case 'tool-call':
      return `[tool-call ${part.toolName}${tag(part.toolCallId)}]${safeJson(part.args)}`;
    case 'tool-result':
      return `[tool-result ${part.toolName}${tag(part.toolCallId)}]${safeJson(part.output)}`;
    default:
      return `[${part.type}]`;
  }
}

function tag(toolCallId: unknown): string {
  return typeof toolCallId === 'string' && toolCallId.length > 0
    ? ` id=${toolCallId}`
    : '';
}

function safeJson(value: unknown): string {
  if (value === undefined) return '';
  try {
    return ` ${JSON.stringify(value)}`;
  } catch {
    return ' [unserializable]';
  }
}

/**
 * Flatten a single `ModelMessage` to the SDK's `Message` shape.
 */
export function fromModelMessage(m: ModelMessageLike): Message {
  const content =
    typeof m.content === 'string'
      ? m.content
      : m.content.map(renderPart).join('\n');
  return { role: m.role, content };
}

/**
 * Flatten an array of `ModelMessage`s.
 */
export function fromModelMessages(
  messages: ReadonlyArray<ModelMessageLike>,
): Message[] {
  return messages.map(fromModelMessage);
}
