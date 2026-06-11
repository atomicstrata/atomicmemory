/**
 * loadLLMWikiExport: parse + validate path.
 *
 * Two of the five doc-required cases live here: fixture parse and
 * malformed export. Metadata preservation, deterministic identity,
 * and re-import mapping are exercised in `to-ingest-inputs.test.ts`
 * because they read the parsed result rather than the loader itself.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { loadLLMWikiExport } from "../load-export.ts";
import {
  E_LLMWIKI_EXPORT_INVALID_SHAPE,
  E_LLMWIKI_EXPORT_NOT_FOUND,
  E_LLMWIKI_EXPORT_OVER_LIMIT,
  LLMWikiBridgeError,
} from "../errors.ts";
import { MAX_TOTAL_SIZE_BYTES } from "../limits.ts";

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "..", "test-fixtures",
  "demo-kb-export.json",
);

async function makeTempFile(name: string, content: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "llmwiki-bridge-test-"));
  const filePath = path.join(dir, name);
  await writeFile(filePath, content);
  return filePath;
}

describe("loadLLMWikiExport — fixture parse", () => {
  it("parses the demo-kb fixture into a typed envelope", async () => {
    const data = await loadLLMWikiExport(FIXTURE);
    assert.equal(data.projectId, "demo-kb");
    assert.equal(data.pageCount, 3);
    assert.equal(data.pages.length, 3);
    const titles = data.pages.map((p) => p.title).sort();
    assert.deepEqual(titles, ["Chunking", "Retrieval", "What is retrieval?"]);
  });
});

describe("loadLLMWikiExport — malformed export rejection", () => {
  it("throws E_LLMWIKI_EXPORT_NOT_FOUND when the file is missing", async () => {
    await assert.rejects(
      () => loadLLMWikiExport("/no/such/file.json"),
      (err: unknown) =>
        err instanceof LLMWikiBridgeError && err.code === E_LLMWIKI_EXPORT_NOT_FOUND,
    );
  });

  it("throws E_LLMWIKI_EXPORT_INVALID_SHAPE for non-JSON content", async () => {
    const filePath = await makeTempFile("bad.json", "not json {");
    try {
      await assert.rejects(
        () => loadLLMWikiExport(filePath),
        (err: unknown) =>
          err instanceof LLMWikiBridgeError && err.code === E_LLMWIKI_EXPORT_INVALID_SHAPE,
      );
    } finally {
      await rm(path.dirname(filePath), { recursive: true });
    }
  });

  it("throws E_LLMWIKI_EXPORT_INVALID_SHAPE when required fields are missing", async () => {
    const filePath = await makeTempFile(
      "missing.json",
      JSON.stringify({ exportedAt: "x", pageCount: 0 }),
    );
    try {
      await assert.rejects(
        () => loadLLMWikiExport(filePath),
        (err: unknown) =>
          err instanceof LLMWikiBridgeError && err.code === E_LLMWIKI_EXPORT_INVALID_SHAPE,
      );
    } finally {
      await rm(path.dirname(filePath), { recursive: true });
    }
  });

  it("throws E_LLMWIKI_EXPORT_INVALID_SHAPE when pageCount disagrees with pages.length", async () => {
    const filePath = await makeTempFile(
      "mismatch.json",
      JSON.stringify({ exportedAt: "x", pageCount: 10, projectId: "kb", pages: [] }),
    );
    try {
      await assert.rejects(
        () => loadLLMWikiExport(filePath),
        (err: unknown) =>
          err instanceof LLMWikiBridgeError && err.code === E_LLMWIKI_EXPORT_INVALID_SHAPE,
      );
    } finally {
      await rm(path.dirname(filePath), { recursive: true });
    }
  });

  it("throws E_LLMWIKI_EXPORT_INVALID_SHAPE when a page slug fails the regex (B1)", async () => {
    const filePath = await makeTempFile(
      "badslug.json",
      JSON.stringify({
        exportedAt: "x",
        pageCount: 1,
        projectId: "kb",
        pages: [
          {
            title: "T",
            slug: "../queries/escape",
            pageDirectory: "concepts",
            path: "wiki/concepts/x.md",
            summary: "",
            sources: [],
            tags: [],
            createdAt: "x",
            updatedAt: "x",
            links: [],
            body: "x",
            citations: [],
            advisoryFreshnessStatus: "unverified",
          },
        ],
      }),
    );
    try {
      await assert.rejects(
        () => loadLLMWikiExport(filePath),
        (err: unknown) =>
          err instanceof LLMWikiBridgeError && err.code === E_LLMWIKI_EXPORT_INVALID_SHAPE,
      );
    } finally {
      await rm(path.dirname(filePath), { recursive: true });
    }
  });

  it("rejects an oversized passthrough field via the per-string size walker (B2)", async () => {
    const oversized = "x".repeat(1_048_577); // 1 byte over MAX_BODY_LENGTH
    const filePath = await makeTempFile(
      "oversized.json",
      JSON.stringify({
        exportedAt: "x",
        pageCount: 0,
        projectId: "kb",
        pages: [],
        evilPassthrough: oversized,
      }),
    );
    try {
      await assert.rejects(
        () => loadLLMWikiExport(filePath),
        (err: unknown) =>
          err instanceof LLMWikiBridgeError && /OVER_LIMIT/.test(err.code),
      );
    } finally {
      await rm(path.dirname(filePath), { recursive: true });
    }
  });

  it("ACCEPTS an envelope projectId that fails the regex so --project-id override can fix it", async () => {
    // Schema-time regex was relaxed (H5) — strict projectId
    // validation runs in `validateProjectId` after override
    // resolution, so a CLI caller can still pass an old/buggy export
    // through by overriding the bad projectId.
    const filePath = await makeTempFile(
      "badproj.json",
      JSON.stringify({
        exportedAt: "x",
        pageCount: 0,
        projectId: "../escape",
        pages: [],
      }),
    );
    try {
      const data = await loadLLMWikiExport(filePath);
      assert.equal(data.projectId, "../escape");
    } finally {
      await rm(path.dirname(filePath), { recursive: true });
    }
  });
});

describe("loadLLMWikiExport — over-limit rejection", () => {
  it("documents the size cap as the published limit", () => {
    assert.equal(MAX_TOTAL_SIZE_BYTES, 256 * 1024 * 1024);
  });

  it("rejects malformed exports with deep nesting via E_LLMWIKI_EXPORT_OVER_LIMIT", async () => {
    let nested: unknown = "leaf";
    for (let i = 0; i < 25; i++) nested = [nested];
    const filePath = await makeTempFile(
      "deep.json",
      JSON.stringify({ exportedAt: "x", pageCount: 0, pages: [], deep: nested }),
    );
    try {
      await assert.rejects(
        () => loadLLMWikiExport(filePath),
        (err: unknown) =>
          err instanceof LLMWikiBridgeError && err.code === E_LLMWIKI_EXPORT_OVER_LIMIT,
      );
    } finally {
      await rm(path.dirname(filePath), { recursive: true });
    }
  });
});
