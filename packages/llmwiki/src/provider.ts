/**
 * Read-only MemoryProvider that serves a loaded llmwiki export.
 *
 * Lets SDK consumers query an llmwiki project directly without first
 * importing into AtomicMemory. Useful when the wiki is the
 * authoritative knowledge surface and a runtime memory store is
 * overkill — the export itself becomes the queryable substrate.
 *
 * Scope and limits:
 *
 *   - **Single-tenant by construction.** The provider is constructed
 *     for ONE scope. Every `search/list/get/package` call must pass a
 *     `request.scope` whose `user` matches construction; otherwise the
 *     call throws `E_LLMWIKI_PROVIDER_SCOPE_MISMATCH`. Returned
 *     `Memory.scope` reflects the request scope, NOT the construction
 *     scope, so a multi-tenant caller wiring a separate provider per
 *     user still sees attribution that matches the caller. If you
 *     truly need a multi-tenant provider, construct one per user.
 *   - **Read-only**: `ingest`, `delete`, and every mutation extension
 *     throw `LLMWikiBridgeError("E_LLMWIKI_PROVIDER_READONLY")` so
 *     callers fail loudly instead of silently no-op'ing.
 *   - **Lexical search**: case-insensitive substring match over
 *     title + body + summary + tags. v1 deliberately skips embedding /
 *     ranking work — full semantic search lives in the llmwiki CLI's
 *     own `context` command, and shipping a second ranking pipeline
 *     here would duplicate that effort.
 *   - **Lossy `package()`**: returns a simple `ContextPackage`
 *     concatenating matching page bodies with a budget-aware
 *     truncation. The full `llmwiki context` pipeline (graph
 *     expansion, citations, source windows) is NOT projected.
 *     Callers needing full evidence packets should query
 *     `llmwiki context` directly.
 */

import { BaseMemoryProvider } from "@atomicmemory/sdk";
import type {
  Capabilities,
  ContextPackage,
  IngestInput,
  IngestResult,
  ListRequest,
  ListResultPage,
  Memory,
  MemoryRef,
  PackageRequest,
  SearchRequest,
  SearchResult,
  SearchResultPage,
  Scope,
} from "@atomicmemory/sdk";
import {
  E_LLMWIKI_EXPORT_DUPLICATE_SLUG,
  E_LLMWIKI_PROJECT_ID_REQUIRED,
  E_LLMWIKI_PROVIDER_DISPOSED,
  E_LLMWIKI_PROVIDER_INVALID_CURSOR,
  E_LLMWIKI_PROVIDER_READONLY,
  E_LLMWIKI_PROVIDER_SCOPE_MISMATCH,
  LLMWikiBridgeError,
} from "./errors.js";
import { normalizeLimit, normalizeTokenBudget } from "./pagination.js";
import { buildExternalId } from "./external-id.js";
import { buildLlmwikiMetadata } from "./metadata.js";
import type { ExportPage, LLMWikiExport } from "./schema.js";
import { cloneScope, assertRequiredScopeFields } from "./scope.js";
import { DEFAULT_TOKEN_BUDGET, defaultTokenize, fenceUntrustedSource } from "./context-package.js";
import { parseDate } from "./dates.js";

/**
 * Max possible score from `scorePage`. Used to normalize `relevance`
 * to [0,1]. The score domain is intentionally discrete (only 0, 1,
 * or 3 are produced) in v1: lexical match yes/no, plus a title-hit
 * bonus. Future smoothing — recency, slug-token weighting,
 * embedding-based scoring — should keep the [0,1] relevance contract
 * but is out of scope here.
 */
const MAX_SEARCH_SCORE = 3;
/**
 * Default `search()` result limit when the caller omits one. The
 * `MemoryProvider` interface allows unbounded queries, but defaulting
 * to "every page" turns an innocent `search({ query })` into an OOM
 * vector for large exports. Callers who really want everything pass
 * `limit: Number.MAX_SAFE_INTEGER` explicitly.
 */
const DEFAULT_SEARCH_LIMIT = 25;

export interface SnapshotLLMWikiProviderOptions {
  /** Loaded export envelope; provider treats it as immutable. */
  exportData: LLMWikiExport;
  /** Required when the envelope omits projectId; lets the caller pin one explicitly. */
  projectIdOverride?: string;
  /** Default scope returned in Memory.scope and matched against search/list/get inputs. */
  scope: Scope;
  /**
   * Optional tokenizer used by `package()` to budget the returned
   * `ContextPackage`. When omitted, the provider falls back to `defaultTokenize`
   * (a coarse chars/token heuristic) — accurate enough for English prose,
   * badly wrong for code / CJK / dense markup. Pass a real tokenizer
   * (tiktoken, gpt-tokenizer) when budget accuracy matters.
   */
  tokenize?: (text: string) => number;
}

/**
 * Read-only MemoryProvider over a loaded `LLMWikiExport`.
 *
 * Construct one per export. Re-loading the same export file yields a
 * new provider; the previous instance is unaffected.
 *
 * **Memory profile.** A provider holds the entire export in memory
 * for its lifetime — a 256 MB export pins ~256 MB of process RSS
 * indefinitely. For long-running server contexts (Next.js API
 * routes, queue workers, anything that isn't a single-shot CLI),
 * **construct per request and let GC reclaim**, not one instance per
 * logged-in user. Call `dispose()` to drop references explicitly when
 * the provider is no longer needed; subsequent calls throw
 * `E_LLMWIKI_PROVIDER_DISPOSED`.
 */
export class SnapshotLLMWikiProvider extends BaseMemoryProvider {
  // fallow-ignore-next-line unused-class-member
  readonly name = "llmwiki";
  private exportData: LLMWikiExport | null;
  private readonly projectId: string;
  private readonly scope: Scope;
  /** Pages keyed by external ID. Stamped with construction scope only for internal lookup. */
  private pagesById: Map<string, ExportPage> | null;
  /** Optional caller-supplied tokenizer for `package()` budget enforcement. */
  private readonly tokenize: (text: string) => number;
  private disposed = false;

  constructor(options: SnapshotLLMWikiProviderOptions) {
    super();
    this.exportData = options.exportData;
    this.projectId = resolveProjectId(options);
    this.scope = cloneScope(options.scope);
    // Validate construction scope up front — mirrors the live provider check
    // so every operation path is guarded consistently.
    assertRequiredScopeFields(
      this.scope,
      this.capabilities().requiredScope.default,
      "SnapshotLLMWikiProvider",
    );
    this.tokenize = options.tokenize ?? defaultTokenize;
    this.pagesById = new Map();
    for (const page of this.exportData.pages) {
      const externalId = buildExternalId(this.projectId, page.pageDirectory, page.slug);
      if (this.pagesById.has(externalId)) {
        // H4: silently overwriting would make provider semantics drift
        // from ingest semantics (CLI ingest loop calls ingestMemories
        // once per page, so the store sees both; provider would only
        // see one). Refuse the construction instead.
        throw new LLMWikiBridgeError(
          E_LLMWIKI_EXPORT_DUPLICATE_SLUG,
          `Duplicate external ID "${externalId}" in export — two pages share ` +
            `(pageDirectory="${page.pageDirectory}", slug="${page.slug}").`,
        );
      }
      this.pagesById.set(externalId, page);
    }
  }

  capabilities(): Capabilities {
    return {
      ingestModes: [],
      requiredScope: { default: ["user"] },
      extensions: {
        update: false,
        package: true,
        temporal: false,
        graph: false,
        forget: false,
        profile: false,
        reflect: false,
        versioning: false,
        batch: false,
        health: false,
      },
    };
  }

  protected async doIngest(_input: IngestInput): Promise<IngestResult> {
    throw readOnlyError("ingest");
  }

  // fallow-ignore-next-line complexity
  protected async doSearch(request: SearchRequest): Promise<SearchResultPage> {
    const pages = this.assertLive("search");
    this.assertScopeMatches(request.scope, "search");
    const query = request.query.trim().toLowerCase();
    if (query.length === 0) return { results: [] };
    const limit = normalizeLimit(request.limit) ?? DEFAULT_SEARCH_LIMIT;
    const scored: SearchResult[] = [];
    for (const [externalId, page] of pages) {
      const score = scorePage(page, query);
      if (score > 0) {
        const memory = pageToMemory(page, externalId, request.scope);
        scored.push({ memory, score, relevance: score / MAX_SEARCH_SCORE });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    const aboveThreshold =
      request.threshold !== undefined
        ? scored.filter((r) => (r.relevance ?? 0) >= request.threshold!)
        : scored;
    return { results: aboveThreshold.slice(0, limit) };
  }

  protected async doGet(ref: MemoryRef): Promise<Memory | null> {
    const pages = this.assertLive("get");
    this.assertScopeMatches(ref.scope, "get");
    const page = pages.get(ref.id);
    return page ? pageToMemory(page, ref.id, ref.scope) : null;
  }

  protected async doDelete(_ref: MemoryRef): Promise<void> {
    throw readOnlyError("delete");
  }

  protected async doList(request: ListRequest): Promise<ListResultPage> {
    const pages = this.assertLive("list");
    this.assertScopeMatches(request.scope, "list");
    const all = Array.from(pages.entries());
    const offset = parseCursor(request.cursor);
    const limit = normalizeLimit(request.limit) ?? all.length;
    const slice = all
      .slice(offset, offset + limit)
      .map(([externalId, page]) => pageToMemory(page, externalId, request.scope));
    const nextCursor =
      offset + slice.length < all.length ? String(offset + slice.length) : undefined;
    return nextCursor !== undefined
      ? { memories: slice, cursor: nextCursor }
      : { memories: slice };
  }

  /**
   * `Packager` extension. Reachable via the SDK's documented
   * `provider.getExtension<Packager>("package")` because
   * `BaseMemoryProvider.resolveExtension` returns `this` when
   * `capabilities().extensions.package` is true — which the
   * `capabilities()` method above confirms.
   */
  // fallow-ignore-next-line unused-class-member
  async package(request: PackageRequest): Promise<ContextPackage> {
    this.assertLive("package");
    this.assertScopeMatches(request.scope, "package");
    const { results } = await this.search(request);
    const budget = normalizeTokenBudget(request.tokenBudget, DEFAULT_TOKEN_BUDGET);
    return buildContextPackage(results, budget, this.tokenize);
  }

  /**
   * Drop the in-memory export reference and the per-page map so the
   * provider's working set can be reclaimed by GC. After dispose,
   * every read method throws `E_LLMWIKI_PROVIDER_DISPOSED`. Idempotent
   * — calling dispose more than once is safe.
   */
  // fallow-ignore-next-line unused-class-member
  dispose(): void {
    this.disposed = true;
    this.exportData = null;
    this.pagesById = null;
  }

  /**
   * Return the live page map for use by a read method. Throws if the
   * provider has been disposed.
   */
  private assertLive(op: string): Map<string, ExportPage> {
    if (this.disposed || this.pagesById === null) {
      throw new LLMWikiBridgeError(
        E_LLMWIKI_PROVIDER_DISPOSED,
        `SnapshotLLMWikiProvider.${op}() called on a disposed provider. ` +
          "Construct a fresh instance per request in long-lived contexts.",
      );
    }
    return this.pagesById;
  }

  /**
   * Guard every read against cross-partition traffic when one process holds providers
   * for several scopes. All four Scope fields (`user`, `agent`, `namespace`, `thread`)
   * must exactly match the construction scope — any difference is rejected because this
   * provider is single-tenant over one export, with no per-field sub-filtering.
   *
   * Echoes only the attempted op back to the caller (M8) — the legitimate construction
   * scope is not surfaced, so an attacker probing with a guessed scope cannot learn the
   * real scope from the error message.
   */
  // fallow-ignore-next-line complexity
  private assertScopeMatches(requestScope: Scope, op: string): void {
    const SCOPE_FIELDS = ["user", "agent", "namespace", "thread"] as const;
    const matches = SCOPE_FIELDS.every((f) => requestScope[f] === this.scope[f]);
    if (!matches) {
      throw new LLMWikiBridgeError(
        E_LLMWIKI_PROVIDER_SCOPE_MISMATCH,
        `SnapshotLLMWikiProvider.${op}() rejected: request scope does not match the provider's ` +
          "construction scope on all fields (user, agent, namespace, thread). This provider is " +
          "single-tenant over one export; construct one provider per scope.",
      );
    }
  }
}

/**
 * Parse a `list()` cursor with explicit error reporting. The cursor
 * is documented as an opaque token, but it's a stringified offset
 * under the covers — fabricating one is easy. We reject anything
 * that doesn't round-trip to a non-negative integer so callers don't
 * silently get NaN-slice empty results or negative-slice surprises.
 */
function parseCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const offset = Number(cursor);
  if (!Number.isInteger(offset) || offset < 0) {
    throw new LLMWikiBridgeError(
      E_LLMWIKI_PROVIDER_INVALID_CURSOR,
      `SnapshotLLMWikiProvider.list() received an invalid cursor "${cursor}". ` +
        "Use a cursor returned by a prior list() call; do not fabricate one.",
    );
  }
  return offset;
}

function resolveProjectId(options: SnapshotLLMWikiProviderOptions): string {
  const candidate = options.projectIdOverride ?? options.exportData.projectId;
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new LLMWikiBridgeError(
      E_LLMWIKI_PROJECT_ID_REQUIRED,
      "SnapshotLLMWikiProvider requires a projectId in the export or via projectIdOverride.",
    );
  }
  return candidate;
}

function pageToMemory(page: ExportPage, externalId: string, scope: Scope): Memory {
  return {
    id: externalId,
    content: page.body,
    scope,
    kind: "document",
    createdAt: parseDate(page.createdAt),
    updatedAt: parseDate(page.updatedAt),
    // `extractor: "llmwiki"` is the closest existing SDK Provenance
    // primitive to a trust signal. Tells downstream packaging "this
    // content came from an external pipeline, not from AM's own LLM
    // extraction." Complements `metadata.llmwiki.trustLevel` (which
    // carries the explicit external-import marker downstream packagers
    // can also read).
    provenance: { source: "llmwiki", sourceId: externalId, extractor: "llmwiki" },
    metadata: buildMetadataBlob(page, externalId),
  };
}

function buildMetadataBlob(page: ExportPage, externalId: string): Record<string, unknown> {
  const projectId = externalId.split("/")[1] ?? "";
  return {
    externalId,
    llmwiki: buildLlmwikiMetadata(page, projectId),
  };
}

function scorePage(page: ExportPage, query: string): number {
  // Tags are joined with a "#" sentinel rather than a space so a
  // query like "react" can't substring-match a tag "reactive" via the
  // joined haystack. Multi-word tags survive as individual entries.
  const tagBag = page.tags.length > 0 ? `#${page.tags.join("\n#")}` : "";
  const haystack = [page.title, page.summary, tagBag, page.body].join("\n").toLowerCase();
  if (!haystack.includes(query)) return 0;
  const titleHit = page.title.toLowerCase().includes(query) ? 2 : 0;
  return 1 + titleHit;
}

/**
 * Pack results in priority order until the budget runs out, then stop.
 *
 * NOT a knapsack: if hit #1 doesn't fit the package is empty, even if
 * hit #2 would have fit. This honors priority (higher-scored hits
 * stay first) over fill rate. Documented behavior — a `break` here,
 * not a `continue`, because skipping a high-priority hit to keep a
 * lower-priority one would silently demote search quality.
 */
function buildContextPackage(
  results: SearchResult[],
  tokenBudget: number,
  tokenize: (text: string) => number,
): ContextPackage {
  const pieces: string[] = [];
  const kept: SearchResult[] = [];
  let runningTokens = 0;
  let truncated = false;
  for (const result of results) {
    const body = result.memory.content;
    const tokens = tokenize(body);
    if (runningTokens + tokens > tokenBudget) {
      truncated = true;
      break;
    }
    runningTokens += tokens;
    // Fence each body per README:128 — the consuming LLM sees a structural
    // boundary it can act on; untrusted content cannot escape the fence.
    pieces.push(fenceUntrustedSource(result.memory.id, body));
    kept.push(result);
  }
  return {
    text: pieces.join("\n\n"),
    results: kept,
    tokens: runningTokens,
    budgetConstrained: truncated,
  };
}

function readOnlyError(operation: string): LLMWikiBridgeError {
  return new LLMWikiBridgeError(
    E_LLMWIKI_PROVIDER_READONLY,
    `SnapshotLLMWikiProvider is read-only; ${operation}() is not supported. ` +
      "Use the @atomicmemory/llmwiki import path or atomicmemory CLI to populate a writable provider.",
  );
}

