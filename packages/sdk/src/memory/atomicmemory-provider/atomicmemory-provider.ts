/**
 * @file AtomicMemory Provider
 *
 * HTTP-based MemoryProvider implementation targeting the AtomicMemory
 * prototype backend.
 *
 * Implements core operations + extensions: Packager, TemporalSearch,
 * Versioner, Health.
 */

import { BaseMemoryProvider } from '../provider';
import type {
  Packager,
  TemporalSearch,
  Versioner,
  Health,
} from '../provider';
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
  PackageRequest,
  ContextPackage,
  MemoryVersion,
  HealthStatus,
  Scope,
  SearchResult,
} from '../types';
import type { AtomicMemoryProviderConfig } from './types';
import {
  ATOMICMEMORY_DEFAULT_TIMEOUT as DEFAULT_TIMEOUT,
  ATOMICMEMORY_DEFAULT_API_VERSION as DEFAULT_API_VERSION,
} from './types';
import { normalizeApiVersion } from './path';
import { fetchJson, fetchJsonOrNull, deleteIgnore404 } from './http';
import type { HttpOptions } from './http';
import {
  toMemory,
  toSearchResult,
  toIngestResult,
  toMemoryVersion,
} from './mappers';
import type { AtomicMemoryHandle } from './handle';
import { createAtomicMemoryHandle } from './handle-impl';
import {
  filterMetaFacts,
  type MetaFactFilterConfig,
} from '../meta-fact-filter';

export class AtomicMemoryProvider
  extends BaseMemoryProvider
  implements Packager, TemporalSearch, Versioner, Health
{
  readonly name = 'atomicmemory';
  private readonly http: HttpOptions;
  /**
   * Prefix prepended to every core-facing route path, e.g. `/v1`.
   * Empty string disables prefixing (legacy deployments only).
   */
  private readonly apiPrefix: string;
  /**
   * Opt-in post-retrieval meta-fact filter. `undefined` (default) means
   * filtering is off. See `MetaFactFilterConfig` and
   * `benchmarks/alignbench/RESULTS.md` for motivation.
   */
  private readonly metaFactFilter?: MetaFactFilterConfig;

  constructor(config: AtomicMemoryProviderConfig) {
    super();
    this.http = {
      apiUrl: config.apiUrl.replace(/\/+$/, ''),
      apiKey: config.apiKey,
      timeout: config.timeout ?? DEFAULT_TIMEOUT,
    };
    this.apiPrefix = normalizeApiVersion(
      config.apiVersion ?? DEFAULT_API_VERSION,
    );
    this.metaFactFilter = config.metaFactFilter;
  }

  /**
   * Drop meta-fact entries from a SearchResult list when the filter is enabled.
   *
   * Called once per search-style endpoint (regular search, temporal search,
   * package) so meta-facts never reach the caller. No-op when
   * `this.metaFactFilter` is `undefined` or `enabled: false` — matches the
   * pre-filter behaviour byte-for-byte.
   */
  private applyMetaFactFilter(results: SearchResult[]): SearchResult[] {
    if (!this.metaFactFilter || !this.metaFactFilter.enabled) return results;
    return filterMetaFacts(
      results,
      (r) => r.memory.content,
      this.metaFactFilter,
    );
  }

  /** Prepend the configured API-version prefix to a route path. */
  private route(path: string): string {
    return `${this.apiPrefix}${path}`;
  }

  // -----------------------------------------------------------------------
  // Core operations
  // -----------------------------------------------------------------------

  protected async doIngest(input: IngestInput): Promise<IngestResult> {
    const conversation = ingestInputToConversation(input);
    const isVerbatim = input.mode === 'verbatim';
    const body: Record<string, unknown> = {
      user_id: input.scope.user,
      conversation,
      source_site: input.provenance?.source ?? 'sdk',
      source_url: input.provenance?.sourceUrl ?? '',
    };
    if (input.scope.thread) body.session_id = input.scope.thread;
    if (isVerbatim) body.skip_extraction = true;
    // Forward caller-supplied metadata to the wire ONLY on the
    // verbatim path. Core honors `metadata` only on
    // /v1/memories/ingest/quick with skip_extraction=true (per
    // atomicmemory-core PR #51); every other branch rejects with
    // 400. `IngestBase.metadata` is inherited by `text` / `messages`
    // / `verbatim` for type ergonomics, but text/messages were
    // silently dropping the field before this commit — forwarding
    // it would turn a previously-passing call into a hard 400 and
    // break the wire contract for callers that already typed
    // metadata on those modes. Gate at runtime; type-level
    // narrowing (move metadata off IngestBase to VerbatimIngest
    // only) is a separate, deliberate breaking change.
    //
    // Omit the field entirely when caller didn't supply or supplied
    // an empty object so non-metadata callers don't emit
    // `"metadata": {}` on the wire.
    if (
      isVerbatim &&
      input.metadata &&
      typeof input.metadata === 'object' &&
      Object.keys(input.metadata).length > 0
    ) {
      body.metadata = input.metadata;
    }

    // Verbatim mode → /memories/ingest/quick with skip_extraction=true,
    // which core maps to storeVerbatim: one input = one memory record,
    // no LLM extraction. Text / messages → /memories/ingest (full
    // extraction pipeline).
    const path = isVerbatim ? '/memories/ingest/quick' : '/memories/ingest';
    const raw = await fetchJson<Record<string, unknown>>(
      this.http,
      this.route(path),
      { method: 'POST', body: JSON.stringify(body) }
    );

    return toIngestResult(raw as any);
  }

  protected async doSearch(
    request: SearchRequest
  ): Promise<SearchResultPage> {
    const body = {
      user_id: request.scope.user,
      query: request.query,
      limit: request.limit,
      threshold: request.threshold,
      namespace_scope: request.scope.namespace,
      session_id: request.scope.thread,
    };

    const raw = await fetchJson<{ memories: any[]; count: number }>(
      this.http,
      this.route('/memories/search/fast'),
      { method: 'POST', body: JSON.stringify(body) }
    );

    return {
      results: this.applyMetaFactFilter(
        raw.memories.map((m: any) => toSearchResult(m, request.scope)),
      ),
    };
  }

  protected async doGet(ref: MemoryRef): Promise<Memory | null> {
    const raw = await fetchJsonOrNull<any>(
      this.http,
      this.route(`/memories/${ref.id}?user_id=${encodeURIComponent(ref.scope.user ?? '')}`)
    );

    if (!raw) return null;
    return toMemory(raw, ref.scope);
  }

  protected async doDelete(ref: MemoryRef): Promise<void> {
    await deleteIgnore404(
      this.http,
      this.route(`/memories/${ref.id}?user_id=${encodeURIComponent(ref.scope.user ?? '')}`),
    );
  }

  protected async doList(
    request: ListRequest
  ): Promise<ListResultPage> {
    const offset = request.cursor
      ? parseInt(request.cursor, 10)
      : 0;
    const limit = request.limit ?? 20;

    const raw = await fetchJson<{
      memories: any[];
      count: number;
    }>(
      this.http,
      this.route(buildListPath(request.scope, limit, offset))
    );

    const nextOffset = offset + raw.memories.length;
    const hasMore = raw.memories.length === limit;

    return {
      memories: raw.memories.map((m: any) =>
        toMemory(m, request.scope)
      ),
      cursor: hasMore ? String(nextOffset) : undefined,
    };
  }

  // -----------------------------------------------------------------------
  // Capabilities
  // -----------------------------------------------------------------------

  capabilities(): Capabilities {
    return {
      // Verbatim mode wires to /memories/ingest/quick with
      // skip_extraction=true (see doIngest), so one input = one record.
      ingestModes: ['text', 'messages', 'verbatim'],
      requiredScope: { default: ['user'] },
      extensions: {
        update: false,
        package: true,
        temporal: true,
        graph: false,
        forget: false,
        profile: false,
        reflect: false,
        versioning: true,
        batch: false,
        health: true,
      },
      // AtomicMemory-specific feature surface — accessed via
      // `sdk.atomicmemory.*` on the SDK, or via
      // `provider.getExtension<AtomicMemoryHandle>('atomicmemory.base')`
      // directly on the provider.
      customExtensions: {
        'atomicmemory.base': { version: '1.0.0' },
        'atomicmemory.lifecycle': { version: '1.0.0' },
        'atomicmemory.audit': { version: '1.0.0' },
        'atomicmemory.lessons': { version: '1.0.0' },
        'atomicmemory.config': { version: '1.0.0' },
        'atomicmemory.agents': { version: '1.0.0' },
      },
    };
  }

  /**
   * V3 extension discovery hook. Resolves custom extension names under the
   * `atomicmemory.*` namespace to typed handles. Each key returns the
   * specific handle for that category — `atomicmemory.lifecycle` returns
   * an `AtomicMemoryLifecycle` (callable as `.consolidate(...)` directly),
   * not the root handle. `atomicmemory.base` returns the root
   * `AtomicMemoryHandle` which aggregates base routes + all category
   * sub-accessors. Standard V3 extensions (`package`, `temporal`,
   * `versioning`, `health`) are still accessed via interface casting on
   * this class — the namespace is additive.
   */
  override getExtension<T = unknown>(name: string): T | undefined {
    switch (name) {
      case 'atomicmemory.base':
        return this.atomicmemoryHandle() as T;
      case 'atomicmemory.lifecycle':
        return this.atomicmemoryHandle().lifecycle as T;
      case 'atomicmemory.audit':
        return this.atomicmemoryHandle().audit as T;
      case 'atomicmemory.lessons':
        return this.atomicmemoryHandle().lessons as T;
      case 'atomicmemory.config':
        return this.atomicmemoryHandle().config as T;
      case 'atomicmemory.agents':
        return this.atomicmemoryHandle().agents as T;
      default:
        return super.getExtension<T>(name);
    }
  }

  /**
   * Lazily construct a single AtomicMemoryHandle instance bound to this
   * provider. The handle exposes AtomicMemory-specific methods through
   * named extensions instead of the backend-agnostic provider surface.
   */
  private _atomicmemoryHandle?: AtomicMemoryHandle;
  private atomicmemoryHandle(): AtomicMemoryHandle {
    if (!this._atomicmemoryHandle) {
      this._atomicmemoryHandle = createAtomicMemoryHandle(
        this.http,
        (path: string) => this.route(path),
      );
    }
    return this._atomicmemoryHandle;
  }

  // -----------------------------------------------------------------------
  // Extensions
  // -----------------------------------------------------------------------

  async package(request: PackageRequest): Promise<ContextPackage> {
    return this.runOperation('package', request.scope, async () => {
      const body = {
        user_id: request.scope.user,
        query: request.query,
        limit: request.limit,
        threshold: request.threshold,
        namespace_scope: request.scope.namespace,
        session_id: request.scope.thread,
        retrieval_mode: mapPackageFormat(request.format),
        token_budget: request.tokenBudget,
        skip_repair: true,
      };

      const raw = await fetchJson<{
        memories: any[];
        injection_text: string;
        estimated_context_tokens?: number;
        budget_constrained: boolean;
      }>(this.http, this.route('/memories/search'), {
        method: 'POST',
        body: JSON.stringify(body),
      });

      if (typeof raw.budget_constrained !== 'boolean') {
        throw new Error(
          'atomicmemory-provider.package: backend response missing required boolean field `budget_constrained`',
        );
      }

      const results: SearchResult[] = this.applyMetaFactFilter(
        raw.memories.map((m: any) => toSearchResult(m, request.scope)),
      );

      return {
        text: raw.injection_text ?? '',
        results,
        tokens: raw.estimated_context_tokens ?? 0,
        budgetConstrained: raw.budget_constrained,
      };
    });
  }

  async searchAsOf(
    request: SearchRequest & { asOf: Date }
  ): Promise<SearchResultPage> {
    return this.runOperation(
      'temporal',
      request.scope,
      async () => {
        const body = {
          user_id: request.scope.user,
          query: request.query,
          limit: request.limit,
          threshold: request.threshold,
          as_of: request.asOf.toISOString(),
          namespace_scope: request.scope.namespace,
          session_id: request.scope.thread,
        };

        const raw = await fetchJson<{
          memories: any[];
        }>(this.http, this.route('/memories/search'), {
          method: 'POST',
          body: JSON.stringify(body),
        });

        return {
          results: this.applyMetaFactFilter(
            raw.memories.map((m: any) => toSearchResult(m, request.scope)),
          ),
        };
      }
    );
  }

  async history(ref: MemoryRef): Promise<MemoryVersion[]> {
    return this.runOperation(
      'versioning',
      ref.scope,
      async () => {
        const raw = await fetchJson<{
          trail: any[];
        }>(
          this.http,
          this.route(`/memories/${ref.id}/audit?user_id=${encodeURIComponent(ref.scope.user ?? '')}`)
        );

        return raw.trail.map(toMemoryVersion);
      }
    );
  }

  async health(): Promise<HealthStatus> {
    return this.runOperation('health', undefined, async () => {
      const start = Date.now();
      const raw = await fetchJson<{ status: string }>(
        this.http,
        this.route('/memories/health')
      );
      return {
        ok: raw.status === 'ok',
        latencyMs: Date.now() - start,
      };
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildListPath(scope: Scope, limit: number, offset: number): string {
  const params = new URLSearchParams({
    user_id: scope.user ?? '',
    limit: String(limit),
    offset: String(offset),
  });
  if (scope.thread) params.set('session_id', scope.thread);
  return `/memories/list?${params.toString()}`;
}

function ingestInputToConversation(input: IngestInput): string {
  switch (input.mode) {
    case 'text':
      return input.content;
    case 'messages':
      return input.messages
        .map((m) => `${m.role}: ${m.content}`)
        .join('\n');
    case 'verbatim':
      return input.content;
  }
}

function mapPackageFormat(
  format?: 'flat' | 'tiered' | 'structured'
): string | undefined {
  switch (format) {
    case 'flat':
      return 'flat';
    case 'tiered':
      return 'tiered';
    case 'structured':
      return 'abstract-aware';
    default:
      return undefined;
  }
}
