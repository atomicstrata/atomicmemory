/**
 * Validate public npm package metadata for monorepo package manifests.
 */
import { packageJsonFiles, readJson } from "./lib/repo-files.mjs";

const MONOREPO_URL = "git+https://github.com/atomicstrata/atomicmemory.git";
const BUGS_URL = "https://github.com/atomicstrata/atomicmemory/issues";
const HOMEPAGE_ROOT = "https://github.com/atomicstrata/atomicmemory/tree/main";
const PUBLISHABLE_ROOTS = ["packages/", "adapters/", "plugins/"];
const HOST_PLUGIN_ARTIFACTS = [
  ".claude-plugin",
  "openclaw.plugin.json",
  "plugin.yaml",
  ".cursor",
  ".codex-plugin",
];

function isPublishablePackage(filePath, manifest) {
  if (manifest.private === true || filePath === "package.json") {
    return false;
  }

  return PUBLISHABLE_ROOTS.some((root) => filePath.startsWith(root));
}

function validateManifest(filePath) {
  const manifest = readJson(filePath);
  if (!isPublishablePackage(filePath, manifest)) {
    return [];
  }

  const packageDir = filePath.replace(/\/package\.json$/, "");
  return [
    ...requiredString(filePath, manifest, "name"),
    ...requiredString(filePath, manifest, "version"),
    ...validateRepository(filePath, packageDir, manifest.repository),
    ...validateFixedString(filePath, manifest.bugs?.url, "bugs.url", BUGS_URL),
    ...validateFixedString(filePath, manifest.homepage, "homepage", `${HOMEPAGE_ROOT}/${packageDir}#readme`),
    ...validateLicense(filePath, manifest.license),
    ...validateEntrypoints(filePath, manifest, manifest.files),
    ...validateFiles(filePath, manifest.files),
  ];
}

function requiredString(filePath, manifest, fieldName) {
  return typeof manifest[fieldName] === "string" && manifest[fieldName].trim()
    ? []
    : [`${filePath}: missing ${fieldName}`];
}

function validateRepository(filePath, packageDir, repository) {
  if (!repository || typeof repository !== "object") {
    return [`${filePath}: missing repository object`];
  }

  return [
    ...validateFixedString(filePath, repository.type, "repository.type", "git"),
    ...validateFixedString(filePath, repository.url, "repository.url", MONOREPO_URL),
    ...validateFixedString(filePath, repository.directory, "repository.directory", packageDir),
  ];
}

function validateFixedString(filePath, actualValue, fieldName, expectedValue) {
  return actualValue === expectedValue ? [] : [`${filePath}: ${fieldName} must be ${expectedValue}`];
}

function validateLicense(filePath, license) {
  if (typeof license !== "string" || !license.trim() || license === "UNLICENSED") {
    return [`${filePath}: license must be a public package license string`];
  }

  return [];
}

function validateEntrypoints(filePath, manifest, files) {
  if (manifest.exports || manifest.bin || hasHostPluginArtifact(files)) {
    return [];
  }

  return [`${filePath}: publishable packages must declare exports, bin, or a host plugin artifact in files`];
}

function hasHostPluginArtifact(files) {
  if (!Array.isArray(files)) {
    return false;
  }

  return files.some((fileEntry) => {
    return typeof fileEntry === "string" && HOST_PLUGIN_ARTIFACTS.some((artifact) => matchesArtifact(fileEntry, artifact));
  });
}

function matchesArtifact(fileEntry, artifact) {
  return fileEntry === artifact || fileEntry.startsWith(`${artifact}/`);
}

function validateFiles(filePath, files) {
  if (Array.isArray(files) && files.length > 0) {
    return [];
  }

  return [`${filePath}: publishable packages must declare a non-empty files array`];
}

function main() {
  const failures = packageJsonFiles().flatMap(validateManifest);

  if (failures.length > 0) {
    console.error("Package metadata failed:");
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log("Package metadata passed.");
}

main();
