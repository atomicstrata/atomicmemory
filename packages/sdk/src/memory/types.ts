/**
 * @file V3 Memory Provider Types
 *
 * Core type definitions for the unified MemoryProvider interface.
 * Based on the accepted V3 specification (providers-v3.md).
 *
 * Pure types — no runtime code.
 */

/**
 * Identity and partition context for memory operations.
 * Providers declare which fields they require via capabilities().requiredScope.
 */
export interface Scope {
  user?: string;
  agent?: string;
  namespace?: string;
  thread?: string;
}

/**
 * Reference to a specific memory within a scope.
 */
export interface MemoryRef {
  id: string;
  scope: Scope;
}

/**
 * A single memory unit. Returned by get, list, and as part of SearchResult.
 */
export interface Memory {
  id: string;
  content: string;
  scope: Scope;
  kind?: MemoryKind;
  createdAt: Date;
  updatedAt?: Date;
  provenance?: Provenance;
  metadata?: Record<string, unknown>;
}

export type MemoryKind =
  | 'fact'
  | 'episode'
  | 'summary'
  | 'procedure'
  | 'document';

export interface Provenance {
  source?: string;
  sourceUrl?: string;
  sourceId?: string;
  extractor?: string;
}

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

export type IngestInput = TextIngest | MessageIngest | VerbatimIngest;

export interface IngestBase {
  scope: Scope;
  provenance?: Provenance;
  metadata?: Record<string, unknown>;
}

/** Raw text: conversation transcript, document, note. */
export interface TextIngest extends IngestBase {
  mode: 'text';
  content: string;
}

/** Structured chat messages. */
export interface MessageIngest extends IngestBase {
  mode: 'messages';
  messages: Message[];
}

/**
 * Verbatim storage: bypass LLM extraction and store the content as a
 * single memory record. One input = one memory, deterministic. Use for
 * user-provided context blobs where the fact-extraction pipeline
 * would either over-split the text or, for ambiguous input, produce
 * zero facts and leave the user thinking nothing was saved.
 *
 * Capability-gated: only available when
 * `capabilities().ingestModes` includes 'verbatim'.
 */
export interface VerbatimIngest extends IngestBase {
  mode: 'verbatim';
  content: string;
  kind?: MemoryKind;
  metadata?: Record<string, unknown>;
}

export interface Message {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  name?: string;
}

export interface IngestResult {
  created: string[];
  updated: string[];
  unchanged: string[];
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface SearchRequest {
  query: string;
  scope: Scope;
  limit?: number;
  threshold?: number;
  filter?: FilterExpr;
  reranker?: string;
}

export interface SearchResult {
  memory: Memory;
  /**
   * Backward-compatible provider score.
   * For AtomicMemory this is the composite ranking score (`rankingScore`) and
   * is not normalized. New consumers should prefer the explicit fields below.
   * Other providers preserve their historical score semantics.
   */
  score: number;
  /** Semantic/vector similarity when the provider exposes it. Higher is better. */
  similarity?: number;
  /** Composite ranking/debug score. Not guaranteed to be normalized. */
  rankingScore?: number;
  /** Normalized injection relevance in [0, 1], suitable for threshold checks. */
  relevance?: number;
}

export interface SearchResultPage {
  results: SearchResult[];
  cursor?: string;
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

export type FilterExpr =
  | { and: FilterExpr[] }
  | { or: FilterExpr[] }
  | { not: FilterExpr }
  | FieldFilter;

export interface FieldFilter {
  field: string;
  op:
    | 'eq'
    | 'neq'
    | 'gt'
    | 'gte'
    | 'lt'
    | 'lte'
    | 'in'
    | 'contains'
    | 'exists';
  value?: string | number | boolean | Date | Array<string | number>;
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export interface ListRequest {
  scope: Scope;
  limit?: number;
  cursor?: string;
  filter?: FilterExpr;
}

export interface ListResultPage {
  memories: Memory[];
  cursor?: string;
}

// ---------------------------------------------------------------------------
// Context Packaging
// ---------------------------------------------------------------------------

export interface PackageRequest extends SearchRequest {
  tokenBudget?: number;
  format?: 'flat' | 'tiered' | 'structured';
}

/**
 * Injection-ready context for an AI assistant.
 * `text` is the formatted string for prompt injection.
 * `results` tracks what contributed (for debugging and attribution).
 * `budgetConstrained` is true when the requested token budget shaped
 * the package — either eligible memories were omitted entirely or
 * eligible richer detail (L1/L2 tier, query-term-revealing upgrades)
 * was suppressed solely because the budget could not afford it.
 * Quota-driven demotion (e.g. fixed-cap policy) is NOT flagged.
 * Powers the v5 CLI envelope's `meta.budget_constrained` field.
 */
export interface ContextPackage {
  text: string;
  results: SearchResult[];
  tokens: number;
  budgetConstrained: boolean;
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

export interface Capabilities {
  ingestModes: Array<IngestInput['mode']>;

  requiredScope: {
    default: Array<keyof Scope>;
    ingest?: Array<keyof Scope>;
    search?: Array<keyof Scope>;
    get?: Array<keyof Scope>;
    delete?: Array<keyof Scope>;
    list?: Array<keyof Scope>;
    update?: Array<keyof Scope>;
    package?: Array<keyof Scope>;
    temporal?: Array<keyof Scope>;
    graph?: Array<keyof Scope>;
    forget?: Array<keyof Scope>;
    profile?: Array<keyof Scope>;
    reflect?: Array<keyof Scope>;
    versioning?: Array<keyof Scope>;
    batch?: Array<keyof Scope>;
  };

  extensions: {
    update: boolean;
    package: boolean;
    temporal: boolean;
    graph: boolean;
    forget: boolean;
    profile: boolean;
    reflect: boolean;
    versioning: boolean;
    batch: boolean;
    health: boolean;
  };

  customExtensions?: Record<
    string,
    { version?: string; description?: string }
  >;

  supportedRerankers?: string[];
  supportedFilterOps?: FieldFilter['op'][];
  maxTokenBudget?: number;
}

// ---------------------------------------------------------------------------
// Extension-specific types
// ---------------------------------------------------------------------------

export interface GraphSearchRequest {
  query: string;
  scope: Scope;
  limit?: number;
  graphScope?: 'nodes' | 'edges' | 'episodes';
  reranker?: string;
}

export interface GraphResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface GraphNode {
  id: string;
  label: string;
  summary?: string;
  score?: number;
}

export interface GraphEdge {
  id: string;
  fact: string;
  from: string;
  to: string;
  validAt?: Date;
  invalidAt?: Date;
  score?: number;
}

export interface Profile {
  summary: string;
  facts?: string[];
  updatedAt?: Date;
}

export interface Insight {
  content: string;
  confidence: number;
  supportingMemoryIds: string[];
}

export interface MemoryVersion {
  id: string;
  content: string;
  createdAt: Date;
  parentId?: string;
  event: 'created' | 'updated' | 'superseded' | 'invalidated';
}

export interface HealthStatus {
  ok: boolean;
  latencyMs?: number;
  version?: string;
}
