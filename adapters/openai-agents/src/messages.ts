/**
 * @file Helpers for converting OpenAI Agents SDK input/result shapes
 *       into AtomicMemory's text-only Message shape.
 */

import { user } from '@openai/agents';
import type { AgentInputItem } from '@openai/agents';
import type { Message } from '@atomicmemory/sdk';

export type AgentInputLike = string | readonly AgentInputItem[];

export interface RunResultLike {
  finalOutput?: unknown;
}

export function normalizeAgentInput(input: AgentInputLike): AgentInputItem[] {
  if (typeof input === 'string') return [user(input) as AgentInputItem];
  return [...input];
}

export function agentInputToMessages(input: AgentInputLike): Message[] {
  return normalizeAgentInput(input).flatMap((item) => {
    const role = roleFromItem(item);
    if (!role) return [];

    const text = textFromContent((item as { content?: unknown }).content);
    if (!text) return [];
    return [{ role, content: text }];
  });
}

export function agentInputToText(input: AgentInputLike): string {
  const messages = agentInputToMessages(input);
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === 'user') return message.content;
  }
  return messages[messages.length - 1]?.content ?? '';
}

export function resultOutputToText(result: RunResultLike | unknown): string {
  if (typeof result === 'string') return result;
  if (!isRecord(result) || !('finalOutput' in result)) return '';

  const output = result.finalOutput;
  if (typeof output === 'string') return output;
  if (output === null || output === undefined) return '';
  return JSON.stringify(output);
}

function roleFromItem(item: AgentInputItem): Message['role'] | null {
  const role = (item as { role?: unknown }).role;
  if (
    role === 'user' ||
    role === 'assistant' ||
    role === 'system' ||
    role === 'tool'
  ) {
    return role;
  }
  return null;
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content
    .map((part) => {
      if (!isRecord(part)) return '';
      if (typeof part.text === 'string') return part.text;
      if (typeof part.transcript === 'string') return part.transcript;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
