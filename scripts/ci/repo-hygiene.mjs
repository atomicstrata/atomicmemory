/**
 * Public repository hygiene checks for private references and unsafe deps.
 */
import { isTextFile, listRepoFiles, packageJsonFiles, readJson, readText } from "./lib/repo-files.mjs";

const INTERNAL_MARKER = "internal";
const PARTNER_MARKER = "partner";
const USERS_DIR_MARKER = "Users";
const PRIVATE_WORKSPACE_REPO_NAMES = [
  "Atomic" + "mem-extension",
  "Atomic" + "mem-web-sdk",
  "Atomic" + "mem-webapp-sdk",
  "Atomic" + "mem-web-console",
  "Atomic" + "mem-wallet-demos",
  "Atomic" + "gpt",
  "Atomic" + "mem-l1-server",
  "Atomic" + "mem-network-test-extension",
  "Atomic" + "mem-marketing",
  "Atomic" + "memory-research",
  "Atomic" + "memory-docs",
  "Atomic" + "memory-ops",
];
const PRIVATE_REPO_NAMES = [
  "atomicmemory-" + "research",
  "atomicmemory-" + "benchmarks",
  "atomicmemory-" + "docs",
];
const OUTDATED_ORG_URL_PATTERN = new RegExp(
  "\\bgithub\\.com/" + "atomicmemory" + "/atomicmemory(?:-[A-Za-z0-9._-]+)?\\b",
  "i",
);
const KNOWN_NON_PUBLIC_HOSTNAMES = [
  "atomicmem." + "filecoin.cloud",
];
const PRIVATE_REFERENCE_PATTERNS = [
  {
    id: "private-hostname-or-repo",
    pattern: new RegExp(`\\bam-[A-Za-z0-9._-]*-${INTERNAL_MARKER}\\b`, "i"),
  },
  {
    id: "workspace-only-repo-name",
    pattern: new RegExp(`\\b(?:${PRIVATE_WORKSPACE_REPO_NAMES.join("|")})\\b`, "i"),
  },
  {
    id: "private-source-repo-name",
    pattern: new RegExp(`\\b(?:${PRIVATE_REPO_NAMES.join("|")})\\b`, "i"),
  },
  {
    id: "developer-home-path",
    pattern: new RegExp(`\\/${USERS_DIR_MARKER}\\/[A-Za-z][A-Za-z0-9_-]*\\/`),
  },
  {
    id: "outdated-github-org-url",
    pattern: OUTDATED_ORG_URL_PATTERN,
  },
  {
    id: "non-public-hostname",
    pattern: new RegExp(`\\b(?:${KNOWN_NON_PUBLIC_HOSTNAMES.join("|").replaceAll(".", "\\.")})\\b`, "i"),
  },
  {
    id: "private-research-workspace-reference",
    pattern: /\bprivate research workspace\b/i,
  },
  {
    id: "internal-planning-history-reference",
    pattern: /\binternal planning history\b/i,
  },
  {
    id: "partner-demo-reference",
    pattern: new RegExp(`\\b${PARTNER_MARKER} demo\\b`, "i"),
  },
];
const FORBIDDEN_PUBLIC_FILE_PATTERNS = [
  {
    id: "migration-provenance-artifact",
    pattern: /^docs\/migration\//,
  },
  {
    id: "tech-debt-or-cleanup-plan-artifact",
    pattern: /(^|\/)[^/]*(tech-debt|cleanup-plan)[^/]*$/i,
  },
  {
    id: "script-deploy-runbook-artifact",
    pattern: /(^|\/)scripts\/[^/]*DEPLOY[^/]*\.md$/,
  },
];
const DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];
const FORBIDDEN_DEPENDENCY_SPEC_PREFIXES = ["file:", "link:", "workspace:"];

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

function checkForbiddenPublicFiles() {
  return listRepoFiles().flatMap((filePath) => {
    const matched = FORBIDDEN_PUBLIC_FILE_PATTERNS.find((check) => check.pattern.test(filePath));
    return matched ? [`${filePath}: forbidden public artifact ${matched.id}`] : [];
  });
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
  const failures = [
    ...checkPrivateReferences(),
    ...checkForbiddenPublicFiles(),
    ...checkDependencySpecs(),
  ];

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
