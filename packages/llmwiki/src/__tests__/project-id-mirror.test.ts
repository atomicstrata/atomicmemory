/**
 * @file Asserts the importer-side `PROJECT_ID_PATTERN` matches the
 * exporter-side regex in the llmwiki repo byte-for-byte. The mirror
 * is documented as a contract on both sides — this test enforces it
 * automatically so the regex can't silently drift if someone updates
 * one repo without the other.
 *
 * Network-gated: skipped when the environment cannot reach
 * `raw.githubusercontent.com`. CI must run without skipping to keep
 * the contract live; we mark a clear failure mode when the network
 * is the obstacle vs when the regex actually differs.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PROJECT_ID_PATTERN } from "../project-id.ts";

const EXPORTER_RAW_URL =
  "https://raw.githubusercontent.com/atomicstrata/llm-wiki-compiler/main/src/export/project-id.ts";

test("projectId regex mirrors the exporter side byte-for-byte (V1)", async () => {
  let exporterSource: string;
  try {
    const response = await fetch(EXPORTER_RAW_URL);
    if (!response.ok) {
      // Don't silently pass; surface a clear diagnostic so the
      // contract isn't quietly skipped because GitHub had a hiccup.
      assert.fail(
        `Could not fetch ${EXPORTER_RAW_URL}: HTTP ${response.status}. ` +
          "The projectId mirror contract requires network access to verify. " +
          "Run the test in an environment with internet access.",
      );
    }
    exporterSource = await response.text();
  } catch (err) {
    assert.fail(
      `Network error fetching exporter project-id.ts: ${err instanceof Error ? err.message : String(err)}. ` +
        "The projectId mirror contract requires network access to verify.",
    );
  }
  const match = /PROJECT_ID_PATTERN\s*=\s*(\/[^/]+\/[a-z]*)/.exec(exporterSource);
  assert.ok(match, "Could not extract PROJECT_ID_PATTERN from exporter source");
  const exporterRegex = match[1];
  const importerRegex = PROJECT_ID_PATTERN.toString();
  assert.equal(
    importerRegex,
    exporterRegex,
    "PROJECT_ID_PATTERN drift: importer side disagrees with exporter side. " +
      "When you change either, update both, and re-run this test.",
  );
});
