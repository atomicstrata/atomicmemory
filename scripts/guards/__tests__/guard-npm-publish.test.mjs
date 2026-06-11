/**
 * Unit coverage for the npm publish guard.
 *
 * The guard accepts an injectable env so the GitHub Actions context can be
 * simulated without setting real environment variables.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { enforce } from "../guard-npm-publish.mjs";

const PACKAGE_JSON = { name: "@atomicmemory/sdk", version: "1.0.3" };

test("guard accepts a publish that matches the manifest", (t) => {
  const manifestPath = writeManifest(t, [{ name: PACKAGE_JSON.name, version: PACKAGE_JSON.version }]);
  assert.doesNotThrow(() => enforce({ packageJson: PACKAGE_JSON, env: validEnv(manifestPath) }));
});

test("guard refuses publish outside GitHub Actions", (t) => {
  const manifestPath = writeManifest(t, [{ name: PACKAGE_JSON.name, version: PACKAGE_JSON.version }]);
  const env = { ...validEnv(manifestPath), GITHUB_ACTIONS: undefined };
  assert.throws(() => enforce({ packageJson: PACKAGE_JSON, env }), /GITHUB_ACTIONS=true/);
});

test("guard refuses publish from the wrong repository", (t) => {
  const manifestPath = writeManifest(t, [{ name: PACKAGE_JSON.name, version: PACKAGE_JSON.version }]);
  const env = { ...validEnv(manifestPath), GITHUB_REPOSITORY: "evil/atomicmemory" };
  assert.throws(() => enforce({ packageJson: PACKAGE_JSON, env }), /must run in atomicstrata\/atomicmemory/);
});

test("guard refuses publish without the workflow marker", (t) => {
  const manifestPath = writeManifest(t, [{ name: PACKAGE_JSON.name, version: PACKAGE_JSON.version }]);
  const env = { ...validEnv(manifestPath), ATOMICMEMORY_RELEASE_WORKFLOW: "some-other-workflow" };
  assert.throws(() => enforce({ packageJson: PACKAGE_JSON, env }), /ATOMICMEMORY_RELEASE_WORKFLOW=publish-packages/);
});

test("guard refuses publish without a manifest env var", () => {
  const env = { ...validEnv("/unused"), ATOMICMEMORY_RELEASE_MANIFEST: undefined };
  assert.throws(() => enforce({ packageJson: PACKAGE_JSON, env }), /ATOMICMEMORY_RELEASE_MANIFEST/);
});

test("guard refuses when the manifest file is unreadable", () => {
  const env = validEnv("/no/such/manifest.json");
  assert.throws(() => enforce({ packageJson: PACKAGE_JSON, env }), /could not read manifest/);
});

test("guard refuses when the manifest schema_version is unsupported", (t) => {
  const path = writeManifest(t, [{ name: PACKAGE_JSON.name, version: PACKAGE_JSON.version }], { schema_version: 2 });
  assert.throws(() => enforce({ packageJson: PACKAGE_JSON, env: validEnv(path) }), /schema_version 2/);
});

test("guard refuses when the package is not in selected_targets", (t) => {
  const manifestPath = writeManifest(t, [{ name: "@atomicmemory/other", version: "1.0.0" }]);
  assert.throws(() => enforce({ packageJson: PACKAGE_JSON, env: validEnv(manifestPath) }), /not in the manifest/);
});

test("guard refuses when the manifest version differs from package.json", (t) => {
  const manifestPath = writeManifest(t, [{ name: PACKAGE_JSON.name, version: "0.0.1" }]);
  assert.throws(() => enforce({ packageJson: PACKAGE_JSON, env: validEnv(manifestPath) }), /does not match package\.json/);
});

function validEnv(manifestPath) {
  return {
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: "atomicstrata/atomicmemory",
    ATOMICMEMORY_RELEASE_WORKFLOW: "publish-packages",
    ATOMICMEMORY_RELEASE_MANIFEST: manifestPath,
  };
}

function writeManifest(t, targets, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "guard-npm-publish-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "manifest.json");
  writeFileSync(path, JSON.stringify({
    schema_version: 1,
    public_repo: "atomicstrata/atomicmemory",
    public_sha: "0".repeat(40),
    selected_targets: targets.map((target) => ({ id: target.name.split("/")[1], registry: "npm", name: target.name, version: target.version, path: `packages/${target.name.split("/")[1]}` })),
    ...overrides,
  }));
  return path;
}
