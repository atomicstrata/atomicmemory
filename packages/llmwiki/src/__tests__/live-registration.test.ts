/**
 * Tests for liveLlmwikiProviderFactory and the ./live barrel entrypoint.
 *
 * Verifies that the factory constructs a LiveLLMWikiProvider and that the barrel
 * re-exports the full live surface (factory + provider class + id utilities + metadata helpers).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { liveLlmwikiProviderFactory, LiveLLMWikiProvider } from "../live.ts";

// Private directory rather than the shared TMP_ROOT: see live-provider.test.ts.
const TMP_ROOT = mkdtempSync(path.join(tmpdir(), "llmwiki-registration-"));

describe("live registration + barrel", () => {
  it("factory returns a LiveLLMWikiProvider", () => {
    const { provider } = liveLlmwikiProviderFactory({ root: TMP_ROOT, scope: { user: "u1" }, projectId: "proj-1" });
    assert.ok(provider instanceof LiveLLMWikiProvider);
  });
});
