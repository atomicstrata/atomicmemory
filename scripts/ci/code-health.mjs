/**
 * Verify package code-health coverage before running package-local fallow gates.
 */
import { dirname } from "node:path";
import { existsSync } from "node:fs";
import { packageJsonFiles, readJson, listRepoFiles } from "./lib/repo-files.mjs";

const FALLOW_VERSION = "2.75.0";
const REQUIRED_CODE_HEALTH = new Set(["packages/core", "packages/sdk"]);
const REQUIRED_SCRIPT_MARKERS = new Map([
  ["packages/core", ["fallow", "--fail-on-issues"]],
  ["packages/sdk", ["fallow audit", "--health-baseline", "--dupes-baseline", "check-baseline-ratchet.sh"]],
]);
const EXEMPT_TS_PACKAGES = new Map([
  ["packages/cli", "no historical fallow gate; covered by build, typecheck, lint, tests, and pack validation"],
  ["packages/mcp-server", "no historical fallow gate; covered by build, typecheck, lint, tests, and pack validation"],
  ["adapters/langchain", "new adapter package; covered by build, typecheck, lint, tests, and pack validation"],
  ["adapters/langgraph", "new adapter package; covered by build, typecheck, lint, tests, and pack validation"],
  ["adapters/mastra", "new adapter package; covered by build, typecheck, lint, tests, and pack validation"],
  ["adapters/openai-agents", "adapter package without a historical fallow gate"],
  ["adapters/vercel-ai", "adapter package without a historical fallow gate"],
  ["plugins/openclaw", "host plugin package without a historical fallow gate"],
]);

function main() {
  const failures = [
    ...validateArgs(process.argv.slice(2)),
    ...validateRootDependency(),
    ...validatePackageCoverage(),
  ];

  if (failures.length > 0) {
    console.error("Code health configuration failed:");
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log("Code health configuration passed.");
}

function validateArgs(args) {
  if (args.length === 0 || (args.length === 1 && args[0] === "--verify")) {
    return [];
  }

  return [`unknown arguments: ${args.join(" ")}`];
}

function validateRootDependency() {
  const manifest = readJson("package.json");
  const actualVersion = manifest.devDependencies?.fallow;
  return actualVersion === FALLOW_VERSION
    ? []
    : [`package.json: devDependencies.fallow must be pinned to ${FALLOW_VERSION}`];
}

function validatePackageCoverage() {
  const repoFiles = listRepoFiles();
  const packageEntries = workspacePackageJsonFiles().map((filePath) => {
    return packageEntry(filePath, repoFiles);
  });

  return [
    ...validateRequiredPackages(packageEntries),
    ...validateTypeScriptPackages(packageEntries),
    ...validateExemptions(packageEntries),
  ];
}

function workspacePackageJsonFiles() {
  return packageJsonFiles().filter((filePath) => {
    return filePath.startsWith("packages/") || filePath.startsWith("adapters/") || filePath.startsWith("plugins/");
  });
}

function packageEntry(filePath, repoFiles) {
  const packageDir = dirname(filePath);
  const manifest = readJson(filePath);
  return {
    packageDir,
    manifest,
    hasFallowConfig: existsSync(`${packageDir}/.fallowrc.json`),
    hasTypeScriptSurface: packageHasTypeScriptSurface(packageDir, repoFiles),
  };
}

function packageHasTypeScriptSurface(packageDir, repoFiles) {
  return repoFiles.some((filePath) => {
    return filePath.startsWith(`${packageDir}/`) && (filePath.endsWith(".ts") || filePath.endsWith(".tsx"));
  });
}

function validateRequiredPackages(packageEntries) {
  return packageEntries.flatMap((entry) => {
    if (!REQUIRED_CODE_HEALTH.has(entry.packageDir) && !entry.hasFallowConfig) {
      return [];
    }

    return validateCodeHealthScript(entry);
  });
}

function validateCodeHealthScript(entry) {
  const script = entry.manifest.scripts?.["code-health"];
  if (typeof script !== "string" || !script.includes("fallow")) {
    return [`${entry.packageDir}: package.json scripts.code-health must run fallow`];
  }

  return validateScriptMarkers(entry.packageDir, script);
}

function validateScriptMarkers(packageDir, script) {
  return (REQUIRED_SCRIPT_MARKERS.get(packageDir) ?? []).flatMap((marker) => {
    return script.includes(marker) ? [] : [`${packageDir}: scripts.code-health must include ${marker}`];
  });
}

function validateTypeScriptPackages(packageEntries) {
  return packageEntries.flatMap((entry) => {
    if (!entry.hasTypeScriptSurface || REQUIRED_CODE_HEALTH.has(entry.packageDir)) {
      return [];
    }

    return EXEMPT_TS_PACKAGES.has(entry.packageDir)
      ? []
      : [`${entry.packageDir}: TypeScript package must add code-health or an explicit exemption`];
  });
}

function validateExemptions(packageEntries) {
  const packageDirs = new Set(packageEntries.map((entry) => entry.packageDir));
  return [...EXEMPT_TS_PACKAGES.keys()].flatMap((packageDir) => {
    return packageDirs.has(packageDir) ? [] : [`${packageDir}: code-health exemption references a missing package`];
  });
}

main();
