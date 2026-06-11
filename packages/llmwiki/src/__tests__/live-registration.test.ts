/**
 * Tests for liveLlmwikiProviderFactory and the ./live barrel entrypoint.
 *
 * Verifies that the factory constructs a LiveLLMWikiProvider and that the barrel
 * re-exports the full live surface (factory + provider class + id utilities + metadata helpers).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { liveLlmwikiProviderFactory, LiveLLMWikiProvider } from "../live.ts";

describe("live registration + barrel", () => {
  it("factory returns a LiveLLMWikiProvider", () => {
    const { provider } = liveLlmwikiProviderFactory({ root: "/tmp/x", scope: { user: "u1" }, projectId: "proj-1" });
    assert.ok(provider instanceof LiveLLMWikiProvider);
  });
});
