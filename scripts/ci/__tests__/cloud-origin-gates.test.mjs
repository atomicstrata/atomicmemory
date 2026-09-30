/**
 * Contract tests for the Cloud origin credential gate validator.
 *
 * The validator must compare each implementation's actual host set literal
 * with the CLI's canonical FIRST_PARTY_API_HOSTS, so these tests mutate one
 * source in memory and assert that:
 *   1. The current tree passes.
 *   2. A host dropped from a set fails even while it still appears in a
 *      comment or another constant elsewhere in the file.
 *   3. An extra host in one implementation fails.
 *   4. A set literal that cannot be found fails loudly instead of passing.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  GATES,
  extractBashHostSet,
  extractPythonHostSet,
  extractRustHostSet,
  extractTsHostSet,
  validateCloudOriginGates,
} from "../cloud-origin-gates.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const CANONICAL_HOSTS = ["api.atomicstrata.ai", "api.dev.atomicstrata.ai", "api.staging.atomicstrata.ai"];

function readRepo(path) {
  return readFileSync(resolve(ROOT, path), "utf8");
}

/** Reader that serves the real tree except for the given overrides. */
function readerWith(overrides) {
  return (path) => (path in overrides ? overrides[path] : readRepo(path));
}

function mutate(path, from, to) {
  const source = readRepo(path);
  assert.ok(source.includes(from), `${path} no longer contains the mutation anchor ${JSON.stringify(from)}`);
  return readerWith({ [path]: source.replace(from, to) });
}

test("current tree passes", () => {
  assert.deepEqual(validateCloudOriginGates(readRepo), []);
});

test("every gate's extracted set equals the canonical set", () => {
  assert.deepEqual(extractRustHostSet(readRepo("crates/cli/src/environment.rs")).sort(), CANONICAL_HOSTS);
  for (const [path, { extract }] of GATES) {
    assert.deepEqual(extract(readRepo(path), path).sort(), CANONICAL_HOSTS, path);
  }
});

test("TS host removed from the set but kept in a comment fails", () => {
  const path = "plugins/openclaw/src/index.ts";
  const read = mutate(
    path,
    "  'api.staging.atomicstrata.ai',\n]);",
    "  // 'api.staging.atomicstrata.ai',\n]);",
  );
  const failures = validateCloudOriginGates(read);
  assert.ok(failures.some((f) => f === `${path} omits api.staging.atomicstrata.ai`), failures.join("\n"));
});

test("TS host present only in a DEFAULT_*_URL constant fails", () => {
  const path = "packages/mcp-server/src/config.ts";
  const read = mutate(path, "  'api.atomicstrata.ai',\n", "");
  const failures = validateCloudOriginGates(read);
  assert.ok(failures.some((f) => f === `${path} omits api.atomicstrata.ai`), failures.join("\n"));
});

test("Python host removed from the set but kept in a comment fails", () => {
  const path = "plugins/hermes/python_sdk.py";
  const read = mutate(
    path,
    '{"api.atomicstrata.ai", "api.dev.atomicstrata.ai", "api.staging.atomicstrata.ai"}',
    '{"api.atomicstrata.ai", "api.staging.atomicstrata.ai"}  # was "api.dev.atomicstrata.ai"',
  );
  const failures = validateCloudOriginGates(read);
  assert.ok(failures.some((f) => f === `${path} omits api.dev.atomicstrata.ai`), failures.join("\n"));
});

test("bash host removed from the case arm but kept in a comment fails", () => {
  const path = "plugins/claude-code/scripts/lib/atomicmemory.sh";
  const read = mutate(
    path,
    "    api.atomicstrata.ai|api.dev.atomicstrata.ai|api.staging.atomicstrata.ai) return 0 ;;",
    "    # api.dev.atomicstrata.ai|\n    api.atomicstrata.ai|api.staging.atomicstrata.ai) return 0 ;;",
  );
  const failures = validateCloudOriginGates(read);
  assert.ok(failures.some((f) => f === `${path} omits api.dev.atomicstrata.ai`), failures.join("\n"));
});

test("extra host in one implementation fails", () => {
  const path = "plugins/openclaw/src/index.ts";
  const read = mutate(
    path,
    "  'api.staging.atomicstrata.ai',\n]);",
    "  'api.staging.atomicstrata.ai',\n  'api.preview.atomicstrata.ai',\n]);",
  );
  const failures = validateCloudOriginGates(read);
  assert.ok(failures.some((f) => f === `${path} has extra host api.preview.atomicstrata.ai`), failures.join("\n"));
});

test("extra host in the bash case arm fails", () => {
  const path = "plugins/claude-code/scripts/lib/atomicmemory.sh";
  const read = mutate(
    path,
    "api.staging.atomicstrata.ai) return 0 ;;",
    "api.staging.atomicstrata.ai|api.preview.atomicstrata.ai) return 0 ;;",
  );
  const failures = validateCloudOriginGates(read);
  assert.ok(failures.some((f) => f === `${path} has extra host api.preview.atomicstrata.ai`), failures.join("\n"));
});

test("canonical host missing from every implementation is reported against each", () => {
  const read = mutate(
    "crates/cli/src/environment.rs",
    '    "api.staging.atomicstrata.ai",\n];',
    '    "api.staging.atomicstrata.ai",\n    "api.preview.atomicstrata.ai",\n];',
  );
  const failures = validateCloudOriginGates(read);
  for (const path of GATES.keys()) {
    assert.ok(failures.includes(`${path} omits api.preview.atomicstrata.ai`), failures.join("\n"));
  }
});

test("missing set literal fails loudly", () => {
  const cases = [
    ["plugins/openclaw/src/index.ts", "const CLOUD_API_HOSTNAMES = new Set([", "const CLOUD_HOSTS = new Set(["],
    ["plugins/hermes/python_sdk.py", "CLOUD_API_HOSTNAMES = frozenset(", "CLOUD_HOSTS = frozenset("],
    ["plugins/claude-code/scripts/lib/atomicmemory.sh", "am_is_cloud_api_host() {", "am_cloud_host() {"],
  ];
  for (const [path, from, to] of cases) {
    const failures = validateCloudOriginGates(mutate(path, from, to));
    assert.ok(
      failures.some((f) => f.startsWith(`${path}: could not find`)),
      `${path}: ${failures.join("\n")}`,
    );
  }
});

test("missing canonical literal fails loudly", () => {
  const read = mutate("crates/cli/src/environment.rs", "FIRST_PARTY_API_HOSTS:", "FIRST_PARTY_HOSTS:");
  const failures = validateCloudOriginGates(read);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /could not find the FIRST_PARTY_API_HOSTS array literal/);
});

test("set literal hidden inside a comment does not count", () => {
  const source = "// const CLOUD_API_HOSTNAMES = new Set(['api.atomicstrata.ai']);\nconst X = 1;\n";
  assert.throws(() => extractTsHostSet(source, "fixture.ts"), /could not find/);
  assert.throws(
    () => extractPythonHostSet('# CLOUD_API_HOSTNAMES = frozenset({"api.atomicstrata.ai"})\n', "fixture.py"),
    /could not find/,
  );
  assert.throws(
    () => extractBashHostSet("# am_is_cloud_api_host() {\n#  api.atomicstrata.ai) return 0 ;;\n# }\n", "fixture.sh"),
    /could not find/,
  );
});
