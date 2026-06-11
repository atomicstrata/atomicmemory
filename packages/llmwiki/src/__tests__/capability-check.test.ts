/**
 * Capability check + re-import mapping (final 1.5 of 5 doc-required
 * cases — the re-import mapping test stays here because it pairs with
 * a stub MemoryProvider in this file).
 *
 * Re-import mapping verifies that two passes against the same
 * provider for the same export reuse the same external ID and the
 * adapter does not silently fork the namespace on re-runs.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  Capabilities,
  IngestInput,
  IngestResult,
  ListRequest,
  ListResultPage,
  Memory,
  MemoryProvider,
  MemoryRef,
  SearchRequest,
  SearchResultPage,
  VerbatimIngest,
  Scope,
} from "@atomicmemory/sdk";
import { loadLLMWikiExport } from "../load-export.ts";
import { toAtomicMemoryIngestInputs } from "../to-ingest-inputs.ts";
import { assertSupportsVerbatim } from "../capability-check.ts";
import { E_LLMWIKI_VERBATIM_UNSUPPORTED, LLMWikiBridgeError } from "../errors.ts";

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "..", "test-fixtures",
  "demo-kb-export.json",
);

const SCOPE: Scope = { user: "test", namespace: "bridge" };

function makeCaps(modes: Array<IngestInput["mode"]>): Capabilities {
  return {
    ingestModes: modes,
    requiredScope: { default: ["user"] },
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
      health: false,
    },
  };
}

function noop(): never {
  throw new Error("not implemented");
}

class TextOnlyProvider implements MemoryProvider {
  readonly name = "text-only";
  capabilities(): Capabilities {
    return makeCaps(["text"]);
  }
  ingest(_input: IngestInput): Promise<IngestResult> {
    return noop();
  }
  search(_req: SearchRequest): Promise<SearchResultPage> {
    return noop();
  }
  get(_ref: MemoryRef): Promise<Memory | null> {
    return noop();
  }
  delete(_ref: MemoryRef): Promise<void> {
    return noop();
  }
  list(_req: ListRequest): Promise<ListResultPage> {
    return noop();
  }
}

class CountingVerbatimProvider implements MemoryProvider {
  readonly name = "verbatim-counter";
  byExternalId = new Map<string, string>();
  ingestCount = 0;

  capabilities(): Capabilities {
    return makeCaps(["verbatim"]);
  }
  async ingest(input: IngestInput): Promise<IngestResult> {
    this.ingestCount++;
    if (input.mode !== "verbatim") throw new Error(`unexpected mode ${input.mode}`);
    const externalId = (input.metadata as { externalId: string }).externalId;
    const existing = this.byExternalId.get(externalId);
    if (existing) return { created: [], updated: [], unchanged: [existing] };
    const id = `mem-${this.byExternalId.size + 1}`;
    this.byExternalId.set(externalId, id);
    return { created: [id], updated: [], unchanged: [] };
  }
  search(_req: SearchRequest): Promise<SearchResultPage> {
    return noop();
  }
  get(_ref: MemoryRef): Promise<Memory | null> {
    return noop();
  }
  delete(_ref: MemoryRef): Promise<void> {
    return noop();
  }
  list(_req: ListRequest): Promise<ListResultPage> {
    return noop();
  }
}

describe("assertSupportsVerbatim — capability gate", () => {
  it("throws E_LLMWIKI_VERBATIM_UNSUPPORTED on text-only providers", () => {
    assert.throws(
      () => assertSupportsVerbatim(new TextOnlyProvider()),
      (err: unknown) =>
        err instanceof LLMWikiBridgeError && err.code === E_LLMWIKI_VERBATIM_UNSUPPORTED,
    );
  });

  it("passes silently when the provider advertises verbatim mode", () => {
    assertSupportsVerbatim(new CountingVerbatimProvider());
  });
});

describe("re-import mapping", () => {
  it("two runs of the same export against the same provider produce no duplicates", async () => {
    const data = await loadLLMWikiExport(FIXTURE);
    const inputs = toAtomicMemoryIngestInputs(data, { scope: SCOPE }) as VerbatimIngest[];
    const provider = new CountingVerbatimProvider();
    for (const i of inputs) await provider.ingest(i);
    const ingestedFirst = provider.byExternalId.size;
    for (const i of inputs) await provider.ingest(i);
    assert.equal(provider.byExternalId.size, ingestedFirst);
    assert.equal(provider.ingestCount, inputs.length * 2);
  });
});
