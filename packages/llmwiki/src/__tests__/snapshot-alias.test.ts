/**
 * @file Validates the public export surface of `@atomicmemory/llmwiki`.
 *
 * Asserts that:
 *   - The supported Snapshot* names are exported and are functions.
 *   - The OLD deprecated names (LLMWikiProvider, LLMWikiProviderOptions,
 *     llmwikiProviderFactory) are NOT exported — they were removed as a
 *     breaking change.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as mod from "../index.ts";

describe("exports surface", () => {
  it("SnapshotLLMWikiProvider is exported and is a constructor", () => {
    assert.equal(typeof mod.SnapshotLLMWikiProvider, "function");
  });

  it("snapshotLlmwikiProviderFactory is exported and is a function", () => {
    assert.equal(typeof mod.snapshotLlmwikiProviderFactory, "function");
  });

  it("old name LLMWikiProvider is NOT exported (breaking removal)", () => {
    assert.equal((mod as Record<string, unknown>).LLMWikiProvider, undefined);
  });

  it("old name llmwikiProviderFactory is NOT exported (breaking removal)", () => {
    assert.equal((mod as Record<string, unknown>).llmwikiProviderFactory, undefined);
  });
});
