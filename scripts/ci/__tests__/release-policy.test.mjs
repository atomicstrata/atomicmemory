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
  checkCompositeActionText,
  checkImagePublisherText,
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

const VALID_INTERNAL_IMAGE_YAML = [
  "env:",
  "  IMAGE_NAME: ghcr.io/atomicstrata/atomicmemory-core-internal",
  "jobs:",
  "  publish:",
  "    if: github.repository == 'atomicstrata/atomicmemory-internal'",
  "    steps:",
  '      - run: docker buildx build --tag "${IMAGE_NAME}:sha-abc1234" --push .',
  "",
].join("\n");

test("workflow without image pushes is not held to image-publisher policy", () => {
  assert.deepEqual(checkImagePublisherText("jobs:\n  x:\n    steps:\n      - run: docker build .\n", ".github/workflows/ci.yml"), []);
});

test("non-enumerated workflow pushing images is rejected", () => {
  const failures = checkImagePublisherText("jobs:\n  x:\n    steps:\n      - run: docker buildx build --push .\n", ".github/workflows/nightly.yml");
  assert.ok(failures.some((failure) => /neither a publish-\*\.yml release lane nor the enumerated internal image publisher/.test(failure)));
});

test("internal image publisher without the repository guard is rejected", () => {
  const yaml = VALID_INTERNAL_IMAGE_YAML.replace(/^.*github\.repository.*\n/m, "");
  const failures = checkImagePublisherText(yaml, ".github/workflows/internal-core-docker-image.yml");
  assert.ok(failures.some((failure) => /repository guard|github\.repository/.test(failure)));
});

test("internal image publisher pinned to the wrong image name is rejected", () => {
  const yaml = VALID_INTERNAL_IMAGE_YAML.replace("atomicmemory-core-internal", "atomicmemory-core");
  const failures = checkImagePublisherText(yaml, ".github/workflows/internal-core-docker-image.yml");
  assert.ok(failures.some((failure) => /assign env IMAGE_NAME exactly once/.test(failure)));
});

test("internal image publisher tagging a literal registry path is rejected", () => {
  const yaml = VALID_INTERNAL_IMAGE_YAML.replace('--tag "${IMAGE_NAME}:sha-abc1234"', '--tag "ghcr.io/atomicstrata/atomicmemory-core:latest"');
  const failures = checkImagePublisherText(yaml, ".github/workflows/internal-core-docker-image.yml");
  assert.ok(failures.some((failure) => /derive from \$\{IMAGE_NAME\} directly/.test(failure)));
});

test("internal image publisher pushing through another variable is rejected", () => {
  const yaml = VALID_INTERNAL_IMAGE_YAML.replace('--tag "${IMAGE_NAME}:sha-abc1234"', '--tag "${ALT_IMAGE}:latest"');
  const failures = checkImagePublisherText(yaml, ".github/workflows/internal-core-docker-image.yml");
  assert.ok(failures.some((failure) => /derive from \$\{IMAGE_NAME\} directly/.test(failure)));
});

test("internal image publisher overriding IMAGE_NAME via quoted key or flow mapping is rejected", () => {
  const yaml = VALID_INTERNAL_IMAGE_YAML.replace(
    "    steps:",
    '    steps:\n      - env: { "IMAGE_NAME": "ghcr.io/atomicstrata/atomicmemory-core" }',
  );
  const failures = checkImagePublisherText(yaml, ".github/workflows/internal-core-docker-image.yml");
  assert.ok(failures.some((failure) => /exactly once/.test(failure)));
});

test("workflow splitting --output type=registry across continuation lines is treated as a publisher", () => {
  const yaml = "jobs:\n  x:\n    steps:\n      - run: |\n          docker buildx build --output \\\n            type=registry .\n";
  const failures = checkImagePublisherText(yaml, ".github/workflows/nightly.yml");
  assert.ok(failures.some((failure) => /neither a publish-\*\.yml release lane/.test(failure)));
});

test("internal image publisher using docker push or imagetools create is rejected", () => {
  const yaml = VALID_INTERNAL_IMAGE_YAML + '      - run: docker push "${IMAGE_NAME}:sha-abc1234"\n';
  const failures = checkImagePublisherText(yaml, ".github/workflows/internal-core-docker-image.yml");
  assert.ok(failures.some((failure) => /forbidden here; they publish without a --tag/.test(failure)));
});

test("valid internal image publisher fixture passes", () => {
  assert.deepEqual(checkImagePublisherText(VALID_INTERNAL_IMAGE_YAML, ".github/workflows/internal-core-docker-image.yml"), []);
});

test("workflow pushing via --output=type=registry is treated as a publisher", () => {
  const failures = checkImagePublisherText("jobs:\n  x:\n    steps:\n      - run: docker buildx build --output=type=registry,name=ghcr.io/x/y .\n", ".github/workflows/nightly.yml");
  assert.ok(failures.some((failure) => /neither a publish-\*\.yml release lane/.test(failure)));
});

test("workflow pushing via --output type=image,push=true is treated as a publisher", () => {
  const failures = checkImagePublisherText("jobs:\n  x:\n    steps:\n      - run: docker buildx build --output type=image,name=ghcr.io/x/y,push=true .\n", ".github/workflows/nightly.yml");
  assert.ok(failures.some((failure) => /neither a publish-\*\.yml release lane/.test(failure)));
});

test("internal image publisher with a step-level IMAGE_NAME override is rejected", () => {
  const yaml = VALID_INTERNAL_IMAGE_YAML.replace(
    "    steps:",
    "    steps:\n      - env:\n          IMAGE_NAME: ghcr.io/atomicstrata/atomicmemory-core",
  );
  const failures = checkImagePublisherText(yaml, ".github/workflows/internal-core-docker-image.yml");
  assert.ok(failures.some((failure) => /exactly once/.test(failure)));
});

test("internal image publisher reassigning IMAGE_NAME in shell is rejected", () => {
  const yaml = VALID_INTERNAL_IMAGE_YAML.replace(
    "    steps:",
    '    steps:\n      - run: echo "IMAGE_NAME=ghcr.io/atomicstrata/atomicmemory-core" >> "$GITHUB_ENV"',
  );
  const failures = checkImagePublisherText(yaml, ".github/workflows/internal-core-docker-image.yml");
  assert.ok(failures.some((failure) => /must not be reassigned/.test(failure)));
});

test("internal image publisher using raw output exporters is rejected", () => {
  const yaml = VALID_INTERNAL_IMAGE_YAML.replace("--push .", "--output=type=registry .");
  const failures = checkImagePublisherText(yaml, ".github/workflows/internal-core-docker-image.yml");
  assert.ok(failures.some((failure) => /raw buildx output exporters/.test(failure)));
});

test("internal image publisher overriding IMAGE_NAME via YAML anchor/alias is rejected", () => {
  const yaml = [
    "env:",
    "  IMAGE_NAME: &pin ghcr.io/atomicstrata/atomicmemory-core-internal",
    "jobs:",
    "  publish:",
    "    if: github.repository == 'atomicstrata/atomicmemory-internal'",
    "    steps:",
    "      - env:",
    "          IMAGE_NAME: *pin",
    '      - run: docker buildx build --tag "${IMAGE_NAME}:sha-abc1234" --push .',
    "",
  ].join("\n");
  const failures = checkImagePublisherText(yaml, ".github/workflows/internal-core-docker-image.yml");
  assert.ok(failures.some((failure) => /exactly once/.test(failure)));
});

test("workflow pushing via docker/build-push-action is treated as a publisher", () => {
  const yaml = "jobs:\n  x:\n    steps:\n      - uses: docker/build-push-action@v6\n        with:\n          push: true\n          tags: ghcr.io/x/y:latest\n";
  const failures = checkImagePublisherText(yaml, ".github/workflows/nightly.yml");
  assert.ok(failures.some((failure) => /neither a publish-\*\.yml release lane/.test(failure)));
});

test("internal image publisher using docker/build-push-action is rejected", () => {
  const yaml = VALID_INTERNAL_IMAGE_YAML + "      - uses: docker/build-push-action@v6\n";
  const failures = checkImagePublisherText(yaml, ".github/workflows/internal-core-docker-image.yml");
  assert.ok(failures.some((failure) => /docker\/build-push-action is forbidden/.test(failure)));
});

test("unparseable workflow YAML fails the image-publisher policy closed", () => {
  const failures = checkImagePublisherText("jobs: [unclosed\n  {bad", ".github/workflows/internal-core-docker-image.yml");
  assert.ok(failures.some((failure) => /failed to parse/.test(failure)));
});

test("internal image publisher using compact -tVALUE tagging is rejected", () => {
  const yaml = VALID_INTERNAL_IMAGE_YAML.replace('--tag "${IMAGE_NAME}:sha-abc1234"', "-tghcr.io/atomicstrata/atomicmemory-core:latest");
  const failures = checkImagePublisherText(yaml, ".github/workflows/internal-core-docker-image.yml");
  assert.ok(failures.some((failure) => /derive from \$\{IMAGE_NAME\} directly/.test(failure)));
});

test("workflow pushing via compact -otype=registry is treated as a publisher", () => {
  const yaml = "jobs:\n  x:\n    steps:\n      - run: docker buildx build -otype=registry,name=ghcr.io/x/y .\n";
  const failures = checkImagePublisherText(yaml, ".github/workflows/nightly.yml");
  assert.ok(failures.some((failure) => /neither a publish-\*\.yml release lane/.test(failure)));
});

test("workflow using a case-variant build-push-action ref is treated as a publisher", () => {
  const yaml = "jobs:\n  x:\n    steps:\n      - uses: Docker/build-push-action@v6\n";
  const failures = checkImagePublisherText(yaml, ".github/workflows/nightly.yml");
  assert.ok(failures.some((failure) => /neither a publish-\*\.yml release lane/.test(failure)));
});

test("internal image publisher with a compound OR repository guard is rejected", () => {
  const yaml = VALID_INTERNAL_IMAGE_YAML.replace(
    "    if: github.repository == 'atomicstrata/atomicmemory-internal'",
    "    if: github.repository == 'atomicstrata/atomicmemory-internal' || github.repository == 'atomicstrata/atomicmemory'",
  );
  const failures = checkImagePublisherText(yaml, ".github/workflows/internal-core-docker-image.yml");
  assert.ok(failures.some((failure) => /guarded with exactly/.test(failure)));
});

test("internal image publisher interpolating GitHub expressions into run is rejected", () => {
  const yaml = VALID_INTERNAL_IMAGE_YAML.replace(
    '--tag "${IMAGE_NAME}:sha-abc1234"',
    '--tag "${IMAGE_NAME}:sha-abc1234" --platform "${{ inputs.platforms }}"',
  );
  const failures = checkImagePublisherText(yaml, ".github/workflows/internal-core-docker-image.yml");
  assert.ok(failures.some((failure) => /must not interpolate/.test(failure)));
});

test("internal image publisher using a non-allowlisted action is rejected", () => {
  const yaml = VALID_INTERNAL_IMAGE_YAML + "      - uses: actions/setup-node@v4\n";
  const failures = checkImagePublisherText(yaml, ".github/workflows/internal-core-docker-image.yml");
  assert.ok(failures.some((failure) => /action allowlist/.test(failure)));
});

test("workflow pushing via docker image push or skopeo copy is treated as a publisher", () => {
  for (const cmd of ["docker image push ghcr.io/x/y", "skopeo copy oci:img docker://ghcr.io/x/y", "podman push ghcr.io/x/y", "docker compose push"]) {
    const failures = checkImagePublisherText(`jobs:\n  x:\n    steps:\n      - run: ${cmd}\n`, ".github/workflows/nightly.yml");
    assert.ok(failures.some((failure) => /neither a publish-\*\.yml release lane/.test(failure)), `expected publisher classification for: ${cmd}`);
  }
});

test("a publish-*.yaml (yaml extension) pushing images is still held to image-publisher policy", () => {
  const failures = checkImagePublisherText("jobs:\n  x:\n    steps:\n      - run: docker buildx build --push .\n", ".github/workflows/publish-evil.yaml");
  assert.ok(failures.some((failure) => /neither a publish-\*\.yml release lane/.test(failure)));
});

test("steps inherited through a YAML merge key are still scanned", () => {
  const yaml = [
    "x: &tpl",
    "  steps:",
    "    - run: docker buildx build --push .",
    "jobs:",
    "  evil:",
    "    <<: *tpl",
    "",
  ].join("\n");
  const failures = checkImagePublisherText(yaml, ".github/workflows/nightly.yml");
  assert.ok(failures.some((failure) => /neither a publish-\*\.yml release lane/.test(failure)));
});

test("non-publish workflow calling a publishing reusable workflow is rejected", () => {
  const yaml = "jobs:\n  x:\n    uses: ./.github/workflows/publish-core-docker.yml\n";
  const failures = checkImagePublisherText(yaml, ".github/workflows/nightly.yml");
  assert.ok(failures.some((failure) => /calls publishing reusable workflow/.test(failure)));
});

test("internal image publisher delegating to any reusable workflow is rejected", () => {
  const yaml = VALID_INTERNAL_IMAGE_YAML + "  delegate:\n    if: github.repository == 'atomicstrata/atomicmemory-internal'\n    uses: ./.github/workflows/other.yml\n";
  const failures = checkImagePublisherText(yaml, ".github/workflows/internal-core-docker-image.yml");
  assert.ok(failures.some((failure) => /must not call a reusable workflow/.test(failure)));
});

test("composite action containing a push sink is rejected", () => {
  const yaml = "name: helper\nruns:\n  using: composite\n  steps:\n    - run: crane cp img ghcr.io/x/y\n      shell: bash\n";
  const failures = checkCompositeActionText(yaml, ".github/actions/helper/action.yml");
  assert.ok(failures.some((failure) => /composite actions must not push/.test(failure)));
});

test("composite action without push sinks passes", () => {
  const yaml = "name: helper\nruns:\n  using: composite\n  steps:\n    - run: docker build -t local/img .\n      shell: bash\n";
  assert.deepEqual(checkCompositeActionText(yaml, ".github/actions/helper/action.yml"), []);
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
