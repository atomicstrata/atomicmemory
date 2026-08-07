/**
 * Contract tests for the parseYaml-based workflow permission validator and
 * release-lane mirror promotion guard.
 *
 * The validator is the single chokepoint that decides which workflows may
 * hold write scopes. These tests assert two properties end-to-end:
 *   1. The two release lanes still pass their exact-shape check.
 *   2. Any other workflow (or a mutation of a release lane) that reaches for
 *      a write scope — through any spelling — fails the validator. That
 *      catches both accidental widening of the exemption and text-level
 *      bypasses that a line-grep would miss.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  validateMirrorCliPromotionGuard,
  validateWorkflowPermissions,
} from "../../security/security-compliance.mjs";

const WORKFLOW = ".github/workflows/release-cli.yml";
const INTERNAL_WORKFLOW = ".github/workflows/internal-cli-release.yml";
const MIRROR_WORKFLOW = ".github/workflows/mirror-cli-r2.yml";
const NON_EXEMPT_WORKFLOW = ".github/workflows/ci.yml";

function readWorkflowText() {
  return readFileSync(WORKFLOW, "utf8");
}

function readMirrorWorkflowText() {
  return readFileSync(MIRROR_WORKFLOW, "utf8");
}

function readInternalWorkflowText() {
  return readFileSync(INTERNAL_WORKFLOW, "utf8");
}

test("release-cli keeps publish-only write permissions", () => {
  const failures = validateWorkflowPermissions(WORKFLOW, readWorkflowText());
  assert.deepEqual(failures, []);
});

test("release-cli fails when build job gains contents write", () => {
  const doc = readWorkflowText();
  const mutated = doc.replace(
    "  build:\n    name: build ${{ matrix.target }}",
    "  build:\n    permissions:\n      contents: write\n    name: build ${{ matrix.target }}",
  );
  const failures = validateWorkflowPermissions(WORKFLOW, mutated);
  assert.ok(failures.some((failure) => /job build must not request write permissions/.test(failure)));
});

test("release-cli fails when build job gains actions write", () => {
  const doc = readWorkflowText();
  const mutated = doc.replace(
    "  build:\n    name: build ${{ matrix.target }}",
    "  build:\n    permissions:\n      actions: write\n    name: build ${{ matrix.target }}",
  );
  const failures = validateWorkflowPermissions(WORKFLOW, mutated);
  assert.ok(failures.some((failure) => /job build must not request write permissions/.test(failure)));
});

test("release-cli fails when build job gains write-all", () => {
  const doc = readWorkflowText();
  const mutated = doc.replace(
    "  build:\n    name: build ${{ matrix.target }}",
    "  build:\n    permissions: write-all\n    name: build ${{ matrix.target }}",
  );
  const failures = validateWorkflowPermissions(WORKFLOW, mutated);
  assert.ok(failures.some((failure) => /job build must not request write permissions/.test(failure)));
});

test("release-cli fails when build job gains packages write", () => {
  const doc = readWorkflowText();
  const mutated = doc.replace(
    "  build:\n    name: build ${{ matrix.target }}",
    "  build:\n    permissions:\n      packages: write\n    name: build ${{ matrix.target }}",
  );
  const failures = validateWorkflowPermissions(WORKFLOW, mutated);
  assert.ok(failures.some((failure) => /job build must not request write permissions/.test(failure)));
});

test("release-cli fails when workflow-level write permissions return", () => {
  const mutated = readWorkflowText().replace(
    "permissions:\n  contents: read",
    "permissions: write-all",
  );
  const failures = validateWorkflowPermissions(WORKFLOW, mutated);
  assert.ok(failures.some((failure) => /workflow permissions must be exactly contents: read/.test(failure)));
});

test("internal-cli keeps publish-only contents write", () => {
  const failures = validateWorkflowPermissions(INTERNAL_WORKFLOW, readInternalWorkflowText());
  assert.deepEqual(failures, []);
});

test("internal-cli fails when build job gains contents write", () => {
  const mutated = readInternalWorkflowText().replace(
    "  build:\n    name: build ${{ matrix.target }}",
    "  build:\n    permissions:\n      contents: write\n    name: build ${{ matrix.target }}",
  );
  const failures = validateWorkflowPermissions(INTERNAL_WORKFLOW, mutated);
  assert.ok(failures.some((failure) => /job build must not request write permissions/.test(failure)));
});

test("internal-cli fails when publish gains attestations write", () => {
  const mutated = readInternalWorkflowText().replace(
    "    permissions:\n      contents: write\n    env:",
    "    permissions:\n      contents: write\n      attestations: write\n    env:",
  );
  const failures = validateWorkflowPermissions(INTERNAL_WORKFLOW, mutated);
  assert.ok(failures.some((failure) => /job publish must request exactly contents: write/.test(failure)));
});

// Structural guard against a regression in the workflow: the
// `Reconcile immutable release` step must delegate to the reconcile
// script, and the script must swap dist/ for the immutable release's
// actual bytes. Comparing asset names alone would let the floating
// alias upload freshly rebuilt (non-reproducible) tarballs while the
// immutable release keeps its original bytes.
test("internal-cli publish reconciles bytes via the reconcile script", () => {
  const text = readInternalWorkflowText();
  assert.ok(
    /run:\s*scripts\/ci\/reconcile-internal-release\.sh/.test(text),
    "internal-cli-release.yml must invoke scripts/ci/reconcile-internal-release.sh from the Reconcile step",
  );
});

test("reconcile script downloads and swaps dist for immutable release bytes", () => {
  const scriptText = readFileSync("scripts/ci/reconcile-internal-release.sh", "utf8");
  assert.ok(
    /gh release download/.test(scriptText),
    "reconcile script must download the immutable release's assets, not rely on name equality",
  );
  assert.ok(
    /sha256sum -c SHA256SUMS|shasum -a 256 -c SHA256SUMS/.test(scriptText),
    "reconcile script must verify downloaded SHA256SUMS against the downloaded tarballs",
  );
  assert.ok(
    /rm -rf "\$DIST_DIR"\s*\n\s*mv "\$reconciled" "\$DIST_DIR"/.test(scriptText),
    "reconcile script must swap DIST_DIR for the reconciled (downloaded) assets",
  );
});

test("non-exempt workflow fails when it requests contents: write", () => {
  const yaml = [
    "name: rogue",
    "on: push",
    "permissions:",
    "  contents: write",
    "jobs:",
    "  do:",
    "    runs-on: ubuntu-24.04",
    "    steps:",
    "      - run: echo hi",
    "",
  ].join("\n");
  const failures = validateWorkflowPermissions(NON_EXEMPT_WORKFLOW, yaml);
  assert.ok(failures.some((failure) => /workflow must not request write permissions/.test(failure)));
});

test("non-exempt workflow fails when a job requests packages: write", () => {
  const yaml = [
    "name: rogue",
    "on: push",
    "permissions:",
    "  contents: read",
    "jobs:",
    "  do:",
    "    runs-on: ubuntu-24.04",
    "    permissions:",
    "      packages: write",
    "    steps:",
    "      - run: echo hi",
    "",
  ].join("\n");
  const failures = validateWorkflowPermissions(NON_EXEMPT_WORKFLOW, yaml);
  assert.ok(failures.some((failure) => /job do must not request write permissions/.test(failure)));
});

test("spelling bypasses of contents: write are rejected in a non-exempt workflow", () => {
  const bypasses = [
    "  contents:  write",
    "  contents: 'write'",
    "  contents: \"write\"",
    "  contents: write   # top-up token",
    "  contents: write\n  id-token: write",
  ];
  for (const permissionsBody of bypasses) {
    const yaml = [
      "name: rogue",
      "on: push",
      "permissions:",
      permissionsBody,
      "jobs:",
      "  do:",
      "    runs-on: ubuntu-24.04",
      "    steps:",
      "      - run: echo hi",
      "",
    ].join("\n");
    const failures = validateWorkflowPermissions(NON_EXEMPT_WORKFLOW, yaml);
    assert.ok(
      failures.some((failure) => /workflow must not request write permissions/.test(failure)),
      `expected bypass to be rejected: ${JSON.stringify(permissionsBody)}`,
    );
  }
});

test("flow-style permissions map with write is rejected in a non-exempt workflow", () => {
  const yaml = [
    "name: rogue",
    "on: push",
    "permissions: { contents: write }",
    "jobs:",
    "  do:",
    "    runs-on: ubuntu-24.04",
    "    steps:",
    "      - run: echo hi",
    "",
  ].join("\n");
  const failures = validateWorkflowPermissions(NON_EXEMPT_WORKFLOW, yaml);
  assert.ok(failures.some((failure) => /workflow must not request write permissions/.test(failure)));
});

test("mirror-cli refuses to promote an older version over current latest", () => {
  const failures = validateMirrorCliPromotionGuard(MIRROR_WORKFLOW, readMirrorWorkflowText());
  assert.deepEqual(failures, []);
});

test("mirror-cli fails when the monotonic promotion guard is removed", () => {
  const mutated = readMirrorWorkflowText().replace(
    /\n\s+head_err="\$\(mktemp\)"[\s\S]*?echo "Promoting \$\{ver\} over current \$\{current_ver:-<none>\}"/,
    "",
  );
  const failures = validateMirrorCliPromotionGuard(MIRROR_WORKFLOW, mutated);
  assert.ok(failures.some((failure) => /must compare requested version against current version\.json/.test(failure)));
});
