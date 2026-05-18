/**
 * @file Response Mappers for Mem0 Provider
 *
 * Maps raw Mem0 API JSON responses to V3 SDK types.
 * Mem0 returns memories with `memory` field (text content)
 * and `metadata` containing caller-supplied context.
 */

import type {
  Memory,
  SearchResult,
  IngestResult,
  IngestInput,
  Scope,
} from '../types';
import type { Mem0ProviderConfig } from './types';

/**
 * Unwrap a Mem0 list-response that may be a bare array (hosted API) or
 * `{results: [...]}` (OSS/self-hosted). Returns the array in both
 * cases; returns empty on unrecognized shapes.
 */
export function unwrapMem0Array<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[];
  if (raw && typeof raw === 'object' && 'results' in raw) {
    const wrapped = (raw as Record<string, unknown>).results;
    if (Array.isArray(wrapped)) return wrapped as T[];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Raw Mem0 API shapes
// ---------------------------------------------------------------------------

/**
 * Shape returned by POST /v1/memories/ (single entry in array).
 *
 * mem0 2.0 nests memory text under `data.memory` on async ADD/UPDATE/DELETE
 * events, while legacy responses and search hits keep it flat at `memory`.
 * Both shapes are tolerated for forward/backward compatibility.
 */
interface RawMem0Memory {
  id: string;
  memory?: string;
  data?: { memory?: string };
  event?: string;
  metadata?: Record<string, unknown>;
  user_id?: string;
  created_at?: string;
  updated_at?: string;
}

/** Shape returned by POST /v2/memories/search/ (single entry in array) */
interface RawMem0SearchResult {
  id: string;
  memory: string;
  score?: number;
  metadata?: Record<string, unknown>;
  user_id?: string;
  created_at?: string;
  updated_at?: string;
}

/** Extract memory text from either the flat or nested v2 event envelope. */
function extractMemoryText(raw: RawMem0Memory): string {
  return raw.memory ?? raw.data?.memory ?? '';
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

export function toMemory(raw: RawMem0Memory, scope: Scope): Memory {
  return {
    id: raw.id,
    content: extractMemoryText(raw),
    scope,
    createdAt: raw.created_at ? new Date(raw.created_at) : new Date(),
    updatedAt: raw.updated_at ? new Date(raw.updated_at) : undefined,
    metadata: raw.metadata,
  };
}

export function toSearchResult(raw: RawMem0SearchResult, scope: Scope): SearchResult {
  return {
    memory: toMemory(raw, scope),
    score: raw.score ?? 0,
  };
}

export function toIngestResult(
  rawMemories: RawMem0Memory[]
): IngestResult {
  const created: string[] = [];
  const updated: string[] = [];
  const unchanged: string[] = [];

  for (const mem of rawMemories) {
    switch (mem.event) {
      case 'ADD':
        created.push(mem.id);
        break;
      case 'UPDATE':
        updated.push(mem.id);
        break;
      case 'NONE':
      case 'NOOP':
        unchanged.push(mem.id);
        break;
      default:
        // Unknown event — treat as created
        created.push(mem.id);
    }
  }

  return { created, updated, unchanged };
}

/**
 * Resolve the effective infer flag for an ingest operation.
 * Checks per-request metadata first, then config default, then true.
 */
export function resolveInferFlag(
  input: IngestInput,
  config: Mem0ProviderConfig
): boolean {
  const metadata = 'metadata' in input ? input.metadata : undefined;
  return (metadata?.infer as boolean | undefined) ?? config.defaultInfer ?? true;
}

/**
 * Build the request body for Mem0's POST /v1/memories/ endpoint.
 *
 * Reads `input.metadata?.infer` for per-request inference control,
 * falling back to `config.defaultInfer` (default true).
 */
export function buildIngestBody(
  input: IngestInput,
  userId: string,
  config: Mem0ProviderConfig
): Record<string, unknown> {
  const metadata = 'metadata' in input ? input.metadata : undefined;
  const infer = resolveInferFlag(input, config);

  // Strip `infer` from metadata before sending to Mem0
  const cleanMetadata = metadata
    ? Object.fromEntries(
        Object.entries(metadata).filter(([k]) => k !== 'infer')
      )
    : undefined;

  const body: Record<string, unknown> = {
    user_id: userId,
    infer,
  };

  if (cleanMetadata && Object.keys(cleanMetadata).length > 0) {
    body.metadata = cleanMetadata;
  }

  if (input.mode === 'text') {
    body.messages = [{ role: 'user', content: input.content }];
  } else if (input.mode === 'messages') {
    body.messages = input.messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));
  }
  // Note: `mode === 'verbatim'` never reaches this function — doIngest
  // throws UnsupportedOperationError before calling buildIngestBody,
  // because Mem0 doesn't honor the verbatim contract. See the comment
  // on capabilities() in mem0-provider.ts.

  applyEnterpriseFields(body, config);
  applyScopeIdentifiers(body, input.scope);

  return body;
}

/**
 * Build the request body for mem0 2.0's POST /v2/memories/search/ endpoint.
 *
 * Scope identifiers go inside a nested `filters` object per v2's contract:
 *   { query, filters: { user_id, agent_id?, run_id? }, org_id?, project_id?, limit? }
 *
 * V3 Scope mapping:
 * - scope.user   → filters.user_id
 * - scope.agent  → filters.agent_id
 * - scope.thread → filters.run_id  (mem0's conversation identifier)
 *
 * `scope.namespace` has no analog in mem0 v2 and is not forwarded.
 */
export function buildSearchBody(
  query: string,
  scope: Scope,
  config: Mem0ProviderConfig,
  limit?: number,
): Record<string, unknown> {
  const filters: Record<string, unknown> = {};
  if (scope.user) filters.user_id = scope.user;
  if (scope.agent) filters.agent_id = scope.agent;
  if (scope.thread) filters.run_id = scope.thread;

  const body: Record<string, unknown> = {
    query,
    filters,
  };
  if (limit !== undefined) body.limit = limit;

  applyEnterpriseFields(body, config);

  return body;
}

/** Attach optional enterprise scoping fields (mem0 2.0+) at the top level. */
function applyEnterpriseFields(
  body: Record<string, unknown>,
  config: Mem0ProviderConfig,
): void {
  if (config.orgId) body.org_id = config.orgId;
  if (config.projectId) body.project_id = config.projectId;
}

/** Attach V3 scope identifiers to the top-level ingest body per mem0's conventions. */
function applyScopeIdentifiers(
  body: Record<string, unknown>,
  scope: Scope,
): void {
  if (scope.agent) body.agent_id = scope.agent;
  if (scope.thread) body.run_id = scope.thread;
}
