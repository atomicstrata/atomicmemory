/**
 * @file Semantic Search
 *
 * End-to-end semantic search orchestration using embeddings and ranking.
 * Provides high-level search interface with caching, filtering, and ranking.
 */

import { EmbeddingGenerator } from '../embedding/embedding-generator';
import { StorageManager } from '../kv-cache/storage-manager';
import { batchCosineSimilarity } from './similarity-calculator';
import { rankBySimilarity } from './ranking-algorithms';
import { SearchError, AtomicMemoryError } from '../core/error-handling/errors';
import { withRetry } from '../core/error-handling/retry';
import { EventEmitter } from '../core/events';
import type { EventMap } from '../core/events';
import type {
  SemanticSearchResult,
  SearchOptions,
  SearchConfig,
  StoredContext,
  SearchCache,
  ResolvedSearchOptions,
  RawResult,
  RankedResult,
} from './semantic-search/types';

export class SemanticSearch {
  private embeddingGenerator: EmbeddingGenerator;
  private storageManager: StorageManager;
  private eventEmitter?: EventEmitter;
  private config: SearchConfig;
  private searchCache = new Map<string, SearchCache>();

  constructor(
    embeddingGenerator: EmbeddingGenerator,
    storageManager: StorageManager,
    config: Partial<SearchConfig> = {},
    eventEmitter?: EventEmitter
  ) {
    this.embeddingGenerator = embeddingGenerator;
    this.storageManager = storageManager;
    this.eventEmitter = eventEmitter;

    const defaultConfig: SearchConfig = {
      defaultTopK: 10,
      defaultThreshold: 0.1,
      maxResults: 100,
      enableCaching: true,
      cacheTimeout: 5 * 60 * 1000,
      rerankingEnabled: true,
      version: '1.0',
      defaultSortBy: 'score',
    };

    this.config = { ...defaultConfig, ...config };
  }

  async search(
    query: string,
    options: SearchOptions = {},
    signal?: AbortSignal
  ): Promise<SemanticSearchResult[]> {
    this.checkAbort(signal);
    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      throw new SearchError('Invalid search query', 'INVALID_QUERY');
    }

    const resolved = this.resolveOptions(options);
    const startTime = Date.now();

    try {
      if (this.config.enableCaching) {
        const cached = this.getCachedResults(query, resolved);
        if (cached) {
          this.emitSearchEvent('searchCacheHit', {
            query,
            resultCount: cached.length,
          });
          return cached;
        }
      }

      this.checkAbort(signal);
      const queryEmbedding = await this.generateQueryEmbedding(query);

      this.checkAbort(signal);
      const { contexts, filteredContexts } = await this.fetchAndFilterContexts(
        resolved,
        query
      );
      if (contexts.length === 0 || filteredContexts.length === 0) {
        return [];
      }

      this.checkAbort(signal);
      const rawResults = this.computeRawResults(
        queryEmbedding.embedding,
        filteredContexts,
        resolved
      );

      const rankedResults = this.rankRawResults(rawResults, resolved);

      let results = this.mapRankedToResults(rankedResults);

      if (resolved.rerank && results.length > 1) {
        this.checkAbort(signal);
        results = await this.rerankResults(query, results);
      }

      if (this.config.enableCaching) {
        this.cacheResults(query, results, resolved);
      }

      const searchTime = Date.now() - startTime;
      this.emitSearchEvent('searchCompleted', {
        query,
        resultCount: results.length,
        totalContexts: contexts.length,
        filteredContexts: filteredContexts.length,
        searchTime,
        averageScore:
          results.length > 0
            ? results.reduce((sum, r) => sum + r.score, 0) / results.length
            : 0,
      });

      return results;
    } catch (error) {
      this.emitSearchEvent('searchError', {
        query,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private checkAbort(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new SearchError('Search aborted', 'ABORTED');
    }
  }

  private resolveOptions(options: SearchOptions): ResolvedSearchOptions {
    // maxResults takes precedence over topK; both are clamped to config.maxResults
    const effectiveTopK = Math.min(
      options.maxResults || options.topK || this.config.defaultTopK,
      this.config.maxResults
    );

    return {
      topK: effectiveTopK,
      threshold: options.threshold || this.config.defaultThreshold,
      includeEmbeddings: options.includeEmbeddings || false,
      filter: options.filter,
      rerank: options.rerank ?? this.config.rerankingEnabled,
    };
  }

  private async generateQueryEmbedding(query: string) {
    return withRetry(() => this.embeddingGenerator.generateEmbedding(query), {
      maxAttempts: 3,
    });
  }

  private async fetchAndFilterContexts(
    resolved: ResolvedSearchOptions,
    query: string
  ): Promise<{ contexts: StoredContext[]; filteredContexts: StoredContext[] }> {
    const contexts = await this.getStoredContexts();
    if (contexts.length === 0) {
      this.emitSearchEvent('searchNoContexts', { query });
      return { contexts, filteredContexts: [] };
    }

    const filteredContexts = resolved.filter
      ? contexts.filter(resolved.filter)
      : contexts;

    if (filteredContexts.length === 0) {
      this.emitSearchEvent('searchNoResults', {
        query,
        totalContexts: contexts.length,
      });
    }
    return { contexts, filteredContexts };
  }

  private computeRawResults(
    queryEmbedding: number[],
    filteredContexts: StoredContext[],
    resolved: ResolvedSearchOptions
  ): RawResult[] {
    const similarities = batchCosineSimilarity(
      queryEmbedding,
      filteredContexts.map(ctx => ctx.embedding)
    );

    return filteredContexts.map((context, index) => ({
      item: {
        id: context.id,
        content: context.content,
        metadata: context.metadata,
        embedding: resolved.includeEmbeddings ? context.embedding : undefined,
        version: this.config.version || '1.0',
        timestamp: context.timestamp,
      },
      score: similarities[index],
      metadata: context.metadata,
    }));
  }

  private rankRawResults(
    rawResults: RawResult[],
    resolved: ResolvedSearchOptions
  ): RankedResult[] {
    return rankBySimilarity(rawResults, {
      tieBreaker: 'metadata',
      normalizeScores: false,
      minScore: resolved.threshold,
      maxResults: resolved.topK,
    }) as RankedResult[];
  }

  private mapRankedToResults(
    rankedResults: RankedResult[]
  ): SemanticSearchResult[] {
    return rankedResults.map(ranked => ({
      ...ranked.item,
      score: ranked.score,
      rank: ranked.rank,
    }));
  }

  async addContext(context: Omit<StoredContext, 'timestamp'>): Promise<void> {
    if (!context || typeof context !== 'object') {
      throw new SearchError(
        'Context must be an object with id and content',
        'INVALID_CONTEXT',
      );
    }
    if (!context.id || !context.content) {
      throw new SearchError(
        'Context must have id and content',
        'INVALID_CONTEXT'
      );
    }

    // Generate embedding if not provided
    let embedding = context.embedding;
    if (!embedding) {
      const result = await this.embeddingGenerator.generateEmbedding(
        context.content
      );
      embedding = result.embedding;
    }

    const storedContext: StoredContext = {
      ...context,
      embedding,
      timestamp: Date.now(),
    };

    await this.storageManager.set(`context:${context.id}`, storedContext);

    // Clear cache when new context is added
    this.clearCache();

    this.emitSearchEvent('searchContextAdded', {
      contextId: context.id,
      contentLength: context.content.length,
    });
  }

  async removeContext(contextId: string): Promise<boolean> {
    const removed = await this.storageManager.delete(`context:${contextId}`);

    if (removed) {
      // Clear cache when context is removed
      this.clearCache();

      this.emitSearchEvent('searchContextRemoved', { contextId });
    }

    return removed;
  }

  async getContext(contextId: string): Promise<StoredContext | null> {
    try {
      return await this.storageManager.get(`context:${contextId}`);
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error));
      // Forward the underlying retryability when the storage layer
      // classified the error (e.g. StorageError with retryable=true from
      // the RetryEngine timeout path). Plain Errors default to false.
      const retryable = error instanceof AtomicMemoryError ? error.retryable : false;
      throw new SearchError(
        `Failed to load context "${contextId}": ${cause.message}`,
        'STORAGE_READ_FAILED',
        undefined,
        retryable,
        cause,
      );
    }
  }

  async listContexts(prefix?: string): Promise<string[]> {
    const keys = await this.storageManager.keys('context:');
    const contextIds = keys.map(key => key.replace('context:', ''));

    return prefix ? contextIds.filter(id => id.startsWith(prefix)) : contextIds;
  }

  async clearContexts(prefix?: string): Promise<void> {
    if (prefix) {
      const contextIds = await this.listContexts(prefix);
      for (const id of contextIds) {
        await this.storageManager.delete(`context:${id}`);
      }
    } else {
      // Clear all contexts by getting all keys with 'context:' prefix and deleting them
      const contextKeys = await this.storageManager.keys('context:');
      for (const key of contextKeys) {
        await this.storageManager.delete(key);
      }
    }

    this.clearCache();
    this.emitSearchEvent('searchContextsCleared', { prefix });
  }

  getSearchStats() {
    return {
      cacheSize: this.searchCache.size,
      cacheHitRate: 0, // Would need to track hits/misses
      totalSearches: 0, // Would need to track total searches
    };
  }

  clearCache(): void {
    this.searchCache.clear();
    this.emitSearchEvent('searchCacheCleared', {
      previousSize: this.searchCache.size,
    });
  }

  private async getStoredContexts(): Promise<StoredContext[]> {
    const keys = await this.storageManager.keys('context:');
    const contexts: StoredContext[] = [];

    for (const key of keys) {
      const context = await this.storageManager.get<StoredContext>(key);
      if (context) {
        contexts.push(context);
      }
    }

    return contexts;
  }

  private getCachedResults(
    query: string,
    resolved: ResolvedSearchOptions
  ): SemanticSearchResult[] | null {
    const cacheKey = this.getCacheKey(query, resolved);
    const cached = this.searchCache.get(cacheKey);

    if (!cached) return null;

    // Check if cache is expired
    if (Date.now() - cached.timestamp > this.config.cacheTimeout) {
      this.searchCache.delete(cacheKey);
      return null;
    }

    return cached.results;
  }

  private cacheResults(
    query: string,
    results: SemanticSearchResult[],
    resolved: ResolvedSearchOptions
  ): void {
    const cacheKey = this.getCacheKey(query, resolved);
    this.searchCache.set(cacheKey, {
      query,
      results,
      timestamp: Date.now(),
      options: resolved,
    });

    // Simple cache size management
    if (this.searchCache.size > 100) {
      const oldestKey = this.searchCache.keys().next().value;
      if (oldestKey) {
        this.searchCache.delete(oldestKey);
      }
    }
  }

  // Keyed on the resolved options so semantically identical calls
  // (e.g. search("q") and search("q", { topK: defaultTopK })) hit the
  // same cache entry — preserving pre-refactor cache semantics.
  private getCacheKey(query: string, resolved: ResolvedSearchOptions): string {
    return `${query}:${JSON.stringify(resolved)}`;
  }

  private async rerankResults(
    _query: string,
    results: SemanticSearchResult[]
  ): Promise<SemanticSearchResult[]> {
    return results
      .map(result => this.applyRerankHeuristics(result))
      .sort((a, b) => b.score - a.score);
  }

  private applyRerankHeuristics(result: SemanticSearchResult): SemanticSearchResult {
    let rerankScore = result.score;

    // Boost shorter, more focused content
    const contentLength = result.content.length;
    if (contentLength < 500) {
      rerankScore *= 1.1;
    } else if (contentLength > 2000) {
      rerankScore *= 0.9;
    }

    // Boost recent content
    if (
      result.metadata?.timestamp &&
      typeof result.metadata.timestamp === 'number'
    ) {
      const age = Date.now() - result.metadata.timestamp;
      const daysSinceCreation = age / (1000 * 60 * 60 * 24);
      if (daysSinceCreation < 7) {
        rerankScore *= 1.05;
      }
    }

    return {
      ...result,
      score: Math.min(rerankScore, 1.0),
      metadata: result.metadata || {},
    };
  }

  private emitSearchEvent<K extends keyof EventMap>(
    eventType: K,
    data: Omit<EventMap[K], 'timestamp' | 'eventId'>
  ): void {
    if (this.eventEmitter) {
      this.eventEmitter.emit(eventType, data);
    }
  }

}
