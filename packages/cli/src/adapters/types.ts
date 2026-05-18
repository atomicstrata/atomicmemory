/**
 * @file CLI-facing provider adapter interface. Command handlers (Phase 5)
 * depend ONLY on this interface; concrete adapters wrap the SDK and
 * translate every shape to/from CLI types here.
 *
 * Per v5 §"Provider Adapter": the V1 minimum is getStatus,
 * getCapabilities, addMemory, searchMemories, listMemories, getMemory,
 * deleteMemory; packageContext is V1 but capability-gated (Mem0 throws
 * unsupported_capability). ingestMemories supports the multi-mode
 * `atomicmemory ingest` command on AtomicMemory only (Mem0 throws
 * unsupported_capability for verbatim).
 *
 * Inputs use the CLI canonical scope (CliScope, with agent_id). Outputs
 * use CLI shapes — no SDK type ever crosses this boundary. The AST
 * scan asserts that no module outside src/adapters/* imports the SDK.
 */

import type { CliScope } from '../types.js';
import type { ProviderCapabilities } from '../types.js';

type AdapterProviderName = 'atomicmemory' | 'mem0';

export interface AdapterStatus {
  ok: boolean;
  provider: AdapterProviderName;
  /** Human-readable detail; renderers may show or sanitize as needed. */
  detail?: string;
}

export interface AdapterProvenance {
  source?: string;
  sourceUrl?: string;
  sourceId?: string;
  extractor?: string;
}

export interface AdapterMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  name?: string;
}

type AdapterIngestMode = 'text' | 'messages' | 'verbatim';
export type AdapterMemoryKind =
  | 'fact'
  | 'episode'
  | 'summary'
  | 'procedure'
  | 'document';

export interface AdapterAddInput {
  text: string;
  scope: CliScope;
  metadata?: Record<string, unknown>;
  provenance?: AdapterProvenance;
}

export interface AdapterIngestInput {
  mode: AdapterIngestMode;
  scope: CliScope;
  /** Required when mode is 'text' or 'verbatim'. */
  text?: string;
  /** Required when mode is 'messages'. */
  messages?: AdapterMessage[];
  /** Optional override for verbatim ingestion. */
  kind?: AdapterMemoryKind;
  metadata?: Record<string, unknown>;
  provenance?: AdapterProvenance;
}

export interface AdapterIngestResult {
  created: string[];
  updated: string[];
  unchanged: string[];
}

export interface AdapterSearchInput {
  query: string;
  scope: CliScope;
  limit?: number;
  /** Already zod-validated FilterExpr JSON; passed through opaquely. */
  filterJson?: unknown;
  reranker?: string;
}

export interface AdapterMemorySummary {
  id: string;
  content: string;
  scope: CliScope;
  kind?: AdapterMemoryKind;
  createdAt: string;
  updatedAt?: string;
  metadata?: Record<string, unknown>;
  provenance?: AdapterProvenance;
}

export interface AdapterSearchHit {
  memory: AdapterMemorySummary;
  score: number;
  similarity?: number;
  rankingScore?: number;
  relevance?: number;
}

export interface AdapterListInput {
  scope: CliScope;
  limit?: number;
  cursor?: string;
}

export interface AdapterListResult {
  memories: AdapterMemorySummary[];
  cursor?: string;
}

export interface AdapterRefInput {
  id: string;
  scope: CliScope;
}

export interface AdapterPackageInput extends AdapterSearchInput {
  tokenBudget?: number;
  format?: 'flat' | 'tiered' | 'structured';
}

export interface AdapterContextPackage {
  text: string;
  tokens: number;
  hits: AdapterSearchHit[];
  budgetConstrained: boolean;
}

export interface ProviderAdapter {
  readonly providerName: AdapterProviderName;
  /** Idempotent. Adapters call this lazily on first use. */
  initialize(): Promise<void>;
  getStatus(): Promise<AdapterStatus>;
  getCapabilities(): Promise<ProviderCapabilities>;
  addMemory(input: AdapterAddInput): Promise<AdapterIngestResult>;
  ingestMemories(input: AdapterIngestInput): Promise<AdapterIngestResult>;
  searchMemories(input: AdapterSearchInput): Promise<AdapterSearchHit[]>;
  listMemories(input: AdapterListInput): Promise<AdapterListResult>;
  getMemory(input: AdapterRefInput): Promise<AdapterMemorySummary | null>;
  deleteMemory(input: AdapterRefInput): Promise<void>;
  /**
   * Capability-gated: only valid when
   * `getCapabilities().extensions.package === true`. Mem0 throws
   * CliError('unsupported_capability') exit 2 from this method.
   */
  packageContext(input: AdapterPackageInput): Promise<AdapterContextPackage>;
}
