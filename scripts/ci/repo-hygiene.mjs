/**
 * Public repository hygiene checks for private references and unsafe deps.
 */
import { isTextFile, listRepoFiles, packageJsonFiles, readJson, readText } from "./lib/repo-files.mjs";

const INTERNAL_MARKER = "internal";
const WORKSPACE_REPO_PREFIX = "Atomic" + "memory-";
const PRIVATE_REFERENCE_PATTERNS = [
  {
    id: "private-hostname-or-repo",
    pattern: new RegExp(`\\bam-[A-Za-z0-9._-]*-${INTERNAL_MARKER}\\b`, "i"),
  },
  {
    id: "workspace-only-repo-name",
    pattern: new RegExp(`\\b${WORKSPACE_REPO_PREFIX}[A-Za-z0-9._-]+\\b`),
  },
];
const DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];
const FORBIDDEN_DEPENDENCY_SPEC_PREFIXES = ["file:", "link:"];

function checkPrivateReferences() {
  const failures = [];

  for (const filePath of listRepoFiles().filter(isTextFile)) {
    const text = readText(filePath);
    for (const check of PRIVATE_REFERENCE_PATTERNS) {
      if (check.pattern.test(text)) {
        failures.push(`${filePath}: contains ${check.id}`);
      }
    }
  }

  return failures;
}

function checkDependencySpecs() {
  const failures = [];

  for (const filePath of packageJsonFiles()) {
    const manifest = readJson(filePath);
    for (const section of DEPENDENCY_SECTIONS) {
      failures.push(...forbiddenDependencySpecs(filePath, section, manifest[section]));
    }
  }

  return failures;
}

function forbiddenDependencySpecs(filePath, section, dependencies) {
  if (!dependencies || typeof dependencies !== "object") {
    return [];
  }

  return Object.entries(dependencies).flatMap(([name, spec]) => {
    if (typeof spec !== "string") {
      return [`${filePath}: ${section}.${name} must be a string dependency spec`];
    }

    const forbiddenPrefix = FORBIDDEN_DEPENDENCY_SPEC_PREFIXES.find((prefix) => spec.startsWith(prefix));
    return forbiddenPrefix ? [`${filePath}: ${section}.${name} uses forbidden ${forbiddenPrefix} spec`] : [];
  });
}

function main() {
  const failures = [...checkPrivateReferences(), ...checkDependencySpecs()];

  if (failures.length > 0) {
    console.error("Repo hygiene failed:");
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log("Repo hygiene passed.");
}

main();
