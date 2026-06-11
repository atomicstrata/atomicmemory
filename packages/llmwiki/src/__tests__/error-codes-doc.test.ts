/**
 * @file Asserts that every `E_LLMWIKI_*` constant exported from
 * `errors.ts` is documented in the package README's "Error codes"
 * list. Catches the silent drift mode where a new code lands and the
 * README's switch-statement guidance becomes a lie of omission.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as errors from "../errors.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const README_PATH = join(HERE, "..", "..", "README.md");

test("every exported E_LLMWIKI_* code appears in README.md", () => {
  const readme = readFileSync(README_PATH, "utf-8");
  const codes = Object.entries(errors)
    .filter(([name, value]) => name.startsWith("E_LLMWIKI_") && typeof value === "string")
    .map(([, value]) => value as string);
  assert.ok(codes.length > 0, "no E_LLMWIKI_* codes exported — sanity check failed");
  const missing = codes.filter((code) => !readme.includes(code));
  assert.deepEqual(
    missing,
    [],
    `README missing error codes: ${missing.join(", ")}\n` +
      "Add them under the 'Error codes' section of packages/llmwiki/README.md.",
  );
});
