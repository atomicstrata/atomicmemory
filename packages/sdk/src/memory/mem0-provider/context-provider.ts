/**
 * @file Mem0 Context Provider — V2-Compatible Bridge
 *
 * Wraps the V3 Mem0Provider HTTP layer to expose the high-level
 * context-oriented interface that the webapp's Mem0SdkAdapter expects.
 *
 * This is NOT a V3 MemoryProvider — it is a compatibility bridge
 * for consumers that import `Mem0ContextProvider` from the SDK.
 *
 * Methods map to Mem0 REST endpoints. Path prefix depends on apiStyle:
 * - apiStyle 'oss' → /memories, /search (no version prefix)
 * - apiStyle 'hosted' → /v1/memories/, /v1/search/
 */

import { fetchJson, fetchVoid, fetchJsonOrNull } from './http';
import type { HttpOptions } from './http';
import { MEM0_DEFAULT_TIMEOUT as DEFAULT_TIMEOUT } from './types';
import { unwrapMem0Array } from './mappers';
import type {
  Mem0ContextProviderConfig,
  ContextMetadata,
  DocumentMetadata,
  ContextRecord,
  ContextSearchResult,
  ContextSearchOptions,
  AddContextResult,
} from './context-types';

export class Mem0ContextProvider {
  private readonly http: HttpOptions;
  private readonly config: Mem0ContextProviderConfig;
  private readonly prefix: string;
  private _initialized = false;

  constructor(config: Mem0ContextProviderConfig) {
    this.config = config;
    this.http = {
      apiUrl: config.host.replace(/\/+$/, ''),
      apiKey: config.apiKey,
      timeout: config.timeout ?? DEFAULT_TIMEOUT,
    };
    // Explicit pathPrefix takes precedence; otherwise derive from apiStyle
    this.prefix = config.pathPrefix ?? (config.apiStyle === 'oss' ? '' : '/v1');
  }

  /** Build an API path using the configured prefix. */
  private path(endpoint: string): string {
    return `${this.prefix}${endpoint}`;
  }

  async initialize(): Promise<void> {
    this._initialized = true;
  }

  /**
   * Add a context (memory) for a user.
   * Uses infer=false for verbatim storage.
   *
   * Returns the Mem0 server-assigned ID alongside the caller-supplied contextId.
   * The memoryId is what get/update/delete operations require.
   */
  async addContext(
    contextId: string,
    content: string,
    metadata?: ContextMetadata
  ): Promise<AddContextResult> {
    this.assertInitialized();

    const userId = metadata?.userId ?? this.config.defaultUserId;
    const body: Record<string, unknown> = {
      messages: [{ role: 'user', content }],
      user_id: userId,
      infer: false,
      metadata: {
        ...metadata,
        contextId,
      },
    };

    const raw = await fetchJson<unknown>(this.http, this.path('/memories/'), {
      method: 'POST',
      body: JSON.stringify(body),
    });

    const entries = unwrapMem0Array<RawAddEntry>(raw);
    const firstEntry = entries[0];
    const memoryId = firstEntry?.id ? String(firstEntry.id) : contextId;

    return { memoryId, contextId, content };
  }

  /**
   * Update an existing memory's content.
   */
  // fallow-ignore-next-line unused-class-member
  async updateContext(
    memoryId: string,
    content: string,
    userId: string,
    metadata?: DocumentMetadata
  ): Promise<void> {
    this.assertInitialized();

    const body: Record<string, unknown> = {
      text: content,
      user_id: userId,
    };

    if (metadata) {
      body.metadata = metadata;
    }

    await fetchJson<unknown>(
      this.http,
      this.path(`/memories/${encodeURIComponent(memoryId)}/`),
      { method: 'PUT', body: JSON.stringify(body) }
    );
  }

  /**
   * Search memories for a user.
   */
  async searchContext(
    query: string,
    options: ContextSearchOptions
  ): Promise<ContextSearchResult[]> {
    this.assertInitialized();

    const body = {
      query,
      user_id: options.userId,
      limit: options.maxResults ?? 10,
    };

    const raw = await fetchJson<unknown>(
      this.http,
      this.path('/search/'),
      { method: 'POST', body: JSON.stringify(body) }
    );

    const results = unwrapMem0Array<RawSearchEntry>(raw);
    return results
      .filter((r) => {
        if (options.threshold === undefined) return true;
        return matchesSimilarityThreshold(
          r.score,
          options.threshold
        );
      })
      .map((r) => ({
        id: String(r.id ?? ''),
        contextId: String(r.metadata?.contextId ?? r.id ?? ''),
        content: String(r.memory ?? ''),
        score: r.score ?? 0,
        metadata: r.metadata,
      }));
  }

  /**
   * Get a single memory by ID. Returns null on 404.
   */
  async getContext(memoryId: string): Promise<ContextRecord | null> {
    this.assertInitialized();

    const raw = await fetchJsonOrNull<RawMemoryEntry>(
      this.http,
      this.path(`/memories/${encodeURIComponent(memoryId)}/`)
    );

    if (!raw) return null;

    return {
      id: String(raw.id ?? memoryId),
      content: String(raw.memory ?? ''),
      metadata: raw.metadata,
      createdAt: raw.created_at,
      updatedAt: raw.updated_at,
    };
  }

  /**
   * Delete a single memory by ID. Returns false on 404.
   */
  // fallow-ignore-next-line unused-class-member
  async deleteContext(memoryId: string): Promise<boolean> {
    this.assertInitialized();

    try {
      await fetchVoid(
        this.http,
        this.path(`/memories/${encodeURIComponent(memoryId)}/`),
        { method: 'DELETE' }
      );
      return true;
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('HTTP 404')) {
        return false;
      }
      throw err;
    }
  }

  /**
   * Delete all memories for a user.
   */
  async deleteAllContexts(
    options: { userId?: string }
  ): Promise<boolean> {
    this.assertInitialized();

    const userId = options.userId ?? this.config.defaultUserId;
    const params = new URLSearchParams({ user_id: userId });

    try {
      await fetchVoid(
        this.http,
        `${this.path('/memories/')}?${params.toString()}`,
        { method: 'DELETE' }
      );
      return true;
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('HTTP 404')) {
        return false;
      }
      throw err;
    }
  }

  /**
   * List all memories for a user.
   */
  async listContexts(
    options: { userId?: string; limit?: number }
  ): Promise<ContextRecord[]> {
    this.assertInitialized();

    const userId = options.userId ?? this.config.defaultUserId;
    const params = new URLSearchParams({
      user_id: userId,
      ...(options.limit ? { page_size: String(options.limit) } : {}),
    });

    const raw = await fetchJson<unknown>(
      this.http,
      `${this.path('/memories/')}?${params.toString()}`
    );

    const entries = unwrapMem0Array<RawMemoryEntry>(raw);
    return entries.map((r) => ({
      id: String(r.id ?? ''),
      content: String(r.memory ?? ''),
      metadata: r.metadata,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  private assertInitialized(): void {
    if (!this._initialized) {
      throw new Error(
        'Mem0ContextProvider not initialized. Call initialize() first.'
      );
    }
  }
}

/**
 * Local Mem0 returns distance-like scores where lower is better.
 * Bridge callers still supply a similarity threshold [0, 1], so convert
 * it to a maximum allowed distance before filtering.
 */
function matchesSimilarityThreshold(
  rawScore: number | undefined,
  threshold: number
): boolean {
  const distance = rawScore ?? 0;
  const maxDistance = 1 - threshold;
  return distance <= maxDistance;
}

/** Raw shape from Mem0 GET/LIST endpoints */
interface RawMemoryEntry {
  id?: string;
  memory?: string;
  metadata?: Record<string, unknown>;
  user_id?: string;
  created_at?: string;
  updated_at?: string;
}

/** Raw shape from Mem0 POST /memories/ (add) */
interface RawAddEntry {
  id?: string;
  memory?: string;
  event?: string;
}

/** Raw shape from Mem0 POST /search/ */
interface RawSearchEntry {
  id?: string;
  memory?: string;
  score?: number;
  metadata?: Record<string, unknown>;
  user_id?: string;
  created_at?: string;
  updated_at?: string;
}
