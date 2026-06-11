/**
 * @file Integration coverage: SDK `MemoryClient` configured with a
 * custom llmwiki provider registry returns `Memory` results.
 *
 * Exercises the registration path consumers actually use — registry
 * entry + provider config + `initialize()` → `client.search()`. The
 * unit tests in `provider.test.ts` cover the provider's own methods;
 * this file proves the wiring through the SDK client surface.
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryClient } from "@atomicmemory/sdk";
import { loadLLMWikiExport } from "../load-export.ts";
import { snapshotLlmwikiProviderFactory } from "../registration.ts";
import { E_LLMWIKI_PROVIDER_SCOPE_MISMATCH, LLMWikiBridgeError } from "../errors.ts";
import type { LLMWikiExport } from "../schema.ts";

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "..", "test-fixtures",
  "demo-kb-export.json",
);

describe("MemoryClient with llmwiki registry", () => {
  let exportData: LLMWikiExport;

  before(async () => {
    exportData = await loadLLMWikiExport(FIXTURE);
  });

  it("registers + initializes the SnapshotLLMWikiProvider through the SDK client", async () => {
    const client = new MemoryClient({
      providers: { llmwiki: { exportData, scope: { user: "client-test" } } },
      defaultProvider: "llmwiki",
    });
    await client.initialize({ llmwiki: snapshotLlmwikiProviderFactory });
    const caps = client.capabilities();
    assert.deepEqual(caps.ingestModes, []);
    assert.equal(caps.extensions.package, true);
  });

  it("client.search returns Memory results carrying advisory metadata", async () => {
    const client = new MemoryClient({
      providers: { llmwiki: { exportData, scope: { user: "client-test" } } },
      defaultProvider: "llmwiki",
    });
    await client.initialize({ llmwiki: snapshotLlmwikiProviderFactory });
    const page = await client.search({ query: "Chunking", scope: { user: "client-test" } });
    assert.ok(page.results.length > 0);
    const first = page.results[0]!;
    assert.equal(first.memory.id, "llmwiki/demo-kb/concepts/chunking");
    const meta = first.memory.metadata as { llmwiki: { title: string } };
    assert.equal(meta.llmwiki.title, "Chunking");
    // P3: search emits normalized relevance in [0,1].
    assert.ok(first.relevance !== undefined && first.relevance > 0 && first.relevance <= 1);
  });

  it("client.search() across user scopes throws scope-mismatch", async () => {
    const client = new MemoryClient({
      providers: { llmwiki: { exportData, scope: { user: "alice" } } },
      defaultProvider: "llmwiki",
    });
    await client.initialize({ llmwiki: snapshotLlmwikiProviderFactory });
    await assert.rejects(
      () => client.search({ query: "chunking", scope: { user: "bob" } }),
      (err: unknown) =>
        err instanceof LLMWikiBridgeError && err.code === E_LLMWIKI_PROVIDER_SCOPE_MISMATCH,
    );
  });
});
