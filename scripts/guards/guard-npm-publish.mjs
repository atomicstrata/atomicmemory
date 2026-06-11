#!/usr/bin/env node
/**
 * Refuse a local `npm publish` for AtomicMemory packages.
 *
 * This guard is wired as `prepublishOnly` in every npm package published
 * from the monorepo. It asserts that the publish is running inside the
 * approved GitHub Actions workflow with a valid release manifest and that
 * the current package is one of the manifest's selected targets at the
 * recorded version. It is an accidental-publish guard, not a security
 * boundary — the real boundary is npm Trusted Publishing.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REQUIRED_REPO = "atomicstrata/atomicmemory";
const REQUIRED_WORKFLOW = "publish-packages";
const MANIFEST_ENV = "ATOMICMEMORY_RELEASE_MANIFEST";
const WORKFLOW_ENV = "ATOMICMEMORY_RELEASE_WORKFLOW";
const SCHEMA_VERSION = 1;

if (process.argv[1] && process.argv[1].endsWith("guard-npm-publish.mjs")) main();

function main() {
  try {
    const packageJson = readJson(resolve(process.cwd(), "package.json"));
    enforce({ packageJson, env: process.env });
    console.log(`guard-npm-publish: approved publish of ${packageJson.name}@${packageJson.version}.`);
  } catch (error) {
    console.error(`guard-npm-publish: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}

export function enforce({ packageJson, env }) {
  assertGithubActionsContext(env);
  const manifest = readManifest(env);
  assertSelectedAtCurrentVersion(manifest, packageJson);
}

function assertGithubActionsContext(env) {
  if (env.GITHUB_ACTIONS !== "true") throw new Error("must run inside GitHub Actions (GITHUB_ACTIONS=true).");
  if (env.GITHUB_REPOSITORY !== REQUIRED_REPO) {
    throw new Error(`must run in ${REQUIRED_REPO}, not ${env.GITHUB_REPOSITORY || "<unset>"}.`);
  }
  if (env[WORKFLOW_ENV] !== REQUIRED_WORKFLOW) {
    throw new Error(`expected ${WORKFLOW_ENV}=${REQUIRED_WORKFLOW}, got ${env[WORKFLOW_ENV] || "<unset>"}.`);
  }
  if (!env[MANIFEST_ENV]) throw new Error(`expected ${MANIFEST_ENV} to point at a release manifest file.`);
}

function readManifest(env) {
  const path = env[MANIFEST_ENV];
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`could not read manifest at ${path}: ${error instanceof Error ? error.message : error}`);
  }
  if (parsed.schema_version !== SCHEMA_VERSION) {
    throw new Error(`manifest schema_version ${parsed.schema_version} is not supported.`);
  }
  if (!Array.isArray(parsed.selected_targets)) throw new Error("manifest is missing selected_targets array.");
  return parsed;
}

function assertSelectedAtCurrentVersion(manifest, packageJson) {
  const target = manifest.selected_targets.find((entry) => entry.name === packageJson.name);
  if (!target) {
    const selected = manifest.selected_targets.map((entry) => entry.name).join(", ") || "<none>";
    throw new Error(`${packageJson.name} is not in the manifest selected_targets (${selected}).`);
  }
  if (target.version !== packageJson.version) {
    throw new Error(`${packageJson.name} manifest version ${target.version} does not match package.json ${packageJson.version}.`);
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}
