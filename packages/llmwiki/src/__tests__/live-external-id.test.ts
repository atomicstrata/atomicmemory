import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildLiveExternalId, parseLiveExternalId } from "../live/live-external-id.ts";
import { LLMWikiBridgeError } from "../index.ts";

describe("live external id", () => {
  it("round-trips projectId + filename (incl. .md and hash suffix)", () => {
    const id = buildLiveExternalId("proj-1", "my-note-1a2b3c4d.md");
    assert.equal(id, "llmwiki-source/proj-1/my-note-1a2b3c4d.md");
    assert.deepEqual(parseLiveExternalId(id, "proj-1"), { filename: "my-note-1a2b3c4d.md" });
  });
  it("encodes filename chars that need it", () => {
    const id = buildLiveExternalId("proj-1", "a b.md");
    assert.equal(id, "llmwiki-source/proj-1/a%20b.md");
    assert.deepEqual(parseLiveExternalId(id, "proj-1"), { filename: "a b.md" });
  });
  it("rejects wrong prefix / wrong project / traversal / non-.md / non-basename", () => {
    for (const bad of [
      "llmwiki/proj-1/x.md",                  // page scheme, wrong prefix
      "llmwiki-source/other/x.md",            // wrong projectId
      "llmwiki-source/proj-1/..%2Fescape.md", // traversal after decode
      "llmwiki-source/proj-1/sub%2Fx.md",     // separator after decode
      "llmwiki-source/proj-1/x.txt",          // not .md
    ]) {
      assert.throws(() => parseLiveExternalId(bad, "proj-1"), LLMWikiBridgeError);
    }
  });
});
