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
  validateReleaseCliVersionBumpGuard,
  validateWorkflowPermissions,
} from "../../security/security-compliance.mjs";

const WORKFLOW = ".github/workflows/release-cli.yml";
const INTERNAL_WORKFLOW = ".github/workflows/internal-cli-release.yml";
const MIRROR_WORKFLOW = ".github/workflows/mirror-cli-r2.yml";
const NON_EXEMPT_WORKFLOW = ".github/workflows/ci.yml";
const CLI_INSTALL_SMOKE_WORKFLOW = ".github/workflows/cli-install-smoke.yml";
const CLI_PUBLIC_INSTALL_SMOKE_WORKFLOW =
  ".github/workflows/cli-public-install-smoke.yml";

function readWorkflowText() {
  return readFileSync(WORKFLOW, "utf8");
}

function readMirrorWorkflowText() {
  return readFileSync(MIRROR_WORKFLOW, "utf8");
}

function readInternalWorkflowText() {
  return readFileSync(INTERNAL_WORKFLOW, "utf8");
}

function readCliInstallSmokeWorkflowText() {
  return readFileSync(CLI_INSTALL_SMOKE_WORKFLOW, "utf8");
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

test("release-cli keeps the public version bump guard", () => {
  const failures = validateReleaseCliVersionBumpGuard(WORKFLOW, readWorkflowText());
  assert.deepEqual(failures, []);
});

test("release-cli fails when the version bump guard is removed", () => {
  const mutated = readWorkflowText().replace(
    /\n\s+- name: Validate public version bump[\s\S]*?validate-cli-version-bump\.sh\n/,
    "\n",
  );
  const failures = validateReleaseCliVersionBumpGuard(WORKFLOW, mutated);
  assert.ok(
    failures.some((failure) => /must invoke scripts\/ci\/validate-cli-version-bump\.sh/.test(failure)),
  );
});

// cli-install-smoke is the one entry in the allow-table that is not a release
// lane. Its reporter needs issues: write to file a nightly failure, so these
// pin that the exemption stays exactly that wide and no wider.
test("cli-install-smoke keeps issue reporting as its only write scope", () => {
  const failures = validateWorkflowPermissions(
    CLI_INSTALL_SMOKE_WORKFLOW,
    readCliInstallSmokeWorkflowText(),
  );
  assert.deepEqual(failures, []);
});

test("cli-install-smoke fails when the report job gains contents write", () => {
  const mutated = readCliInstallSmokeWorkflowText().replace(
    "      contents: read\n      issues: write",
    "      contents: write\n      issues: write",
  );
  const failures = validateWorkflowPermissions(CLI_INSTALL_SMOKE_WORKFLOW, mutated);
  assert.ok(failures.some((failure) => /job report/.test(failure)));
});

test("cli-install-smoke fails when the install job gains write permissions", () => {
  const doc = readCliInstallSmokeWorkflowText();
  const anchor = "  install-smoke:\n";
  const mutated = doc.replace(anchor, anchor + "    permissions:\n      contents: write\n");
  assert.notEqual(mutated, doc);
  const failures = validateWorkflowPermissions(CLI_INSTALL_SMOKE_WORKFLOW, mutated);
  assert.ok(
    failures.some((failure) => /job install-smoke must not request write permissions/.test(failure)),
  );
});

test("cli-install-smoke fails when workflow-level write permissions appear", () => {
  const mutated = readCliInstallSmokeWorkflowText().replace(
    "permissions:\n  contents: read",
    "permissions: write-all",
  );
  const failures = validateWorkflowPermissions(CLI_INSTALL_SMOKE_WORKFLOW, mutated);
  assert.ok(
    failures.some((failure) => /workflow permissions must be exactly contents: read/.test(failure)),
  );
});

// The public smoke is the second non-release writer, and it earned its entry by
// failing this check first: an unlisted workflow must be read-only, so adding
// the lane without adding the table row is caught rather than assumed. These
// pin that its exemption is exactly as wide as the internal one (ATO-1863).
function readCliPublicInstallSmokeWorkflowText() {
  return readFileSync(CLI_PUBLIC_INSTALL_SMOKE_WORKFLOW, "utf8");
}

test("cli-public-install-smoke keeps issue reporting as its only write scope", () => {
  const failures = validateWorkflowPermissions(
    CLI_PUBLIC_INSTALL_SMOKE_WORKFLOW,
    readCliPublicInstallSmokeWorkflowText(),
  );
  assert.deepEqual(failures, []);
});

test("cli-public-install-smoke fails when the report job gains contents write", () => {
  const mutated = readCliPublicInstallSmokeWorkflowText().replace(
    "      contents: read\n      issues: write",
    "      contents: write\n      issues: write",
  );
  const failures = validateWorkflowPermissions(
    CLI_PUBLIC_INSTALL_SMOKE_WORKFLOW,
    mutated,
  );
  assert.ok(failures.some((failure) => /job report/.test(failure)));
});

test("cli-public-install-smoke fails when the smoke job gains write permissions", () => {
  const doc = readCliPublicInstallSmokeWorkflowText();
  const anchor = "  public-install-smoke:\n";
  const mutated = doc.replace(
    anchor,
    anchor + "    permissions:\n      contents: write\n",
  );
  assert.notEqual(mutated, doc);
  const failures = validateWorkflowPermissions(
    CLI_PUBLIC_INSTALL_SMOKE_WORKFLOW,
    mutated,
  );
  assert.ok(
    failures.some((failure) =>
      /job public-install-smoke must not request write permissions/.test(failure),
    ),
  );
});

test("cli-public-install-smoke fails when workflow-level write permissions appear", () => {
  const mutated = readCliPublicInstallSmokeWorkflowText().replace(
    "permissions:\n  contents: read",
    "permissions: write-all",
  );
  const failures = validateWorkflowPermissions(
    CLI_PUBLIC_INSTALL_SMOKE_WORKFLOW,
    mutated,
  );
  assert.ok(
    failures.some((failure) =>
      /workflow permissions must be exactly contents: read/.test(failure),
    ),
  );
});

const CORE_ECR_WORKFLOW = ".github/workflows/core-ecr-dev-staging.yml";

test("core-ecr-dev-staging keeps OIDC publish permissions only", () => {
  const text = readFileSync(CORE_ECR_WORKFLOW, "utf8");
  const failures = validateWorkflowPermissions(CORE_ECR_WORKFLOW, text);
  assert.deepEqual(failures, []);
});

test("core-ecr-dev-staging fails when packages:write is added", () => {
  const text = readFileSync(CORE_ECR_WORKFLOW, "utf8");
  const mutated = text.replace(
    "permissions:\n  contents: read\n  id-token: write",
    "permissions:\n  contents: read\n  id-token: write\n  packages: write",
  );
  const failures = validateWorkflowPermissions(CORE_ECR_WORKFLOW, mutated);
  assert.ok(
    failures.some((failure) =>
      /workflow permissions must be exactly contents: read, id-token: write/.test(failure),
    ),
  );
});
