/**
 * @file End-to-end integration: `liveLlmwikiLazyEntry` wired through
 * `MemoryClient` at the documented usage level.
 *
 * Exercises the lazy-registration path from client construction through
 * `initialize()`, then performs CRUD ops, search, capability inspection,
 * scope-mismatch fencing, and idempotent re-initialization.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MemoryClient } from "@atomicmemory/sdk";
import { liveLlmwikiLazyEntry } from "../register.ts";
import { LLMWikiBridgeError, E_LLMWIKI_PROVIDER_SCOPE_MISMATCH } from "../errors.ts";

const scope = { user: "u1" };

async function makeClient(): Promise<MemoryClient> {
  const root = await mkdtemp(path.join(tmpdir(), "register-int-"));
  const client = new MemoryClient({
    providers: { "llmwiki-live": { root, projectId: "proj-1", scope } },
    defaultProvider: "llmwiki-live",
  });
  await client.initialize({ "llmwiki-live": liveLlmwikiLazyEntry() });
  return client;
}

describe("liveLlmwikiLazyEntry through MemoryClient (documented usage)", () => {
  it("full CRUD round-trip through client-level ops on the default provider", async () => {
    const client = await makeClient();
    const r = await client.ingest({
      mode: "text",
      content: "The Zanzibar consistency model is a comfortably long body for integration testing.",
      scope,
      metadata: { title: "Note" },
    });
    assert.ok(r.created.length > 0, "expected at least one created id");
    const id = r.created[0] as string;

    const got = await client.get({ id, scope });
    assert.ok(got, "get should return the ingested memory");

    const page = await client.list({ scope });
    assert.ok(page.memories.some((m) => m.id === id), "list should include ingested id");

    await client.delete({ id, scope });
    assert.equal(await client.get({ id, scope }), null, "get after delete should return null");
  });

  it("client.search finds ingested content through the lazy-registered provider", async () => {
    const client = await makeClient();
    await client.ingest({
      mode: "text",
      content: "The Zanzibar consistency model is a comfortably long body for integration testing.",
      scope,
      metadata: { title: "Zanzibar" },
    });
    const results = await client.search({ query: "Zanzibar", scope });
    assert.ok(results.results.length > 0, "search should find ingested content");
    // The hit must actually be the ingested doc, not an incidental match.
    assert.match(results.results[0]!.memory.content, /Zanzibar/);
  });

  it("capabilities() reflects the lazily-constructed live provider", async () => {
    const client = await makeClient();
    const caps = client.capabilities("llmwiki-live");
    // The live provider's exact modes (mirrors live-provider.test.ts) — proves
    // the lazy path constructed the RIGHT provider, not just any provider.
    assert.deepEqual(caps.ingestModes, ["text", "messages", "verbatim"]);
    assert.equal(caps.extensions.package, true);
  });

  it("the scope trust boundary survives the lazy registration path", async () => {
    const client = await makeClient();
    await assert.rejects(
      () => client.ingest({
        mode: "text",
        content: "cross-tenant write attempt body, long enough for ingest.",
        scope: { user: "u2" },
        metadata: { title: "X" },
      }),
      (e: unknown) => e instanceof LLMWikiBridgeError && e.code === E_LLMWIKI_PROVIDER_SCOPE_MISMATCH,
    );
  });

  it("initialize is idempotent (second call is a no-op, provider still works)", async () => {
    const client = await makeClient();
    // Second initialize with a fresh entry — must be a no-op, not re-construct
    await client.initialize({ "llmwiki-live": liveLlmwikiLazyEntry() });
    const r = await client.ingest({
      mode: "text",
      content: "Idempotent re-initialize check with a comfortably long body.",
      scope,
      metadata: { title: "Idem" },
    });
    assert.ok(r.created[0], "ingest after idempotent re-initialize should still work");
  });
});
