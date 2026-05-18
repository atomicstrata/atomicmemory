/**
 * @file Hindsight Provider Request and Response Mappers
 *
 * Converts SDK memory provider inputs into Hindsight retain/recall requests
 * and maps Hindsight memory wire objects back into SDK `Memory` and
 * `SearchResult` values. Unknown provider fields are preserved in metadata
 * where they may help debugging without expanding the SDK's backend-agnostic
 * public model.
 */

import type {
  IngestInput,
  Message,
  Memory,
  MemoryKind,
  Scope,
  SearchResult,
} from '../types';
import type {
  HindsightProviderConfig,
  HindsightRecallBudget,
  HindsightRetainItem,
  HindsightRetainRequest,
} from './types';
import {
  HINDSIGHT_DEFAULT_MAX_TOKENS,
  HINDSIGHT_SCOPE_TAGS_MATCH,
} from './types';

export interface HindsightRecallRequestBody {
  query: string;
  max_tokens?: number;
  budget?: HindsightRecallBudget;
  tags?: string[];
  tags_match?: string;
}

interface RawHindsightMemory {
  id?: string;
  text?: string;
  type?: string;
  context?: string | null;
  metadata?: Record<string, unknown> | null;
  tags?: string[] | null;
  entities?: string[] | null;
  occurred_start?: string | null;
  occurred_end?: string | null;
  mentioned_at?: string | null;
  created_at?: string | null;
  date?: string | null;
  updated_at?: string | null;
}

export function bankIdForScope(scope: Scope): string {
  return scope.user ?? '';
}

export function tagsForScope(scope: Scope): string[] {
  return [
    scope.agent ? `agent:${scope.agent}` : undefined,
    scope.namespace ? `namespace:${scope.namespace}` : undefined,
    scope.thread ? `thread:${scope.thread}` : undefined,
  ].filter((tag): tag is string => tag !== undefined);
}

export function buildRetainRequest(input: IngestInput): HindsightRetainRequest {
  return {
    items: [buildRetainItem(input)],
    async: false,
  };
}

export function buildRecallRequest(
  query: string,
  scope: Scope,
  config: HindsightProviderConfig,
  maxTokens?: number,
): HindsightRecallRequestBody {
  const tags = tagsForScope(scope);
  return {
    query,
    max_tokens:
      maxTokens ?? config.defaultMaxTokens ?? HINDSIGHT_DEFAULT_MAX_TOKENS,
    budget: config.defaultBudget,
    ...(tags.length > 0
      ? { tags, tags_match: HINDSIGHT_SCOPE_TAGS_MATCH }
      : {}),
  };
}

export function unwrapResults(raw: unknown): Record<string, unknown>[] {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Hindsight recall response missing results array');
  }
  const results = (raw as Record<string, unknown>).results;
  if (Array.isArray(results)) return results as Record<string, unknown>[];
  throw new Error('Hindsight recall response missing results array');
}

export function toMemory(raw: Record<string, unknown>, scope: Scope): Memory {
  const memory = raw as RawHindsightMemory;
  const id = requireString(memory.id, 'id');
  return {
    id,
    content: requireString(memory.text, `text for memory ${id}`),
    scope,
    kind: mapMemoryKind(memory.type),
    createdAt: parseMemoryDate(memory),
    updatedAt: memory.updated_at ? new Date(memory.updated_at) : undefined,
    metadata: buildMetadata(memory),
  };
}

export function toSearchResult(
  raw: Record<string, unknown>,
  scope: Scope,
): SearchResult {
  return {
    memory: toMemory(raw, scope),
    score: 0,
  };
}

export function messagesToTranscript(messages: Message[]): string {
  return messages
    .map((message) => `${message.role}: ${message.content}`)
    .join('\n');
}

export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}

function buildRetainItem(input: IngestInput): HindsightRetainItem {
  const metadata = buildIngestMetadata(input);
  return {
    content:
      input.mode === 'messages'
        ? messagesToTranscript(input.messages)
        : input.content,
    context: input.provenance?.source,
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    tags: tagsForScope(input.scope),
  };
}

function buildIngestMetadata(input: IngestInput): Record<string, unknown> {
  return {
    ...(input.metadata ?? {}),
    ...(input.provenance?.source ? { source: input.provenance.source } : {}),
    ...(input.provenance?.sourceUrl
      ? { sourceUrl: input.provenance.sourceUrl }
      : {}),
    ...(input.provenance?.sourceId
      ? { sourceId: input.provenance.sourceId }
      : {}),
  };
}

function buildMetadata(memory: RawHindsightMemory): Memory['metadata'] {
  const metadata: Record<string, unknown> = { ...(memory.metadata ?? {}) };
  if (memory.type !== undefined) metadata.hindsightType = memory.type;
  if (memory.context != null) metadata.context = memory.context;
  if (memory.tags != null) metadata.tags = memory.tags;
  if (memory.entities != null) metadata.entities = memory.entities;
  if (memory.occurred_start != null) {
    metadata.occurredStart = memory.occurred_start;
  }
  if (memory.occurred_end != null) metadata.occurredEnd = memory.occurred_end;
  if (memory.mentioned_at != null) metadata.mentionedAt = memory.mentioned_at;
  if (memory.date != null) metadata.hindsightDate = memory.date;
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function mapMemoryKind(type: string | undefined): MemoryKind | undefined {
  switch (type) {
    case 'world':
      return 'fact';
    case 'experience':
      return 'episode';
    case 'observation':
      return 'summary';
    default:
      return undefined;
  }
}

function parseMemoryDate(memory: RawHindsightMemory): Date {
  const value = memory.created_at ?? memory.mentioned_at ?? memory.date;
  if (value) return new Date(value);
  throw new Error(
    `Hindsight memory ${memory.id ?? '<unknown>'} missing timestamp field`,
  );
}

function requireString(value: unknown, field: string): string {
  if (typeof value === 'string' && value.length > 0) return value;
  throw new Error(`Hindsight response missing required ${field}`);
}
