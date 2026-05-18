/**
 * @file Mem0 Provider
 *
 * HTTP-based MemoryProvider implementation targeting a local or hosted
 * Mem0 instance (port 8888 OSS; api.mem0.ai hosted).
 *
 * Implements core V3 operations plus Health. Other V3 extensions
 * (package, temporal, versioning, graph, etc.) are not supported by mem0.
 *
 * mem0 2.0 compatibility:
 * - Search uses `POST /v2/memories/search/` with nested `filters` object.
 * - Add response envelope is `{id, event, data: {memory}}`; legacy flat
 *   `{id, memory, event}` is still tolerated.
 * - Enterprise scoping (`org_id`, `project_id`) is passed at top level
 *   when configured.
 *
 * Known limitation: mem0 2.0 makes `add` async-by-default and returns
 * queued event IDs. For consumers that need the final extracted memories,
 * polling `/v1/event/{event_id}/` is a future enhancement (tracked as
 * post-v1.0 work); the current implementation returns what mem0 emits
 * in the immediate response.
 */

import { BaseMemoryProvider } from '../provider';
import { UnsupportedOperationError } from '../errors';
import type {
  IngestInput,
  IngestResult,
  SearchRequest,
  SearchResultPage,
  MemoryRef,
  Memory,
  ListRequest,
  ListResultPage,
  Capabilities,
  HealthStatus,
} from '../types';
import type { Health } from '../provider';
import type { Mem0ProviderConfig } from './types';
import { MEM0_DEFAULT_TIMEOUT as DEFAULT_TIMEOUT } from './types';
import { fetchJson, fetchJsonOrNull, deleteIgnore404 } from './http';
import type { HttpOptions } from './http';
import {
  toMemory,
  toSearchResult,
  toIngestResult,
  buildIngestBody,
  buildSearchBody,
  resolveInferFlag,
  unwrapMem0Array,
} from './mappers';

export class Mem0Provider extends BaseMemoryProvider implements Health {
  readonly name = 'mem0';
  private readonly http: HttpOptions;
  private readonly config: Mem0ProviderConfig;
  private readonly prefix: string;

  constructor(config: Mem0ProviderConfig) {
    super();
    this.config = config;
    this.http = {
      apiUrl: config.apiUrl.replace(/\/+$/, ''),
      apiKey: config.apiKey,
      timeout: config.timeout ?? DEFAULT_TIMEOUT,
    };
    // '/v1' for hosted Mem0, '' for OSS self-hosted
    this.prefix = config.pathPrefix ?? '/v1';
  }

  /** Build an API path using the configured prefix (used for /memories/ family). */
  private path(endpoint: string): string {
    return `${this.prefix}${endpoint}`;
  }

  /**
   * Build the path to the v2 search endpoint. mem0 2.0 split search out of the
   * v1 family, so search ignores `pathPrefix` and uses `/v2/memories/search/`
   * on hosted, or `/memories/search/` on OSS (when `pathPrefix === ''`).
   */
  private searchPath(): string {
    return this.prefix === '' ? '/memories/search/' : '/v2/memories/search/';
  }

  // -----------------------------------------------------------------------
  // Core operations
  // -----------------------------------------------------------------------

  protected async doIngest(input: IngestInput): Promise<IngestResult> {
    // Mem0's /memories endpoint always runs server-side extraction and
    // can split one input across multiple memories, which violates the
    // verbatim contract (one input = one memory, deterministic). Rather
    // than silently returning non-verbatim semantics, fail closed so
    // callers know to pin on the AtomicMemory provider for verbatim.
    if (input.mode === 'verbatim') {
      throw new UnsupportedOperationError('mem0', 'ingest(verbatim)');
    }
    const userId = input.scope.user ?? '';
    const body = buildIngestBody(input, userId, this.config);
    const shouldDefer =
      this.config.deferInference === true &&
      resolveInferFlag(input, this.config) === true;

    if (shouldDefer) {
      body.infer = false;
    }

    const raw = await fetchJson<unknown>(
      this.http,
      this.path('/memories/'),
      { method: 'POST', body: JSON.stringify(body) }
    );

    const memories = unwrapMem0Array<Record<string, unknown>>(raw)
      .map((m) => ({
        id: String(m.id ?? ''),
        memory: String(m.memory ?? ''),
        event: String(m.event ?? 'ADD'),
      }));

    if (shouldDefer) {
      this.fireBackgroundInference(body);
    }

    return toIngestResult(memories);
  }

  /**
   * Fire-and-forget: re-ingest with infer=true for AUDN extraction.
   * Logs errors but never blocks the caller.
   */
  private fireBackgroundInference(
    body: Record<string, unknown>
  ): void {
    const inferBody = { ...body, infer: true };
    fetchJson<unknown>(
      this.http,
      this.path('/memories/'),
      { method: 'POST', body: JSON.stringify(inferBody) }
    ).catch((err) => {
      console.error('[Mem0Provider] deferred AUDN failed:', err);
    });
  }

  protected async doSearch(
    request: SearchRequest
  ): Promise<SearchResultPage> {
    const body = buildSearchBody(
      request.query,
      request.scope,
      this.config,
      request.limit,
    );

    const raw = await fetchJson<unknown>(
      this.http,
      this.searchPath(),
      { method: 'POST', body: JSON.stringify(body) }
    );

    const results = unwrapMem0Array<Record<string, unknown>>(raw)
      .map((m: any) => toSearchResult(m, request.scope));

    return { results };
  }

  protected async doGet(ref: MemoryRef): Promise<Memory | null> {
    const raw = await fetchJsonOrNull<Record<string, unknown>>(
      this.http,
      this.path(`/memories/${ref.id}/`)
    );

    if (!raw) return null;
    return toMemory(raw as any, ref.scope);
  }

  protected async doDelete(ref: MemoryRef): Promise<void> {
    await deleteIgnore404(this.http, this.path(`/memories/${ref.id}/`));
  }

  protected async doList(
    request: ListRequest
  ): Promise<ListResultPage> {
    const limit = request.limit ?? 20;
    const offset = request.cursor
      ? parseInt(request.cursor, 10)
      : 0;

    const params = new URLSearchParams({
      user_id: request.scope.user ?? '',
      page_size: String(limit),
      ...(offset > 0 ? { page: String(Math.floor(offset / limit) + 1) } : {}),
    });

    const raw = await fetchJson<unknown>(
      this.http,
      `${this.path('/memories/')}?${params.toString()}`
    );

    const memories = unwrapMem0Array<Record<string, unknown>>(raw)
      .map((m: any) => toMemory(m, request.scope));

    const nextOffset = offset + memories.length;
    const hasMore = memories.length === limit;

    return {
      memories,
      cursor: hasMore ? String(nextOffset) : undefined,
    };
  }

  // -----------------------------------------------------------------------
  // Health extension
  // -----------------------------------------------------------------------

  /**
   * Check Mem0 backend connectivity.
   *
   * Performs a lightweight list request with page_size=1 to verify
   * the server is reachable and responding.
   */
  // fallow-ignore-next-line unused-class-member
  async health(): Promise<HealthStatus> {
    const start = Date.now();
    try {
      const params = new URLSearchParams({
        user_id: 'health-check',
        page_size: '1',
      });
      await fetchJson<unknown>(
        this.http,
        `${this.path('/memories/')}?${params.toString()}`
      );
      return {
        ok: true,
        latencyMs: Date.now() - start,
      };
    } catch {
      return {
        ok: false,
        latencyMs: Date.now() - start,
      };
    }
  }

  // -----------------------------------------------------------------------
  // Capabilities
  // -----------------------------------------------------------------------

  capabilities(): Capabilities {
    return {
      // Verbatim is intentionally NOT advertised: Mem0's /memories
      // endpoint always runs extraction server-side, which breaks the
      // "one input = one memory, deterministic" contract. doIngest()
      // throws UnsupportedOperationError if verbatim reaches it, so
      // capability-gated callers (`if (caps.ingestModes.includes(...))`)
      // get the right answer.
      ingestModes: ['text', 'messages'],
      requiredScope: { default: ['user'] },
      extensions: {
        update: false,
        package: false,
        temporal: false,
        graph: false,
        forget: false,
        profile: false,
        reflect: false,
        versioning: false,
        batch: false,
        health: true,
      },
    };
  }
}
