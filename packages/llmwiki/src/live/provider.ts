/**
 * LiveLLMWikiProvider — a writable, source-backed AtomicMemory provider over a live llmwiki
 * project (via createWiki). CRUD is over sources; provider ids are source ids. Compiled-page
 * reads stay with SnapshotLLMWikiProvider. `compile()` is explicit (not part of ingest).
 *
 * For LiveLLMWikiProvider, `verbatim` means storing the input verbatim as a llmwiki **source
 * document**, not as a compiled wiki page or an AtomicMemory Core memory record. (spec §4.5)
 */

import { createWiki } from "llm-wiki-compiler";
import type { Wiki, SourceRecord, IngestResult as LlmwikiIngestResult } from "llm-wiki-compiler";
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
  Packager,
  SearchRequest,
  SearchResult,
  SearchResultPage,
  Scope,
} from "@atomicmemory/sdk";
import { validateProjectId } from "../project-id.js";
import { LLMWikiBridgeError, E_LLMWIKI_PROVIDER_SCOPE_MISMATCH } from "../errors.js";
import { normalizeLimit, normalizeTokenBudget } from "../pagination.js";
import { buildLiveExternalId, parseLiveExternalId } from "./live-external-id.js";
import { sourceToMemory } from "./live-metadata.js";
import { flattenMessages, deriveTitle } from "./flatten.js";
import { cloneScope, assertRequiredScopeFields } from "../scope.js";
import { DEFAULT_TOKEN_BUDGET, defaultTokenize, fenceUntrustedSource } from "../context-package.js";

/** Construction options for LiveLLMWikiProvider. */
export interface LiveLLMWikiProviderOptions {
  root: string;
  scope: Scope;
  projectId: string;
  /**
   * Optional tokenizer for `package()` budget accounting. When omitted, falls back to
   * `defaultTokenize` (a coarse chars/token heuristic). Pass a real tokenizer (tiktoken,
   * gpt-tokenizer) when budget accuracy matters.
   */
  tokenize?: (text: string) => number;
}

/** Max possible score from scoreSource — used to normalise relevance to [0,1]. */
const MAX_SOURCE_SCORE = 3;

/** Default search result limit when the caller omits one. */
const DEFAULT_SEARCH_LIMIT = 25;

/**
 * Writable, source-backed MemoryProvider over a live llmwiki project.
 *
 * One instance = one project root + one scope. CRUD operations touch
 * `sources/` via the `createWiki` SDK facade. Compiled-page reads are out of
 * scope for this provider — use `SnapshotLLMWikiProvider` for those.
 *
 * **Isolation contract**: The construction scope (all four fields: `user`,
 * `agent`, `namespace`, `thread`) is the trust boundary. Every request scope
 * must exactly match the construction scope on all four fields. Any difference
 * — including a narrower or broader scope — is rejected. Since the provider
 * stores everything under one root with no per-field sub-filtering, allowing
 * a mismatched scope would leak data across partitions.
 */
export class LiveLLMWikiProvider extends BaseMemoryProvider implements Packager {
  // fallow-ignore-next-line unused-class-member
  readonly name = "llmwiki-live";

  private readonly wiki: Wiki;
  private readonly projectId: string;
  private readonly liveScope: Scope;
  private readonly tokenize: (text: string) => number;

  constructor(options: LiveLLMWikiProviderOptions) {
    super();
    this.projectId = validateProjectId(options.projectId);
    this.liveScope = cloneScope(options.scope);
    // Validate construction scope up front so every path (including compile(),
    // which uses exact-match assertScope) is guarded against scope: {}.
    assertRequiredScopeFields(
      this.liveScope,
      this.capabilities().requiredScope.default,
      "LiveLLMWikiProvider",
    );
    this.wiki = createWiki({ root: options.root });
    this.tokenize = options.tokenize ?? defaultTokenize;
  }

  capabilities(): Capabilities {
    return {
      ingestModes: ["text", "messages", "verbatim"],
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

  protected async doIngest(input: IngestInput): Promise<IngestResult> {
    this.assertScope(input.scope, "ingest");
    const text = input.mode === "messages" ? flattenMessages(input.messages) : input.content;
    const title = deriveTitle(titleSourceFor(input), input.metadata);
    const explicitSource = input.provenance?.sourceId;
    const ingestInput =
      explicitSource !== undefined ? { title, text, source: explicitSource } : { title, text };
    const res: LlmwikiIngestResult = await this.wiki.ingestText(ingestInput);
    const id = buildLiveExternalId(this.projectId, res.filename);
    return mapWriteStatus(res.writeStatus, id);
  }

  protected async doGet(ref: MemoryRef): Promise<Memory | null> {
    this.assertScope(ref.scope, "get");
    const { filename } = parseLiveExternalId(ref.id, this.projectId);
    const rec = await this.wiki.getSource(filename);
    return rec === null ? null : sourceToMemory(rec, this.projectId, this.liveScope);
  }

  protected async doDelete(ref: MemoryRef): Promise<void> {
    this.assertScope(ref.scope, "delete");
    const { filename } = parseLiveExternalId(ref.id, this.projectId);
    // Returns false when absent — idempotent, intentional no-op.
    await this.wiki.deleteSource(filename);
  }

  protected async doList(request: ListRequest): Promise<ListResultPage> {
    this.assertScope(request.scope, "list");
    normalizeLimit(request.limit);
    const opts = buildListOptions(request);
    const page = await this.wiki.listSources(opts);
    const memories = page.sources.map((r) => sourceToMemory(r, this.projectId, this.liveScope));
    return page.cursor !== undefined ? { memories, cursor: page.cursor } : { memories };
  }

  protected async doSearch(request: SearchRequest): Promise<SearchResultPage> {
    this.assertScope(request.scope, "search");
    // Loads every source body (includeBody) to score — O(all-sources) per search; the A-side manifest limitation carries over.
    const { sources } = await this.wiki.listSources({ includeBody: true });
    const limit = normalizeLimit(request.limit) ?? DEFAULT_SEARCH_LIMIT;
    const results = buildSearchResults(sources, request.query, this.projectId, this.liveScope, limit, request.threshold);
    return { results };
  }

  /**
   * `Packager` extension. Reachable via `provider.getExtension<Packager>("package")`
   * because `BaseMemoryProvider.resolveExtension` returns `this` when
   * `capabilities().extensions.package` is true.
   */
  async package(request: PackageRequest): Promise<ContextPackage> {
    const { results } = await this.search(request);
    const budget = normalizeTokenBudget(request.tokenBudget, DEFAULT_TOKEN_BUDGET);
    return buildSourceContextPackage(results, budget, this.tokenize);
  }

  /** Explicit compile — NOT part of ingest. Requires LLM credentials and the construction scope. */
  // fallow-ignore-next-line unused-class-member
  async compile(scope: Scope): ReturnType<Wiki["compile"]> {
    this.assertScope(scope, "compile");
    return this.wiki.compile();
  }

  /**
   * Guard every operation against cross-partition traffic. All four Scope fields
   * (`user`, `agent`, `namespace`, `thread`) must exactly match the construction
   * scope — any difference (broader or narrower) is rejected because this provider
   * stores all data under one root with no per-field sub-filtering.
   */
  // fallow-ignore-next-line complexity
  private assertScope(requestScope: Scope, op: string): void {
    const SCOPE_FIELDS = ["user", "agent", "namespace", "thread"] as const;
    const matches = SCOPE_FIELDS.every((f) => requestScope[f] === this.liveScope[f]);
    if (!matches) {
      throw new LLMWikiBridgeError(
        E_LLMWIKI_PROVIDER_SCOPE_MISMATCH,
        `LiveLLMWikiProvider.${op}() rejected: request scope does not match the provider's ` +
          "construction scope on all fields (user, agent, namespace, thread). This provider is " +
          "single-tenant over one root; construct one provider per scope.",
      );
    }
  }
}

/**
 * Returns the text that should be used as the title source for an ingest input.
 * For messages mode, uses the first non-empty message content so the title reflects
 * real content rather than the "[role]" marker that leads the flattened body.
 * For text/verbatim modes, uses the content directly.
 */
function titleSourceFor(input: IngestInput): string {
  if (input.mode !== "messages") return input.content;
  return input.messages.find((m) => m.content.trim().length > 0)?.content ?? "";
}

/** Map a llmwiki WriteStatus to an SDK IngestResult with a single id. */
function mapWriteStatus(status: LlmwikiIngestResult["writeStatus"], id: string): IngestResult {
  if (status === "created") return { created: [id], updated: [], unchanged: [] };
  if (status === "updated") return { created: [], updated: [id], unchanged: [] };
  return { created: [], updated: [], unchanged: [id] };
}

/** Build listSources options from an SDK ListRequest, omitting undefined fields. */
function buildListOptions(request: ListRequest): { includeBody: boolean; cursor?: string; limit?: number } {
  const opts: { includeBody: boolean; cursor?: string; limit?: number } = { includeBody: true };
  if (request.cursor !== undefined) opts.cursor = request.cursor;
  if (request.limit !== undefined) opts.limit = request.limit;
  return opts;
}

/** Score a source record against a query — title hit = +2, body hit = +1. */
// fallow-ignore-next-line complexity
function scoreSource(rec: SourceRecord, query: string): number {
  const q = query.toLowerCase();
  if (q.length === 0) return 0;
  let score = 0;
  if ((rec.body ?? "").toLowerCase().includes(q)) score += 1;
  if (rec.title.toLowerCase().includes(q)) score += 2;
  return score;
}

/** Produce a sorted, threshold-filtered, limited SearchResult array from a source list. */
function buildSearchResults(
  sources: SourceRecord[],
  query: string,
  projectId: string,
  scope: Scope,
  limit: number,
  threshold?: number,
): SearchResult[] {
  const scored = sources
    .map((r) => ({ r, score: scoreSource(r, query) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  const withRelevance = scored.map(({ r, score }) => ({
    memory: sourceToMemory(r, projectId, scope),
    score,
    relevance: score / MAX_SOURCE_SCORE,
  }));
  const aboveThreshold =
    threshold !== undefined ? withRelevance.filter((x) => (x.relevance ?? 0) >= threshold) : withRelevance;
  return aboveThreshold.slice(0, limit);
}

/**
 * Pack results in priority order until the budget runs out, then stop.
 * NOT a knapsack: if hit #1 doesn't fit, the package is empty even if #2 would fit.
 *
 * Each included body is wrapped in an untrusted-source fence (README:128) so the
 * consuming LLM sees a structural boundary and can apply appropriate trust policy.
 * Token cost is measured on the raw body; the fence tags add a small fixed overhead
 * (documented as acceptable — the fence overhead is O(1) per item, not O(body)).
 */
function buildSourceContextPackage(
  results: SearchResult[],
  tokenBudget: number,
  tokenize: (text: string) => number,
): ContextPackage {
  const pieces: string[] = [];
  const chosen: SearchResult[] = [];
  let tokens = 0;
  let budgetConstrained = false;
  for (const r of results) {
    const cost = tokenize(r.memory.content);
    if (tokens + cost > tokenBudget) {
      budgetConstrained = true;
      break;
    }
    chosen.push(r);
    tokens += cost;
    pieces.push(fenceUntrustedSource(r.memory.id, r.memory.content));
  }
  return {
    text: pieces.join("\n\n"),
    results: chosen,
    tokens,
    budgetConstrained,
  };
}
