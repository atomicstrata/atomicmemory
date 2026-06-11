/**
 * @file SnapshotLLMWikiProvider tests.
 *
 * Covers the four read-only provider behaviors: search returns Memory
 * results, package returns a ContextPackage, list/get traverse the
 * loaded export, mutation calls fail with a clear unsupported error.
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryProviderError, type Packager, type Scope } from "@atomicmemory/sdk";
import { loadLLMWikiExport } from "../load-export.ts";
import { SnapshotLLMWikiProvider } from "../provider.ts";
import {
  E_LLMWIKI_EXPORT_DUPLICATE_SLUG,
  E_LLMWIKI_PROVIDER_DISPOSED,
  E_LLMWIKI_PROVIDER_INVALID_CURSOR,
  E_LLMWIKI_PROVIDER_READONLY,
  E_LLMWIKI_PROVIDER_SCOPE_MISMATCH,
  LLMWikiBridgeError,
} from "../errors.ts";
import type { LLMWikiExport } from "../schema.ts";

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "..", "test-fixtures",
  "demo-kb-export.json",
);

const SCOPE: Scope = { user: "tester", namespace: "bridge" };

describe("SnapshotLLMWikiProvider", () => {
  let exportData: LLMWikiExport;
  let provider: SnapshotLLMWikiProvider;

  before(async () => {
    exportData = await loadLLMWikiExport(FIXTURE);
    provider = new SnapshotLLMWikiProvider({ exportData, scope: SCOPE });
  });

  it("advertises read-only capabilities (no ingest modes, package extension on)", () => {
    const caps = provider.capabilities();
    assert.deepEqual(caps.ingestModes, []);
    assert.equal(caps.extensions.package, true);
    assert.equal(caps.extensions.update, false);
  });

  it("list() returns every page in the export with deterministic IDs", async () => {
    const page = await provider.list({ scope: SCOPE });
    assert.equal(page.memories.length, 3);
    const ids = page.memories.map((m) => m.id).sort();
    assert.deepEqual(ids, [
      "llmwiki/demo-kb/concepts/chunking",
      "llmwiki/demo-kb/concepts/retrieval",
      "llmwiki/demo-kb/queries/what-is-retrieval",
    ]);
  });

  it("get() returns a Memory with metadata.llmwiki populated", async () => {
    const memory = await provider.get({
      id: "llmwiki/demo-kb/concepts/chunking",
      scope: SCOPE,
    });
    assert.ok(memory);
    const llmwiki = (memory.metadata as { llmwiki: { title: string; advisoryConfidence: number } }).llmwiki;
    assert.equal(llmwiki.title, "Chunking");
    assert.equal(llmwiki.advisoryConfidence, 0.7);
  });

  it("get() returns null for an unknown id", async () => {
    const memory = await provider.get({ id: "llmwiki/demo-kb/concepts/missing", scope: SCOPE });
    assert.equal(memory, null);
  });

  it("search() matches case-insensitively and weights title hits higher than body hits", async () => {
    const page = await provider.search({ query: "Chunking", scope: SCOPE });
    assert.ok(page.results.length > 0);
    assert.equal(page.results[0]!.memory.id, "llmwiki/demo-kb/concepts/chunking");
  });

  it("search() returns Memory results carrying advisory metadata", async () => {
    const page = await provider.search({ query: "retrieval", scope: SCOPE });
    const first = page.results.find(
      (r) => r.memory.id === "llmwiki/demo-kb/concepts/retrieval",
    );
    assert.ok(first);
    const meta = first.memory.metadata as { llmwiki: { kind: string } };
    assert.equal(meta.llmwiki.kind, "concept");
  });

  it("package() returns a ContextPackage built from search hits", async () => {
    const pack = await provider.package({ query: "retrieval", scope: SCOPE });
    assert.ok(pack.text.length > 0);
    assert.ok(pack.results.length >= 1);
    assert.ok(pack.tokens > 0);
    assert.equal(pack.budgetConstrained, false);
  });

  it("package() marks budgetConstrained=true when token budget forces truncation", async () => {
    const pack = await provider.package({ query: "retrieval", scope: SCOPE, tokenBudget: 1 });
    assert.equal(pack.budgetConstrained, true);
    assert.equal(pack.results.length, 0);
  });

  it("ingest() rejects with E_LLMWIKI_PROVIDER_READONLY", async () => {
    await assert.rejects(
      () => provider.ingest({ mode: "verbatim", scope: SCOPE, content: "x" }),
      (err: unknown) =>
        err instanceof LLMWikiBridgeError && err.code === E_LLMWIKI_PROVIDER_READONLY,
    );
  });

  it("delete() rejects with E_LLMWIKI_PROVIDER_READONLY", async () => {
    await assert.rejects(
      () => provider.delete({ id: "x", scope: SCOPE }),
      (err: unknown) =>
        err instanceof LLMWikiBridgeError && err.code === E_LLMWIKI_PROVIDER_READONLY,
    );
  });

  it("list() rejects a fabricated/non-numeric cursor with E_LLMWIKI_PROVIDER_INVALID_CURSOR (H1)", async () => {
    await assert.rejects(
      () => provider.list({ scope: SCOPE, cursor: "abc" }),
      (err: unknown) =>
        err instanceof LLMWikiBridgeError && err.code === E_LLMWIKI_PROVIDER_INVALID_CURSOR,
    );
  });

  it("list() rejects a negative cursor with E_LLMWIKI_PROVIDER_INVALID_CURSOR (H1)", async () => {
    await assert.rejects(
      () => provider.list({ scope: SCOPE, cursor: "-1" }),
      (err: unknown) =>
        err instanceof LLMWikiBridgeError && err.code === E_LLMWIKI_PROVIDER_INVALID_CURSOR,
    );
  });

  it("provider.getExtension<Packager>('package') returns a usable Packager (F1)", async () => {
    const packager = provider.getExtension<Packager>("package");
    assert.ok(packager, "expected getExtension('package') to return a non-nullish Packager");
    const pack = await packager.package({ query: "retrieval", scope: SCOPE });
    assert.ok(pack.text.length > 0);
  });

  it("LLMWikiBridgeError is catchable as MemoryProviderError (F2)", async () => {
    let caught: unknown;
    try {
      await provider.search({ query: "x", scope: { user: "wrong-user" } });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof LLMWikiBridgeError, "expected an LLMWikiBridgeError");
    assert.ok(caught instanceof MemoryProviderError, "expected it to also be a MemoryProviderError");
    assert.equal((caught as MemoryProviderError).provider, "llmwiki");
  });

  it("search() with no limit returns at most DEFAULT_SEARCH_LIMIT results (H2)", async () => {
    // The fixture only has 3 pages — we're asserting that the default
    // is finite (not the entire export), not the specific value here.
    const page = await provider.search({ query: "x", scope: SCOPE });
    assert.ok(page.results.length <= 25);
  });

  it("scope-mismatch error does NOT leak the construction scope (M8)", async () => {
    const provider = new SnapshotLLMWikiProvider({
      exportData,
      scope: { user: "real-alice" },
    });
    try {
      await provider.search({ query: "x", scope: { user: "attacker" } });
      assert.fail("expected scope mismatch");
    } catch (err) {
      assert.ok(err instanceof LLMWikiBridgeError);
      assert.equal(err.code, E_LLMWIKI_PROVIDER_SCOPE_MISMATCH);
      assert.equal(/real-alice/.test(err.message), false);
      assert.equal(/attacker/.test(err.message), false);
    }
  });
});

describe("SnapshotLLMWikiProvider — dispose (H9)", () => {
  it("dispose() makes every subsequent read throw E_LLMWIKI_PROVIDER_DISPOSED", async () => {
    const exportData = await loadLLMWikiExport(FIXTURE);
    const provider = new SnapshotLLMWikiProvider({ exportData, scope: SCOPE });
    provider.dispose();
    await assert.rejects(
      () => provider.search({ query: "x", scope: SCOPE }),
      (err: unknown) =>
        err instanceof LLMWikiBridgeError && err.code === E_LLMWIKI_PROVIDER_DISPOSED,
    );
    await assert.rejects(
      () => provider.list({ scope: SCOPE }),
      (err: unknown) =>
        err instanceof LLMWikiBridgeError && err.code === E_LLMWIKI_PROVIDER_DISPOSED,
    );
    await assert.rejects(
      () => provider.get({ id: "x", scope: SCOPE }),
      (err: unknown) =>
        err instanceof LLMWikiBridgeError && err.code === E_LLMWIKI_PROVIDER_DISPOSED,
    );
  });

  it("dispose() is idempotent", async () => {
    const exportData = await loadLLMWikiExport(FIXTURE);
    const provider = new SnapshotLLMWikiProvider({ exportData, scope: SCOPE });
    provider.dispose();
    provider.dispose();
    provider.dispose();
  });
});

describe("SnapshotLLMWikiProvider — tag-boundary matching (M9)", () => {
  it("does not let cross-tag concatenation produce phantom matches", async () => {
    // Old behavior joined tags with a space, so a query "vue angular"
    // would match a page tagged ["vue", "angular"] via the joined
    // "vue angular" haystack even though no tag itself contained
    // that string. The "#" separator suppresses that.
    const exportData: LLMWikiExport = {
      exportedAt: "x",
      pageCount: 1,
      projectId: "kb",
      pages: [
        {
          title: "Stack",
          slug: "stack",
          pageDirectory: "concepts",
          path: "wiki/concepts/stack.md",
          summary: "",
          sources: [],
          tags: ["vue", "angular"],
          createdAt: "x",
          updatedAt: "x",
          links: [],
          body: "irrelevant body",
          citations: [],
          advisoryFreshnessStatus: "unverified",
        },
      ],
    };
    const provider = new SnapshotLLMWikiProvider({ exportData, scope: { user: "u" } });
    const page = await provider.search({ query: "vue angular", scope: { user: "u" } });
    assert.equal(page.results.length, 0);
  });
});

describe("SnapshotLLMWikiProvider construction scope validation (FIX G)", () => {
  const minimalExport: LLMWikiExport = {
    exportedAt: "x",
    pageCount: 0,
    projectId: "kb",
    pages: [],
  };

  it("throws E_LLMWIKI_PROVIDER_SCOPE_MISMATCH when scope is empty {}", () => {
    assert.throws(
      () => new SnapshotLLMWikiProvider({ exportData: minimalExport, scope: {} }),
      (e: unknown) => (e as { code?: string })?.code === "E_LLMWIKI_PROVIDER_SCOPE_MISMATCH",
    );
  });

  it("throws E_LLMWIKI_PROVIDER_SCOPE_MISMATCH when 'user' is missing", () => {
    assert.throws(
      () => new SnapshotLLMWikiProvider({ exportData: minimalExport, scope: { namespace: "ns" } }),
      (e: unknown) => (e as { code?: string })?.code === "E_LLMWIKI_PROVIDER_SCOPE_MISMATCH",
    );
  });

  it("throws E_LLMWIKI_PROVIDER_SCOPE_MISMATCH when 'user' is empty string", () => {
    assert.throws(
      () => new SnapshotLLMWikiProvider({ exportData: minimalExport, scope: { user: "" } }),
      (e: unknown) => (e as { code?: string })?.code === "E_LLMWIKI_PROVIDER_SCOPE_MISMATCH",
    );
  });

  it("valid scope { user: 'u1' } constructs without throwing", () => {
    assert.doesNotThrow(
      () => new SnapshotLLMWikiProvider({ exportData: minimalExport, scope: { user: "u1" } }),
    );
  });
});

describe("SnapshotLLMWikiProvider — duplicate-slug guard", () => {
  it("throws E_LLMWIKI_EXPORT_DUPLICATE_SLUG when two pages share (pageDirectory, slug) (H4)", () => {
    const dupExport: LLMWikiExport = {
      exportedAt: "x",
      pageCount: 2,
      projectId: "kb",
      pages: [
        {
          title: "First",
          slug: "shared",
          pageDirectory: "concepts",
          path: "wiki/concepts/shared.md",
          summary: "",
          sources: [],
          tags: [],
          createdAt: "x",
          updatedAt: "x",
          links: [],
          body: "first body",
          citations: [],
          advisoryFreshnessStatus: "unverified",
        },
        {
          title: "Second",
          slug: "shared",
          pageDirectory: "concepts",
          path: "wiki/concepts/shared.md",
          summary: "",
          sources: [],
          tags: [],
          createdAt: "x",
          updatedAt: "x",
          links: [],
          body: "second body",
          citations: [],
          advisoryFreshnessStatus: "unverified",
        },
      ],
    };
    assert.throws(
      () => new SnapshotLLMWikiProvider({ exportData: dupExport, scope: { user: "u" } }),
      (err: unknown) =>
        err instanceof LLMWikiBridgeError && err.code === E_LLMWIKI_EXPORT_DUPLICATE_SLUG,
    );
  });
});

describe("SnapshotLLMWikiProvider invalid limit rejection", () => {
  const exportData: LLMWikiExport = {
    exportedAt: "x",
    pageCount: 1,
    projectId: "kb",
    pages: [
      {
        title: "Alpha",
        slug: "alpha",
        pageDirectory: "concepts",
        path: "wiki/concepts/alpha.md",
        summary: "",
        sources: [],
        tags: [],
        createdAt: "x",
        updatedAt: "x",
        links: [],
        body: "alpha body text",
        citations: [],
        advisoryFreshnessStatus: "unverified",
      },
    ],
  };
  const scope: Scope = { user: "u" };

  it("list with limit 0 throws E_LLMWIKI_PROVIDER_INVALID_LIMIT", async () => {
    const p = new SnapshotLLMWikiProvider({ exportData, scope });
    await assert.rejects(
      () => p.list({ scope, limit: 0 }),
      (e: unknown) => (e as { code?: string })?.code === "E_LLMWIKI_PROVIDER_INVALID_LIMIT",
    );
  });

  it("list with limit -1 throws E_LLMWIKI_PROVIDER_INVALID_LIMIT", async () => {
    const p = new SnapshotLLMWikiProvider({ exportData, scope });
    await assert.rejects(
      () => p.list({ scope, limit: -1 }),
      (e: unknown) => (e as { code?: string })?.code === "E_LLMWIKI_PROVIDER_INVALID_LIMIT",
    );
  });

  it("search with limit -1 throws E_LLMWIKI_PROVIDER_INVALID_LIMIT", async () => {
    const p = new SnapshotLLMWikiProvider({ exportData, scope });
    await assert.rejects(
      () => p.search({ query: "alpha", scope, limit: -1 }),
      (e: unknown) => (e as { code?: string })?.code === "E_LLMWIKI_PROVIDER_INVALID_LIMIT",
    );
  });

  it("search with non-integer limit 1.5 throws E_LLMWIKI_PROVIDER_INVALID_LIMIT", async () => {
    const p = new SnapshotLLMWikiProvider({ exportData, scope });
    await assert.rejects(
      () => p.search({ query: "alpha", scope, limit: 1.5 }),
      (e: unknown) => (e as { code?: string })?.code === "E_LLMWIKI_PROVIDER_INVALID_LIMIT",
    );
  });

  it("undefined limit on list works (no-limit preserved)", async () => {
    const p = new SnapshotLLMWikiProvider({ exportData, scope });
    const page = await p.list({ scope });
    assert.ok(page.memories.length >= 1, "undefined limit should not restrict results");
  });
});

describe("SnapshotLLMWikiProvider threshold filtering", () => {
  // scorePage: body-only hit => score=1, relevance=0.333; title hit => score=3, relevance=1.0
  const makeExport = (...pages: Array<{ title: string; slug: string; body: string }>): LLMWikiExport => ({
    exportedAt: "x",
    pageCount: pages.length,
    projectId: "kb",
    pages: pages.map((p) => ({
      title: p.title,
      slug: p.slug,
      pageDirectory: "concepts" as const,
      path: `wiki/concepts/${p.slug}.md`,
      summary: "",
      sources: [],
      tags: [],
      createdAt: "x",
      updatedAt: "x",
      links: [],
      body: p.body,
      citations: [],
      advisoryFreshnessStatus: "unverified" as const,
    })),
  });
  const scope: Scope = { user: "u" };

  it("search with high threshold excludes body-only hits (relevance 0.333)", async () => {
    const exportData = makeExport({ title: "Unrelated", slug: "unrelated", body: "delta info" });
    const p = new SnapshotLLMWikiProvider({ exportData, scope });
    const page = await p.search({ query: "delta", scope, threshold: 0.9 });
    assert.equal(page.results.length, 0, "body-only hit should be excluded by threshold 0.9");
  });

  it("search with 0.5 threshold passes title hit but excludes body-only hit", async () => {
    const exportData = makeExport(
      { title: "Unrelated", slug: "unrelated", body: "epsilon info" },
      { title: "Epsilon Guide", slug: "epsilon-guide", body: "some other text" },
    );
    const p = new SnapshotLLMWikiProvider({ exportData, scope });
    const page = await p.search({ query: "epsilon", scope, threshold: 0.5 });
    assert.equal(page.results.length, 1, "only title hit should pass threshold 0.5");
    assert.ok((page.results[0]!.relevance ?? 0) >= 0.5, "result relevance must meet threshold");
  });
});

describe("SnapshotLLMWikiProvider package() — tokenBudget validation (FIX H)", () => {
  const minExport: LLMWikiExport = {
    exportedAt: "x",
    pageCount: 0,
    projectId: "kb",
    pages: [],
  };
  const scope: Scope = { user: "u" };
  const INVALID_BUDGET_CODE = "E_LLMWIKI_PROVIDER_INVALID_BUDGET";

  it("rejects tokenBudget: NaN with E_LLMWIKI_PROVIDER_INVALID_BUDGET", async () => {
    const p = new SnapshotLLMWikiProvider({ exportData: minExport, scope });
    await assert.rejects(
      () => p.package({ query: "x", scope, tokenBudget: NaN }),
      (e: unknown) => (e as { code?: string })?.code === INVALID_BUDGET_CODE,
    );
  });

  it("rejects tokenBudget: Infinity with E_LLMWIKI_PROVIDER_INVALID_BUDGET", async () => {
    const p = new SnapshotLLMWikiProvider({ exportData: minExport, scope });
    await assert.rejects(
      () => p.package({ query: "x", scope, tokenBudget: Infinity }),
      (e: unknown) => (e as { code?: string })?.code === INVALID_BUDGET_CODE,
    );
  });

  it("rejects tokenBudget: 0 with E_LLMWIKI_PROVIDER_INVALID_BUDGET", async () => {
    const p = new SnapshotLLMWikiProvider({ exportData: minExport, scope });
    await assert.rejects(
      () => p.package({ query: "x", scope, tokenBudget: 0 }),
      (e: unknown) => (e as { code?: string })?.code === INVALID_BUDGET_CODE,
    );
  });

  it("rejects tokenBudget: -5 with E_LLMWIKI_PROVIDER_INVALID_BUDGET", async () => {
    const p = new SnapshotLLMWikiProvider({ exportData: minExport, scope });
    await assert.rejects(
      () => p.package({ query: "x", scope, tokenBudget: -5 }),
      (e: unknown) => (e as { code?: string })?.code === INVALID_BUDGET_CODE,
    );
  });

  it("rejects tokenBudget: 1.5 with E_LLMWIKI_PROVIDER_INVALID_BUDGET", async () => {
    const p = new SnapshotLLMWikiProvider({ exportData: minExport, scope });
    await assert.rejects(
      () => p.package({ query: "x", scope, tokenBudget: 1.5 }),
      (e: unknown) => (e as { code?: string })?.code === INVALID_BUDGET_CODE,
    );
  });

  it("accepts valid tokenBudget: 1000", async () => {
    const p = new SnapshotLLMWikiProvider({ exportData: minExport, scope });
    const pkg = await p.package({ query: "x", scope, tokenBudget: 1000 });
    assert.ok(typeof pkg.tokens === "number");
  });

  it("omitted tokenBudget uses the 32_000 default without throwing", async () => {
    const p = new SnapshotLLMWikiProvider({ exportData: minExport, scope });
    const pkg = await p.package({ query: "x", scope });
    assert.ok(typeof pkg.tokens === "number");
  });
});

describe("SnapshotLLMWikiProvider scope isolation (all fields + copy)", () => {
  const sA: Scope = { user: "u1", namespace: "tenant-a" };
  const sB: Scope = { user: "u1", namespace: "tenant-b" };

  const isolationExport: LLMWikiExport = {
    exportedAt: "x",
    pageCount: 1,
    projectId: "proj-1",
    pages: [
      {
        title: "Alpha",
        slug: "alpha",
        pageDirectory: "concepts",
        path: "wiki/concepts/alpha.md",
        summary: "",
        sources: [],
        tags: [],
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        links: [],
        body: "alpha body",
        citations: [],
        advisoryFreshnessStatus: "unverified",
      },
    ],
  };

  // External id: buildExternalId("proj-1", "concepts", "alpha") = "llmwiki/proj-1/concepts/alpha"
  const pageId = "llmwiki/proj-1/concepts/alpha";

  it("rejects a same-user different-namespace request on every read op", () => {
    const p = new SnapshotLLMWikiProvider({ exportData: isolationExport, scope: sA, projectIdOverride: "proj-1" });
    return Promise.all([
      assert.rejects(() => p.get({ id: pageId, scope: sB }), (e: unknown) => (e as { code?: string })?.code === E_LLMWIKI_PROVIDER_SCOPE_MISMATCH),
      assert.rejects(() => p.list({ scope: sB }), (e: unknown) => (e as { code?: string })?.code === E_LLMWIKI_PROVIDER_SCOPE_MISMATCH),
      assert.rejects(() => p.search({ query: "x", scope: sB }), (e: unknown) => (e as { code?: string })?.code === E_LLMWIKI_PROVIDER_SCOPE_MISMATCH),
      assert.rejects(() => p.package({ query: "x", scope: sB }), (e: unknown) => (e as { code?: string })?.code === E_LLMWIKI_PROVIDER_SCOPE_MISMATCH),
    ]);
  });

  it("matching full scope (incl. namespace) is accepted", async () => {
    const p = new SnapshotLLMWikiProvider({ exportData: isolationExport, scope: sA, projectIdOverride: "proj-1" });
    const memory = await p.get({ id: pageId, scope: sA });
    assert.ok(memory);
  });

  it("mutating the original construction scope object does not re-tenant", async () => {
    const ctorScope: { user: string; namespace: string } = { user: "u1", namespace: "tenant-a" };
    const p = new SnapshotLLMWikiProvider({ exportData: isolationExport, scope: ctorScope, projectIdOverride: "proj-1" });
    ctorScope.namespace = "tenant-b";
    await assert.rejects(
      () => p.list({ scope: { user: "u1", namespace: "tenant-b" } }),
      (e: unknown) => (e as { code?: string })?.code === E_LLMWIKI_PROVIDER_SCOPE_MISMATCH,
    );
    const memory = await p.get({ id: pageId, scope: { user: "u1", namespace: "tenant-a" } });
    assert.ok(memory);
  });
});
