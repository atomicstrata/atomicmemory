/**
 * @file Semantic Search Types
 */

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface SemanticSearchResult {
  id: string;
  content: string;
  score: number;
  metadata?: Record<string, JsonValue>;
  embedding?: number[];
  version?: string;
  timestamp?: number;
  rank?: number;
}

export interface SearchOptions {
  topK?: number;
  threshold?: number;
  includeEmbeddings?: boolean;
  filter?: (item: StoredContext) => boolean;
  rerank?: boolean;
  maxResults?: number;
  version?: string;
  sortBy?: 'score' | 'timestamp' | 'relevance' | string;
  extras?: Record<string, JsonValue>;
}

export interface StoredContext {
  id: string;
  content: string;
  embedding: number[];
  metadata?: Record<string, JsonValue>;
  timestamp: number;
  userId?: string;
}

export interface SearchConfig {
  defaultTopK: number;
  defaultThreshold: number;
  maxResults: number;
  enableCaching: boolean;
  cacheTimeout: number;
  rerankingEnabled: boolean;
  version?: string;
  defaultSortBy?: string;
  extras?: Record<string, JsonValue>;
}

export interface SearchCache {
  query: string;
  results: SemanticSearchResult[];
  timestamp: number;
  options: ResolvedSearchOptions;
}

/**
 * SearchOptions merged with defaults and materialized once per request.
 * Every downstream pipeline method consumes this flat shape — no more
 * ad-hoc subsets or `ReturnType<typeof buildSearchOptions>` coupling.
 */
export interface ResolvedSearchOptions {
  topK: number;
  threshold: number;
  includeEmbeddings: boolean;
  filter?: (item: StoredContext) => boolean;
  rerank: boolean;
}

type RankItem = Pick<
  SemanticSearchResult,
  'id' | 'content' | 'metadata' | 'embedding' | 'version' | 'timestamp'
>;

export interface RawResult {
  item: RankItem;
  score: number;
  metadata?: Record<string, JsonValue>;
}

export interface RankedResult {
  item: RankItem;
  score: number;
  rank: number;
  metadata?: Record<string, JsonValue>;
}
