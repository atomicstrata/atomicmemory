/**
 * Tests for sourceToMemory — maps a SourceRecord to an AtomicMemory Memory
 * with llmwiki trust markers stamped on metadata.llmwiki.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sourceToMemory } from "../live/live-metadata.ts";
import { LLMWIKI_TRUST_LEVEL } from "../index.ts";

const rec = {
  id: "n-1a2b3c4d.md",
  title: "N",
  source: "manual:abc",
  sourceType: "file",
  ingestedAt: "2026-01-01T00:00:00.000Z",
  body: "the body",
};

describe("sourceToMemory", () => {
  it("maps a SourceRecord to a Memory with llmwiki trust markers", () => {
    const m = sourceToMemory(rec as any, "proj-1", { user: "u1" });
    assert.equal(m.id, "llmwiki-source/proj-1/n-1a2b3c4d.md");
    assert.equal(m.content, "the body");
    assert.deepEqual(m.createdAt, new Date("2026-01-01T00:00:00.000Z"));
    assert.equal(m.kind, "document");
    assert.deepEqual(m.provenance, { source: "llmwiki", sourceId: m.id, extractor: "llmwiki-source" });
    const md = (m.metadata as any).llmwiki;
    assert.equal(md.trustLevel, LLMWIKI_TRUST_LEVEL); // "external-import"
    assert.equal(md.projectId, "proj-1");
    assert.equal(md.source, "manual:abc");
    assert.equal(md.sourceType, "file");
    assert.equal(md.sourceId, "n-1a2b3c4d.md");
    assert.ok(typeof md.version === "number");
  });
  it("content is '' when body is undefined", () => {
    const m = sourceToMemory({ ...rec, body: undefined } as any, "proj-1", { user: "u1" });
    assert.equal(m.content, "");
  });
  it("createdAt falls back to new Date(0) when ingestedAt is undefined", () => {
    const m2 = sourceToMemory({ ...rec, ingestedAt: undefined } as any, "proj-1", { user: "u1" });
    assert.deepEqual(m2.createdAt, new Date(0)); // non-volatile fallback, never Date.now()
  });
  it("malformed ingestedAt produces a valid Date (not Invalid Date) and serializes to non-null", () => {
    const m = sourceToMemory({ ...rec, ingestedAt: "not-a-date" } as any, "proj-1", { user: "u1" });
    assert.ok(!Number.isNaN(m.createdAt.getTime()), "createdAt must be a valid Date");
    const serialized = JSON.parse(JSON.stringify(m)).createdAt;
    assert.notEqual(serialized, null, "createdAt must not serialize to null");
  });
});
