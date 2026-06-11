/**
 * Fixture coverage for the release-policy CI checker.
 *
 * Each policy rule is exercised against a small inline fixture so the
 * regex/JSON checks are validated independently of the repository's
 * actual workflow and manifest state.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkCodeownersText,
  checkPackageManifest,
  checkWorkflowText,
} from "../release-policy.mjs";

const GUARD_PATH = "scripts/guards/guard-npm-publish.mjs";

test("workflow with workflow_dispatch is rejected", () => {
  const failures = checkWorkflowText("on:\n  workflow_dispatch:\n  repository_dispatch:\n    types: [foo]\n", "publish-packages.yml");
  assert.ok(failures.some((failure) => /workflow_dispatch/.test(failure)));
});

test("workflow that runs npm publish is rejected if it references NPM_TOKEN", () => {
  const yaml = "on:\n  repository_dispatch:\n    types: [foo]\npermissions:\n  id-token: write\njobs:\n  publish:\n    steps:\n      - run: npm publish\n      - env:\n          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}\n";
  const failures = checkWorkflowText(yaml, "publish-packages.yml");
  assert.ok(failures.some((failure) => /NPM_TOKEN/.test(failure)));
});

test("workflow that runs npm publish is rejected without id-token: write", () => {
  const yaml = "on:\n  repository_dispatch:\n    types: [foo]\npermissions:\n  contents: read\njobs:\n  publish:\n    steps:\n      - run: npm publish\n";
  const failures = checkWorkflowText(yaml, "publish-packages.yml");
  assert.ok(failures.some((failure) => /id-token: write/.test(failure)));
});

test("workflow that does not run npm publish is not held to npm OIDC requirements", () => {
  const yaml = "on:\n  repository_dispatch:\n    types: [core-npm-published]\npermissions:\n  contents: read\n  packages: write\n";
  assert.deepEqual(checkWorkflowText(yaml, "publish-core-docker.yml"), []);
});

test("workflow that runs npm publish with id-token: write and no NPM_TOKEN is accepted", () => {
  const yaml = "on:\n  repository_dispatch:\n    types: [foo]\npermissions:\n  id-token: write\njobs:\n  publish:\n    steps:\n      - run: npm publish --access public\n";
  assert.deepEqual(checkWorkflowText(yaml, "publish-packages.yml"), []);
});

test("published package missing the guard fails", () => {
  const failures = checkPackageManifest(validManifest({ scripts: { prepublishOnly: "echo nope" } }), "packages/sdk/package.json");
  assert.ok(failures.some((failure) => /guard-npm-publish\.mjs/.test(failure)));
});

test("published package without publishConfig.access=public fails", () => {
  const failures = checkPackageManifest(validManifest({ publishConfig: undefined }), "packages/sdk/package.json");
  assert.ok(failures.some((failure) => /publishConfig\.access/.test(failure)));
});

test("published package depending on a file: range fails", () => {
  const failures = checkPackageManifest(validManifest({ dependencies: { "@atomicmemory/sdk": "file:../sdk" } }), "packages/cli/package.json");
  assert.ok(failures.some((failure) => /file:/.test(failure)));
});

test("clean published package manifest passes", () => {
  assert.deepEqual(checkPackageManifest(validManifest(), "packages/sdk/package.json"), []);
});

test("CODEOWNERS with a /.github/ rule covers a workflow under that path", () => {
  const text = "* @maintainers\n/.github/ @maintainers\n";
  assert.deepEqual(checkCodeownersText(text, ".github/workflows/publish-packages.yml"), []);
});

test("CODEOWNERS with only an unrelated rule does not cover the workflow", () => {
  const text = "/docs/ @maintainers\n";
  const failures = checkCodeownersText(text, ".github/workflows/publish-packages.yml");
  assert.ok(failures.some((failure) => /no rule covers/.test(failure)));
});

function validManifest(overrides = {}) {
  return {
    name: "@atomicmemory/sdk",
    version: "1.0.3",
    scripts: { prepublishOnly: `node ../../${GUARD_PATH}` },
    publishConfig: { access: "public", registry: "https://registry.npmjs.org/" },
    dependencies: {},
    ...overrides,
  };
}
