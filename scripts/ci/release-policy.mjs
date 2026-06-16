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
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const PUBLISH_WORKFLOW = ".github/workflows/publish-packages.yml";
const CODEOWNERS_FILE = ".github/CODEOWNERS";
const GUARD_REL_PATH = "scripts/guards/guard-npm-publish.mjs";
const PUBLISH_WORKFLOW_FILENAME_PREFIX = "publish-";
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
  failures.push(...checkPublishedPackages(root));
  failures.push(...checkCodeownersCovers(root));
  return failures;
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
  return checkCodeownersText(text, PUBLISH_WORKFLOW);
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
