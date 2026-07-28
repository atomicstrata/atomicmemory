#!/usr/bin/env node
/**
 * Enforce AtomicMemory release-safety policy on this repository.
 *
 * Policy:
 * - Publish workflows are repository_dispatch only; workflow_dispatch is
 *   forbidden so the only way to trigger one is the audited release workflow.
 * - Publish workflows do not reference NPM_TOKEN; they MUST use
 *   `permissions: id-token: write` for npm Trusted Publishing.
 * - Every npm-published package's prepublishOnly invokes
 *   scripts/guards/guard-npm-publish.mjs.
 * - Every npm-published package sets publishConfig.access=public and
 *   declares no file: / link: dependencies.
 * - CODEOWNERS covers the publish workflow file.
 * - Container-image publishers are explicitly enumerated: any workflow that
 *   pushes images (docker push / buildx --push / output exporters /
 *   imagetools create / docker/build-push-action) must be either a
 *   publish-*.yml release lane (covered by the invariants above) or the
 *   enumerated internal operator publisher. That publisher's workflow YAML
 *   is parsed structurally and must guard every job on the
 *   atomicmemory-internal repository, assign IMAGE_NAME exactly once at the
 *   workflow level (pinned to the private internal package), and push only
 *   via buildx --push with every --tag deriving from that pin.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const PUBLISH_WORKFLOW = ".github/workflows/publish-packages.yml";
const CODEOWNERS_FILE = ".github/CODEOWNERS";
const GUARD_REL_PATH = "scripts/guards/guard-npm-publish.mjs";
const PUBLISH_WORKFLOW_FILENAME_PREFIX = "publish-";
const INTERNAL_IMAGE_WORKFLOW_FILENAME = "internal-core-docker-image.yml";
const INTERNAL_IMAGE_NAME = "ghcr.io/atomicstrata/atomicmemory-core-internal";
// The job-level `if` must equal this exactly (whitespace-normalized): a
// compound condition (e.g. `A || B`) could satisfy a substring match while
// still running in the mirrored public repository.
const INTERNAL_REPO_GUARD_EXACT = "github.repository == 'atomicstrata/atomicmemory-internal'";
// --output=type=registry and --output type=image,push=true are buildx's
// long-form equivalents of --push; treat them as the same sink.
const OUTPUT_EXPORTER_RE = /(^|\s)(-o|--output)[=\s][^\n]*\b(type=registry|push=true)\b/;
// Non-buildx registry-push tools available on hosted runners.
const OTHER_PUSH_SINKS_RE = /\b(docker\s+image\s+push|docker\s+compose\s+push|docker-compose\s+push|podman\s+(image\s+)?push|buildah\s+push|skopeo\s+(copy|sync)|crane\s+(push|cp|copy)|oras\s+push)\b/;
// Reusable-workflow refs that publish; a job-level `uses:` of one of these
// from outside the audited release lane would launder a publish.
const PUBLISHING_WORKFLOW_REF_RE = /(^|\/)(publish-[^/@\s]*\.ya?ml|internal-core-docker-image\.yml)(@|$)/i;
const EXPRESSION_MARKER = "$" + "{{";
const COMPOSITE_SCAN_SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".turbo", ".worktrees"]);
// Actions the enumerated internal publisher may use; anything else (any
// case) is a policy failure so a new action is an explicit policy change.
const INTERNAL_ALLOWED_ACTIONS = [
  "actions/checkout@",
  "docker/setup-qemu-action@",
  "docker/setup-buildx-action@",
];
const PUBLISHED_PACKAGE_PATHS = [
  "packages/core/package.json",
  "packages/sdk/package.json",
  "packages/cli/package.json",
  "packages/mcp-server/package.json",
  "adapters/langchain/package.json",
  "adapters/langgraph/package.json",
  "adapters/mastra/package.json",
  "adapters/openai-agents/package.json",
  "adapters/vercel-ai/package.json",
  "plugins/claude-code/package.json",
  "plugins/openclaw/package.json",
  "plugins/hermes/package.json",
];

if (process.argv[1] && process.argv[1].endsWith("release-policy.mjs")) main();

function main() {
  const failures = runPolicy({ repoRoot });
  if (failures.length === 0) {
    console.log("release-policy: passed.");
    return;
  }
  for (const failure of failures) console.error(`release-policy: ${failure}`);
  process.exit(1);
}

export function runPolicy(options) {
  const root = options.repoRoot;
  const failures = [];
  failures.push(...checkPublishWorkflows(root));
  failures.push(...checkImagePublishers(root));
  failures.push(...checkPublishedPackages(root));
  failures.push(...checkCodeownersCovers(root));
  return failures;
}

function checkImagePublishers(root) {
  const failures = [];
  for (const workflowPath of listWorkflowPaths(root)) {
    const basename = workflowPath.split("/").pop();
    // Skip only what checkPublishWorkflows actually covers (publish-*.yml);
    // a publish-*.yaml would otherwise escape both checks.
    if (basename.startsWith(PUBLISH_WORKFLOW_FILENAME_PREFIX) && basename.endsWith(".yml")) continue;
    const text = safeRead(root, workflowPath);
    if (text === null) continue;
    failures.push(...checkImagePublisherText(text, workflowPath));
  }
  for (const actionPath of listCompositeActionPaths(root)) {
    const text = safeRead(root, actionPath);
    if (text === null) continue;
    failures.push(...checkCompositeActionText(text, actionPath));
  }
  return failures;
}

/**
 * Composite actions (action.yml) can run shell of their own; none may
 * contain a push sink -- a workflow step's `uses: ./path` would otherwise
 * publish without anything visible in the workflow file.
 */
export function checkCompositeActionText(rawText, filename) {
  let doc;
  try {
    doc = parseYaml(rawText, { merge: true }) ?? {};
  } catch (error) {
    return [`${filename}: action YAML failed to parse, so image-publisher policy cannot validate it (${error.message}).`];
  }
  const steps = Array.isArray(doc?.runs?.steps) ? doc.runs.steps : [];
  const shellText = steps
    .map((step) => (typeof step?.run === "string" ? step.run.replace(/\\\r?\n\s*/g, " ") : ""))
    .join("\n")
    .replace(/(^|[\s"'])-([to])(?=[^\s=])/gm, "$1-$2 ");
  const usesPushAction = steps.some(
    (step) => typeof step?.uses === "string" && step.uses.toLowerCase().startsWith("docker/build-push-action"),
  );
  if (pushesContainerImages(shellText) || usesPushAction) {
    return [`${filename}: composite actions must not push container images; only publish-*.yml release lanes and ${INTERNAL_IMAGE_WORKFLOW_FILENAME} may publish.`];
  }
  return [];
}

function listCompositeActionPaths(root) {
  const results = [];
  const walk = (relDir) => {
    let entries;
    try {
      entries = readdirSync(resolve(root, relDir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        const enter = entry.name === ".github" || (!COMPOSITE_SCAN_SKIP_DIRS.has(entry.name) && !entry.name.startsWith("."));
        if (enter) walk(relPath);
      } else if (entry.name === "action.yml" || entry.name === "action.yaml") {
        results.push(relPath);
      }
    }
  };
  walk("");
  return results;
}

/**
 * Structured image-publisher validation. The workflow YAML is parsed (so
 * quoted keys, flow mappings, anchors, and aliases cannot hide an
 * assignment), run scripts are extracted per step with backslash-newline
 * continuations joined (so no sink can be split across lines), and the
 * destination contract is a positive assertion: one workflow-level
 * IMAGE_NAME pin, every --tag derived from it, buildx --push as the only
 * push path. A workflow that fails to parse fails the policy.
 */
export function checkImagePublisherText(rawText, filename) {
  let doc;
  try {
    // merge: true resolves YAML merge keys (<<: *anchor) the way a runner
    // would, so inherited steps cannot hide from the scan below.
    doc = parseYaml(rawText, { merge: true }) ?? {};
  } catch (error) {
    return [`${filename}: workflow YAML failed to parse, so image-publisher policy cannot validate it (${error.message}).`];
  }
  if (typeof doc !== "object") {
    return [`${filename}: workflow YAML is not a mapping, so image-publisher policy cannot validate it.`];
  }

  const jobs = Object.entries(doc.jobs ?? {});
  const runScripts = [];
  const usedActions = [];
  const jobLevelUses = [];
  for (const [jobName, job] of jobs) {
    if (typeof job?.uses === "string") jobLevelUses.push({ jobName, ref: job.uses });
    for (const step of Array.isArray(job?.steps) ? job.steps : []) {
      if (typeof step?.run === "string") runScripts.push(step.run.replace(/\\\r?\n\s*/g, " "));
      if (typeof step?.uses === "string") usedActions.push(step.uses);
    }
  }

  const failuresEarly = [];
  // A job-level `uses:` of a publishing reusable workflow is itself a
  // publish path: only publish-*.yml release lanes may call one, and the
  // enumerated internal publisher may not delegate to reusable workflows
  // at all.
  for (const { jobName, ref } of jobLevelUses) {
    if (filename.endsWith(INTERNAL_IMAGE_WORKFLOW_FILENAME)) {
      failuresEarly.push(`${filename}: job '${jobName}' must not call a reusable workflow (uses: ${ref}); the internal image publisher defines its own steps only.`);
    } else if (PUBLISHING_WORKFLOW_REF_RE.test(ref)) {
      failuresEarly.push(`${filename}: job '${jobName}' calls publishing reusable workflow ${ref}; only publish-*.yml release lanes may do that.`);
    }
  }
  if (failuresEarly.length > 0 && !filename.endsWith(INTERNAL_IMAGE_WORKFLOW_FILENAME)) return failuresEarly;
  // Docker accepts compact short-option forms (-tVALUE, -oVALUE); split them
  // so the sink and destination scans below see the canonical spaced form.
  const shellText = runScripts.join("\n").replace(/(^|[\s"'])-([to])(?=[^\s=])/gm, "$1-$2 ");
  // GitHub resolves action owner/repo case-insensitively.
  const usesPushAction = usedActions.some((action) => action.toLowerCase().startsWith("docker/build-push-action"));

  if (!pushesContainerImages(shellText) && !usesPushAction) return failuresEarly;
  if (!filename.endsWith(INTERNAL_IMAGE_WORKFLOW_FILENAME)) {
    return [
      `${filename}: pushes container images but is neither a ${PUBLISH_WORKFLOW_FILENAME_PREFIX}*.yml release lane nor the enumerated internal image publisher (${INTERNAL_IMAGE_WORKFLOW_FILENAME}).`,
    ];
  }

  const failures = failuresEarly;
  // (1) Every job must carry the repository guard as its EXACT `if`
  //     condition; substring matching would accept compound conditions that
  //     also run in the mirrored public repository.
  for (const [jobName, job] of jobs) {
    const condition = typeof job?.if === "string" ? job.if.replace(/\s+/g, " ").trim() : "";
    if (condition !== INTERNAL_REPO_GUARD_EXACT) {
      failures.push(`${filename}: job '${jobName}' must be guarded with exactly if: ${INTERNAL_REPO_GUARD_EXACT} (found: ${condition || "none"}).`);
    }
  }
  // (2) Exactly one IMAGE_NAME env assignment may exist, at the workflow
  //     level, pinned to the internal package. The parser resolves quoted
  //     keys, flow mappings, and anchor/alias tricks before we count.
  const assignments = collectImageNameAssignments(doc, jobs);
  const pin = assignments.length === 1 ? assignments[0] : undefined;
  if (!pin || pin.where !== "workflow env" || pin.value !== INTERNAL_IMAGE_NAME) {
    const found = assignments.map((a) => `${a.where}=${a.value}`).join(", ") || "none";
    failures.push(`${filename}: must assign env IMAGE_NAME exactly once, at the workflow level, pinned to ${INTERNAL_IMAGE_NAME} (found: ${found}).`);
  }
  // (3) No shell-side reassignment (IMAGE_NAME=... in run blocks or
  //     GITHUB_ENV writes).
  if (/\bIMAGE_NAME\s*=/.test(shellText)) {
    failures.push(`${filename}: IMAGE_NAME must not be reassigned in shell or GITHUB_ENV; the single env pin is the only allowed assignment.`);
  }
  // (4) Every --tag / -t argument must reference ${IMAGE_NAME} directly, so
  //     pushes cannot be routed through another variable or a literal path.
  for (const match of shellText.matchAll(/(?:^|[\s"'])(?:--tag|-t)["'=\s]+([^\s"']+)/g)) {
    if (!/^\$\{IMAGE_NAME\}[:@]/.test(match[1])) {
      failures.push(`${filename}: every --tag must derive from \${IMAGE_NAME} directly (found '--tag ${match[1]}').`);
    }
  }
  // (5) The only allowed push path is a buildx --push run step: raw output
  //     exporters, docker push, imagetools create, and docker/build-push-action
  //     would all publish without a --tag this policy can pin.
  if (OUTPUT_EXPORTER_RE.test(shellText)) {
    failures.push(`${filename}: raw buildx output exporters (--output/-o type=registry or push=true) are forbidden; push only via --push with --tag \${IMAGE_NAME}.`);
  }
  if (/\bdocker\s+push\b/.test(shellText) || /\bimagetools\s+create\b/.test(shellText) || OTHER_PUSH_SINKS_RE.test(shellText)) {
    failures.push(`${filename}: docker push, imagetools create, and non-buildx push tools (podman/buildah/skopeo/crane/oras/compose push) are forbidden here; they publish without a --tag the policy can pin. Push only via buildx --push.`);
  }
  if (usesPushAction) {
    failures.push(`${filename}: docker/build-push-action is forbidden here; push only via a buildx --push run step so the --tag contract applies.`);
  }
  // (6) Run scripts must not interpolate GitHub expressions: text from
  //     dispatch inputs or the checked-out branch (e.g. a package.json
  //     version) would be substituted into shell before it runs. Dynamic
  //     values must reach shell as step env instead.
  if (shellText.includes(EXPRESSION_MARKER)) {
    failures.push(`${filename}: run scripts must not interpolate ${EXPRESSION_MARKER} ... }} GitHub expressions; pass dynamic values via step env so inputs and branch content cannot inject into shell.`);
  }
  // (7) Only enumerated actions may be used, so no third-party or local
  //     composite action can push on this workflow's behalf.
  for (const action of usedActions) {
    if (!INTERNAL_ALLOWED_ACTIONS.some((allowed) => action.toLowerCase().startsWith(allowed))) {
      failures.push(`${filename}: uses: ${action} is not in the internal image publisher's action allowlist (${INTERNAL_ALLOWED_ACTIONS.join(", ")}).`);
    }
  }
  return failures;
}

function collectImageNameAssignments(doc, jobs) {
  const assignments = [];
  const collect = (env, where) => {
    if (!env || typeof env !== "object") return;
    for (const [key, value] of Object.entries(env)) {
      if (key === "IMAGE_NAME") assignments.push({ where, value: String(value) });
    }
  };
  collect(doc.env, "workflow env");
  for (const [jobName, job] of jobs) {
    collect(job?.env, `job '${jobName}' env`);
    collect(job?.container?.env, `job '${jobName}' container env`);
    (Array.isArray(job?.steps) ? job.steps : []).forEach((step, index) => {
      collect(step?.env, `job '${jobName}' step ${index + 1} env`);
    });
  }
  return assignments;
}

function pushesContainerImages(text) {
  return (
    /(^|\s)--push\b/.test(text) ||
    /\bdocker\s+push\b/.test(text) ||
    /\bimagetools\s+create\b/.test(text) ||
    OUTPUT_EXPORTER_RE.test(text) ||
    OTHER_PUSH_SINKS_RE.test(text)
  );
}

function listWorkflowPaths(root) {
  const dir = resolve(root, ".github/workflows");
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
      .map((name) => `.github/workflows/${name}`);
  } catch {
    return [];
  }
}

function checkPublishWorkflows(root) {
  const failures = [];
  for (const workflowPath of listPublishWorkflowPaths(root)) {
    const text = safeRead(root, workflowPath);
    if (text === null) continue;
    failures.push(...checkWorkflowText(text, workflowPath));
  }
  return failures;
}

function listPublishWorkflowPaths(root) {
  const dir = resolve(root, ".github/workflows");
  try {
    return readdirSync(dir)
      .filter((name) => name.startsWith(PUBLISH_WORKFLOW_FILENAME_PREFIX) && name.endsWith(".yml"))
      .map((name) => `.github/workflows/${name}`);
  } catch {
    return [];
  }
}

export function checkWorkflowText(text, filename) {
  const failures = [];
  if (declaresTrigger(text, "workflow_dispatch")) {
    failures.push(`${filename}: publish workflows must not expose workflow_dispatch.`);
  }
  if (publishesToNpm(text)) {
    if (/\bNPM_TOKEN\b/.test(text)) {
      failures.push(`${filename}: npm publish workflows must not reference NPM_TOKEN (use npm Trusted Publishing).`);
    }
    if (!/\bid-token\s*:\s*write\b/.test(text)) {
      failures.push(`${filename}: npm publish workflows must declare permissions: id-token: write.`);
    }
  }
  return failures;
}

function declaresTrigger(text, name) {
  return new RegExp(`^\\s*${name}\\s*:`, "m").test(text);
}

function publishesToNpm(text) {
  return /\bnpm\s+publish\b/.test(text);
}

function checkPublishedPackages(root) {
  const failures = [];
  for (const relPath of PUBLISHED_PACKAGE_PATHS) {
    const text = safeRead(root, relPath);
    if (text === null) {
      failures.push(`${relPath}: missing from repository (release-policy expected it).`);
      continue;
    }
    failures.push(...checkPackageManifest(JSON.parse(text), relPath));
  }
  return failures;
}

export function checkPackageManifest(packageJson, filename) {
  const failures = [];
  const prepublish = packageJson.scripts?.prepublishOnly ?? "";
  if (!prepublish.includes(GUARD_REL_PATH)) {
    failures.push(`${filename}: prepublishOnly must invoke ${GUARD_REL_PATH}.`);
  }
  if (packageJson.publishConfig?.access !== "public") {
    failures.push(`${filename}: publishConfig.access must equal 'public'.`);
  }
  failures.push(...findUnpublishableDependencies(packageJson, filename));
  return failures;
}

function findUnpublishableDependencies(packageJson, filename) {
  const failures = [];
  const buckets = ["dependencies", "peerDependencies", "optionalDependencies"];
  for (const bucket of buckets) {
    for (const [name, range] of Object.entries(packageJson[bucket] ?? {})) {
      if (typeof range !== "string") continue;
      if (range.startsWith("file:") || range.startsWith("link:")) {
        failures.push(`${filename}: ${bucket}.${name}='${range}' is not publishable.`);
      }
    }
  }
  return failures;
}

function checkCodeownersCovers(root) {
  const text = safeRead(root, CODEOWNERS_FILE);
  if (text === null) return [`${CODEOWNERS_FILE}: missing; required to own ${PUBLISH_WORKFLOW}.`];
  return [
    ...checkCodeownersText(text, PUBLISH_WORKFLOW),
    ...checkCodeownersText(text, `.github/workflows/${INTERNAL_IMAGE_WORKFLOW_FILENAME}`),
  ];
}

export function checkCodeownersText(text, requiredPath) {
  const owned = ownedPaths(text);
  const isCovered = owned.some((pattern) => coversPath(pattern, requiredPath));
  return isCovered ? [] : [`${CODEOWNERS_FILE}: no rule covers ${requiredPath}.`];
}

function ownedPaths(text) {
  return text.split("\n")
    .map((line) => line.replace(/#.*$/, "").trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/)[0])
    .filter(Boolean);
}

function coversPath(pattern, requiredPath) {
  if (pattern === "*") return true;
  const normalized = pattern.startsWith("/") ? pattern.slice(1) : pattern;
  if (normalized.endsWith("/")) return requiredPath.startsWith(normalized);
  return requiredPath === normalized;
}

function safeRead(root, relPath) {
  try {
    return readFileSync(resolve(root, relPath), "utf8");
  } catch {
    return null;
  }
}
