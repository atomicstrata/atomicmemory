/**
 * @file Tests for deterministic doIngest helpers: flattenMessages and deriveTitle.
 *
 * Covers role-preserving message flattening and title derivation precedence
 * (explicit metadata.title → first non-empty line → fallback), including the 120-char bound.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { flattenMessages, deriveTitle } from "../live/flatten.ts";

describe("doIngest helpers", () => {
  it("flattenMessages is role-preserving and deterministic", () => {
    const text = flattenMessages([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ] as any);
    assert.equal(text, "[user]\nhello\n\n[assistant]\nhi there");
  });
  it("deriveTitle prefers explicit metadata.title, else first non-empty line, bounded", () => {
    assert.equal(deriveTitle("anything", { title: "Explicit" }), "Explicit");
    assert.equal(deriveTitle("  \n First real line \n more", undefined), "First real line");
    assert.equal(deriveTitle("", undefined), "Untitled source");
    assert.equal(deriveTitle("x".repeat(500), undefined).length <= 120, true);
  });
});
