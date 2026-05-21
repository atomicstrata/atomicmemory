#!/usr/bin/env node
/**
 * Validate lockstep package-version families.
 *
 * AtomicMemory intentionally avoids one global monorepo version. Instead,
 * only tightly coupled release families move together: host plugins,
 * framework adapters, and the CLI/MCP tool pair. This script is the single
 * source of truth for source-repo CI checks. Release bumping and publish
 * preparation live in the ops repo.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;

const familyName = process.argv[2];
const args = process.argv.slice(3);
const checkOnly = args.includes("--check");
const knownFlags = new Set(["--check"]);
const positional = args.filter((arg) => !arg.startsWith("--"));
const unknownFlag = args.find((arg) => arg.startsWith("--") && !knownFlags.has(arg));

const families = {
  plugin: [
    marketplacePluginTarget(".claude-plugin/marketplace.json", "claude-code"),
    jsonPathTarget("plugins/claude-code/.claude-plugin/plugin.json", ["version"]),
    jsonPathTarget("plugins/claude-code/package.json", ["version"]),
    jsonPathTarget("plugins/codex/.codex-plugin/plugin.json", ["version"]),
    jsonPathTarget("plugins/codex/package.json", ["version"]),
    regexTarget("plugins/codex/skills/atomicmemory/SKILL.md", "metadata.version", /^  version: "([^"]+)"$/m),
    jsonPathTarget("plugins/openclaw/openclaw.plugin.json", ["version"]),
    jsonPathTarget("plugins/openclaw/package.json", ["version"]),
    regexTarget("plugins/openclaw/skills/atomicmemory/skill.yaml", "version", /^version:\s*([^\s]+)\s*$/m),
    jsonPathTarget("plugins/hermes/package.json", ["version"]),
    regexTarget("plugins/hermes/pyproject.toml", "project.version", /^version\s*=\s*"([^"]+)"$/m),
    regexTarget("plugins/hermes/plugin.yaml", "version", /^version:\s*([^\s]+)\s*$/m),
    jsonPathTarget("plugins/cursor/package.json", ["version"]),
  ],
  adapter: [
    jsonPathTarget("adapters/langchain/package.json", ["version"]),
    jsonPathTarget("adapters/langgraph/package.json", ["version"]),
    jsonPathTarget("adapters/mastra/package.json", ["version"]),
    jsonPathTarget("adapters/openai-agents/package.json", ["version"]),
    jsonPathTarget("adapters/vercel-ai/package.json", ["version"]),
  ],
  tool: [
    jsonPathTarget("packages/cli/package.json", ["version"]),
    jsonPathTarget("packages/cli/cli-spec.json", ["package_version"]),
    jsonPathTarget("packages/mcp-server/package.json", ["version"]),
  ],
};

main();

function main() {
  if (!families[familyName]) usage();
  if (unknownFlag) fail(`Unknown flag '${unknownFlag}'. Use --check.`);
  if (!checkOnly || positional.length > 0) usage();

  const targets = families[familyName];
  const current = targets.map((target) => ({ target, version: target.read() }));
  const uniqueVersions = [...new Set(current.map(({ version }) => version))];

  if (uniqueVersions.length > 1) {
    const details = current.map(({ target, version }) => `  - ${target.file} ${target.label}: ${version}`).join("\n");
    fail(`${familyName} versions are not aligned:\n${details}`);
  }

  console.log(`${familyName} versions are aligned at ${uniqueVersions[0]}.`);
}

function usage() {
  const familiesList = Object.keys(families).join("|");
  fail(`Usage: node scripts/version-families.mjs <${familiesList}> --check`);
}

function jsonPathTarget(file, path) {
  return {
    file,
    label: `/${path.join("/")}`,
    read() {
      const json = readJson(file);
      const version = readAtPath(json, path);
      assertVersion(version, `${file} /${path.join("/")}`);
      return version;
    },
  };
}

function marketplacePluginTarget(file, pluginName) {
  return {
    file,
    label: `plugins[${pluginName}].version`,
    read() {
      const plugin = findMarketplacePlugin(readJson(file), pluginName, file);
      assertVersion(plugin.version, `${file} plugins[${pluginName}].version`);
      return plugin.version;
    },
  };
}

function regexTarget(file, label, pattern) {
  const absolute = resolve(repoRoot, file);
  return {
    file,
    label,
    read() {
      const content = readFileSync(absolute, "utf8");
      const match = content.match(pattern);
      if (!match) fail(`Could not find ${label} in ${file}`);
      assertVersion(match[1], `${file} ${label}`);
      return match[1];
    },
  };
}

function readJson(file) {
  return JSON.parse(readFileSync(resolve(repoRoot, file), "utf8"));
}

function readAtPath(value, path) {
  return path.reduce((current, segment) => current?.[segment], value);
}

function findMarketplacePlugin(json, pluginName, file) {
  const plugin = json.plugins?.find((entry) => entry.name === pluginName);
  if (!plugin) fail(`Could not find plugin '${pluginName}' in ${file}`);
  return plugin;
}

function assertVersion(version, label) {
  if (!VERSION_RE.test(version)) fail(`${label} has unsupported version '${version}'. Expected x.y.z.`);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
