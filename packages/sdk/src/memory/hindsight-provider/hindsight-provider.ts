/**
 * @file Hindsight Memory Provider
 *
 * HTTP-backed `MemoryProvider` implementation for Hindsight Cloud or a
 * self-hosted Hindsight API. The adapter keeps Hindsight-specific request and
 * response shapes inside this provider while exposing the SDK's backend-neutral
 * memory contract plus standard package, reflect, and health extensions.
 */

import { BaseMemoryProvider } from '../provider';
import type { Health, Packager, Reflector } from '../provider';
import { MemoryProviderError, UnsupportedOperationError } from '../errors';
import type {
  Capabilities,
  ContextPackage,
  HealthStatus,
  IngestInput,
  IngestResult,
  Insight,
  ListRequest,
  ListResultPage,
  Memory,
  MemoryRef,
  PackageRequest,
  Scope,
  SearchRequest,
  SearchResultPage,
} from '../types';
import { fetchJson, fetchJsonOrNull, deleteIgnore404 } from './http';
import type { HttpOptions } from './http';
import type {
  HindsightOperation,
  HindsightOperationsHandle,
  HindsightOperationsPage,
  HindsightProviderConfig,
  HindsightRetainHandle,
  HindsightRetainResponse,
} from './types';
import type {
  RawHealthResponse,
  RawListResponse,
  RawOperationsResponse,
  RawOperationStatusResponse,
  RawReflectResponse,
} from './wire-types';
import {
  HINDSIGHT_DEFAULT_API_VERSION,
  HINDSIGHT_DEFAULT_PROJECT_ID,
  HINDSIGHT_DEFAULT_TIMEOUT,
  HINDSIGHT_SCOPE_TAGS_MATCH,
} from './types';
import {
  bankIdForScope,
  buildRecallRequest,
  buildRetainRequest,
  estimateTokens,
  tagsForScope,
  toMemory,
  toSearchResult,
  unwrapResults,
} from './mappers';

export class HindsightProvider
  extends BaseMemoryProvider
  implements Packager, Reflector, Health
{
  readonly name = 'hindsight';
  private readonly http: HttpOptions;
  private readonly config: HindsightProviderConfig;
  private readonly apiVersion: string;
  private readonly projectId: string;
  private readonly retainHandle: HindsightRetainHandle;
  private readonly operationsHandle: HindsightOperationsHandle;

  constructor(config: HindsightProviderConfig) {
    super();
    this.config = config;
    this.http = {
      apiUrl: config.apiUrl.replace(/\/+$/, ''),
      apiKey: config.apiKey,
      timeout: config.timeout ?? HINDSIGHT_DEFAULT_TIMEOUT,
    };
    this.apiVersion = normalizeSegment(
      config.apiVersion ?? HINDSIGHT_DEFAULT_API_VERSION,
    );
    this.projectId = normalizeSegment(
      config.projectId ?? HINDSIGHT_DEFAULT_PROJECT_ID,
    );
    this.retainHandle = this.createRetainHandle();
    this.operationsHandle = this.createOperationsHandle();
  }

  protected async doIngest(input: IngestInput): Promise<IngestResult> {
    if (input.mode === 'verbatim') {
      throw new UnsupportedOperationError('hindsight', 'ingest(verbatim)');
    }
    await this.retain(input);
    return { created: [], updated: [], unchanged: [] };
  }

  protected async doSearch(request: SearchRequest): Promise<SearchResultPage> {
    const raw = await this.recallRaw(request);
    const results = unwrapResults(raw).map((row) =>
      toSearchResult(row, request.scope),
    );
    return {
      results:
        request.limit === undefined ? results : results.slice(0, request.limit),
    };
  }

  protected async doGet(ref: MemoryRef): Promise<Memory | null> {
    const raw = await fetchJsonOrNull<Record<string, unknown>>(
      this.http,
      this.memoryPath(ref.scope, ref.id),
    );
    return raw ? toMemory(raw, ref.scope) : null;
  }

  protected async doDelete(ref: MemoryRef): Promise<void> {
    await deleteIgnore404(this.http, this.memoryPath(ref.scope, ref.id));
  }

  protected async doList(request: ListRequest): Promise<ListResultPage> {
    const page = resolveListPage(request);
    const raw = await fetchJson<RawListResponse>(
      this.http,
      `${this.bankPath(request.scope)}/memories/list?${page.query}`,
    );
    return this.mapListPage(raw, request.scope, page.offset, page.limit);
  }

  capabilities(): Capabilities {
    return {
      ingestModes: ['text', 'messages'],
      requiredScope: { default: ['user'] },
      extensions: {
        update: false,
        package: true,
        temporal: false,
        graph: false,
        forget: false,
        profile: false,
        reflect: true,
        versioning: false,
        batch: false,
        health: true,
      },
      customExtensions: {
        'hindsight.retain': {
          version: '1.0.0',
          description: 'Raw Hindsight retain response and operation metadata.',
        },
        'hindsight.operations': {
          version: '1.0.0',
          description: 'Hindsight async operation status helpers.',
        },
      },
    };
  }

  override getExtension<T = unknown>(name: string): T | undefined {
    switch (name) {
      case 'hindsight.retain':
        return this.retainHandle as T;
      case 'hindsight.operations':
        return this.operationsHandle as T;
      default:
        return super.getExtension<T>(name);
    }
  }

  async package(request: PackageRequest): Promise<ContextPackage> {
    return this.runOperation('package', request.scope, async () => {
      const raw = await this.recallRaw(request, request.tokenBudget);
      const results = unwrapResults(raw).map((row) =>
        toSearchResult(row, request.scope),
      );
      const text = formatPackageText(results.map((result) => result.memory));
      return {
        text,
        results,
        tokens: estimateTokens(text),
        budgetConstrained: false,
      };
    });
  }

  async reflect(query: string, scope: Scope): Promise<Insight[]> {
    return this.runOperation('reflect', scope, async () => {
      const raw = await fetchJson<RawReflectResponse>(
        this.http,
        `${this.bankPath(scope)}/reflect`,
        { method: 'POST', body: JSON.stringify(buildReflectBody(query, scope)) },
      );
      return [toInsight(raw)];
    });
  }

  async health(): Promise<HealthStatus> {
    const start = Date.now();
    try {
      const raw = await fetchJson<RawHealthResponse>(this.http, '/health');
      return {
        ok: isHealthy(raw),
        latencyMs: Date.now() - start,
        version: typeof raw.version === 'string' ? raw.version : undefined,
      };
    } catch {
      return { ok: false, latencyMs: Date.now() - start };
    }
  }

  private async retain(input: IngestInput): Promise<HindsightRetainResponse> {
    const raw = await fetchJson<HindsightRetainResponse>(
      this.http,
      `${this.bankPath(input.scope)}/memories`,
      { method: 'POST', body: JSON.stringify(buildRetainRequest(input)) },
    );
    assertRetainSucceeded(raw);
    return raw;
  }

  private async recallRaw(
    request: SearchRequest,
    maxTokens?: number,
  ): Promise<unknown> {
    const body = buildRecallRequest(
      request.query,
      request.scope,
      this.config,
      maxTokens,
    );
    return fetchJson<unknown>(
      this.http,
      `${this.bankPath(request.scope)}/memories/recall`,
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
    );
  }

  private mapListPage(
    raw: RawListResponse,
    scope: Scope,
    offset: number,
    limit: number,
  ): ListResultPage {
    const rows = raw.items;
    const nextOffset = offset + rows.length;
    const total = raw.total;
    const hasMore =
      typeof total === 'number' ? nextOffset < total : rows.length === limit;
    return {
      memories: rows.map((row) => toMemory(row, scope)),
      cursor: hasMore ? String(nextOffset) : undefined,
    };
  }

  private createRetainHandle(): HindsightRetainHandle {
    return {
      retain: (input: IngestInput) =>
        this.runOperation('hindsight.retain', input.scope, () =>
          this.retain(input),
        ),
    };
  }

  private createOperationsHandle(): HindsightOperationsHandle {
    return {
      list: (scope: Scope) =>
        this.runOperation('hindsight.operations', scope, () =>
          this.listOperations(scope),
        ),
      get: (scope: Scope, operationId: string) =>
        this.runOperation('hindsight.operations', scope, () =>
          this.getOperation(scope, operationId),
        ),
    };
  }

  private async listOperations(scope: Scope): Promise<HindsightOperationsPage> {
    const raw = await fetchJson<RawOperationsResponse>(
      this.http,
      `${this.bankPath(scope)}/operations`,
    );
    return { bank_id: raw.bank_id, operations: raw.operations };
  }

  private async getOperation(
    scope: Scope,
    operationId: string,
  ): Promise<HindsightOperation | null> {
    const raw = await fetchJsonOrNull<RawOperationStatusResponse>(
      this.http,
      `${this.bankPath(scope)}/operations/${encodeURIComponent(operationId)}`,
    );
    return raw ? normalizeOperation(raw) : null;
  }

  private bankPath(scope: Scope): string {
    return this.route(`/banks/${encodeURIComponent(bankIdForScope(scope))}`);
  }

  private memoryPath(scope: Scope, memoryId: string): string {
    return `${this.bankPath(scope)}/memories/${encodeURIComponent(memoryId)}`;
  }

  private route(path: string): string {
    return `/${this.apiVersion}/${this.projectId}${path}`;
  }
}

function normalizeSegment(segment: string): string {
  return segment.replace(/^\/+|\/+$/g, '');
}

function buildReflectBody(query: string, scope: Scope): Record<string, unknown> {
  const tags = tagsForScope(scope);
  return {
    query,
    ...(tags.length > 0
      ? { tags, tags_match: HINDSIGHT_SCOPE_TAGS_MATCH }
      : {}),
  };
}

function resolveListPage(
  request: ListRequest,
): { limit: number; offset: number; query: string } {
  const limit = request.limit ?? 20;
  const offset = request.cursor ? parseInt(request.cursor, 10) : 0;
  const query = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
  }).toString();
  return { limit, offset, query };
}

function assertRetainSucceeded(raw: HindsightRetainResponse): void {
  if (raw.success === false) {
    throw new MemoryProviderError(
      `Hindsight retain failed: ${retainFailureContext(raw)}`,
      'hindsight',
      'ingest',
    );
  }
}

function retainFailureContext(raw: HindsightRetainResponse): string {
  const ids = raw.operation_ids?.join(',') ?? raw.operation_id ?? 'none';
  return `operation_id=${ids}, items_count=${raw.items_count ?? 'unknown'}, async=${raw.async ?? 'unknown'}`;
}

function normalizeOperation(raw: RawOperationStatusResponse): HindsightOperation {
  return {
    id: raw.operation_id,
    task_type: raw.operation_type ?? undefined,
    created_at: raw.created_at ?? undefined,
    status: raw.status,
    error_message: raw.error_message ?? null,
    retry_count: raw.retry_count ?? undefined,
    next_retry_at: raw.next_retry_at ?? undefined,
  };
}

function formatPackageText(memories: Memory[]): string {
  if (memories.length === 0) return '';
  const lines = memories.map((memory) => {
    const type = String(
      memory.metadata?.hindsightType ?? memory.kind ?? 'memory',
    );
    return `- [${type}] ${memory.content}`;
  });
  return ['Relevant memories:', ...lines].join('\n');
}

function toInsight(raw: RawReflectResponse): Insight {
  const ids = raw.based_on?.memories?.flatMap(supportingId) ?? [];
  return {
    content: raw.text,
    // Hindsight does not expose per-answer confidence; 0 is a sentinel.
    confidence: 0,
    supportingMemoryIds: ids,
  };
}

function supportingId(item: { id?: string | null }): string[] {
  const id = item.id;
  return id ? [id] : [];
}

function isHealthy(raw: RawHealthResponse): boolean {
  if (typeof raw.ok === 'boolean') return raw.ok;
  return raw.status === undefined || ['ok', 'healthy'].includes(raw.status);
}
