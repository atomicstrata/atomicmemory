/**
 * toAtomicMemoryIngestInputs: metadata preservation, deterministic
 * identity, and re-import mapping (3 of the 5 doc-required cases).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Scope, VerbatimIngest } from "@atomicmemory/sdk";
import { loadLLMWikiExport } from "../load-export.ts";
import { toAtomicMemoryIngestInputs } from "../to-ingest-inputs.ts";
import {
  E_LLMWIKI_PROJECT_ID_INVALID,
  E_LLMWIKI_PROJECT_ID_REQUIRED,
  LLMWikiBridgeError,
} from "../errors.ts";

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "..", "test-fixtures",
  "demo-kb-export.json",
);

const SCOPE: Scope = { user: "test", namespace: "bridge" };

function findInput(inputs: VerbatimIngest[], slug: string): VerbatimIngest {
  const found = inputs.find(
    (input) => (input.metadata as { llmwiki: { slug: string } }).llmwiki.slug === slug,
  );
  if (!found) throw new Error(`expected ingest input with slug ${slug}`);
  return found;
}

describe("toAtomicMemoryIngestInputs — metadata preservation", () => {
  it("forwards every advisory field under metadata.llmwiki.* on the verbatim path", async () => {
    const data = await loadLLMWikiExport(FIXTURE);
    const inputs = toAtomicMemoryIngestInputs(data, { scope: SCOPE }) as VerbatimIngest[];
    const chunking = findInput(inputs, "chunking");
    assert.equal(chunking.mode, "verbatim");
    const llmwiki = (chunking.metadata as { llmwiki: Record<string, unknown> }).llmwiki;
    assert.equal(llmwiki.kind, "concept");
    assert.equal(llmwiki.advisoryConfidence, 0.7);
    assert.equal(llmwiki.provenanceState, "merged");
    assert.deepEqual(llmwiki.aliases, ["llmwiki/demo/concepts/segmentation"]);
    assert.deepEqual(llmwiki.contradictedBy, [
      { slug: "sliding-window", reason: "chunk-vs-stream paradigm conflict" },
    ]);
    assert.equal(llmwiki.advisoryFreshnessStatus, "unverified");
  });

  it("stamps every ingest input with trustLevel='external-import' and version=1 (B5/M6)", async () => {
    const data = await loadLLMWikiExport(FIXTURE);
    const inputs = toAtomicMemoryIngestInputs(data, { scope: SCOPE }) as VerbatimIngest[];
    for (const input of inputs) {
      const llmwiki = (input.metadata as { llmwiki: Record<string, unknown> }).llmwiki;
      assert.equal(llmwiki.trustLevel, "external-import");
      assert.equal(llmwiki.version, 1);
    }
  });

  it("stamps provenance.extractor='llmwiki' so SDK consumers can branch on it (B5-corrected)", async () => {
    const data = await loadLLMWikiExport(FIXTURE);
    const inputs = toAtomicMemoryIngestInputs(data, { scope: SCOPE }) as VerbatimIngest[];
    for (const input of inputs) {
      assert.equal(input.provenance?.extractor, "llmwiki");
    }
  });

  it("forwards body content verbatim onto VerbatimIngest.content", async () => {
    const data = await loadLLMWikiExport(FIXTURE);
    const inputs = toAtomicMemoryIngestInputs(data, { scope: SCOPE }) as VerbatimIngest[];
    const retrieval = findInput(inputs, "retrieval");
    assert.ok(retrieval.content.includes("Retrieval is the act of selectively fetching"));
  });
});

describe("toAtomicMemoryIngestInputs — deterministic identity", () => {
  it("emits stable external IDs that match the documented shape", async () => {
    const data = await loadLLMWikiExport(FIXTURE);
    const inputs = toAtomicMemoryIngestInputs(data, { scope: SCOPE }) as VerbatimIngest[];
    for (const input of inputs) {
      const externalId = (input.metadata as { externalId: string }).externalId;
      assert.match(externalId, /^llmwiki\/demo-kb\/(concepts|queries)\/[a-z0-9-]+$/);
      assert.equal(input.provenance?.sourceId, externalId);
    }
  });

  it("produces byte-identical IDs across two adapter invocations", async () => {
    const data = await loadLLMWikiExport(FIXTURE);
    const a = toAtomicMemoryIngestInputs(data, { scope: SCOPE }) as VerbatimIngest[];
    const b = toAtomicMemoryIngestInputs(data, { scope: SCOPE }) as VerbatimIngest[];
    const ids = (xs: VerbatimIngest[]) =>
      xs.map((x) => (x.metadata as { externalId: string }).externalId).sort();
    assert.deepEqual(ids(a), ids(b));
  });
});

describe("toAtomicMemoryIngestInputs — projectId enforcement", () => {
  it("uses options.projectIdOverride to override the envelope", async () => {
    const data = await loadLLMWikiExport(FIXTURE);
    const inputs = toAtomicMemoryIngestInputs(data, {
      scope: SCOPE,
      projectIdOverride: "different",
    }) as VerbatimIngest[];
    for (const input of inputs) {
      const id = (input.metadata as { externalId: string }).externalId;
      assert.ok(id.startsWith("llmwiki/different/"), `unexpected ID ${id}`);
    }
  });

  it("throws E_LLMWIKI_PROJECT_ID_REQUIRED when envelope and override are both absent", async () => {
    const data = await loadLLMWikiExport(FIXTURE);
    const detached = { ...data };
    delete (detached as { projectId?: string }).projectId;
    assert.throws(
      () => toAtomicMemoryIngestInputs(detached, { scope: SCOPE }),
      (err: unknown) =>
        err instanceof LLMWikiBridgeError && err.code === E_LLMWIKI_PROJECT_ID_REQUIRED,
    );
  });

  it("throws E_LLMWIKI_PROJECT_ID_INVALID when override fails the regex", async () => {
    const data = await loadLLMWikiExport(FIXTURE);
    assert.throws(
      () => toAtomicMemoryIngestInputs(data, { scope: SCOPE, projectIdOverride: "../bad" }),
      (err: unknown) =>
        err instanceof LLMWikiBridgeError && err.code === E_LLMWIKI_PROJECT_ID_INVALID,
    );
  });
});
