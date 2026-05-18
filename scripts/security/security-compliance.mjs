/**
 * Public security and compliance checks for CI-safe repository boundaries.
 */
import { isTextFile, listRepoFiles, packageJsonFiles, readJson, readText } from "../ci/lib/repo-files.mjs";

const SECRET_PATTERNS = [
  { id: "aws-access-key", pattern: /AKIA[0-9A-Z]{16}/ },
  { id: "github-token", pattern: /\bgh[opsu]_[A-Za-z0-9_]{30,}\b/ },
  { id: "npm-token", pattern: /\bnpm_[A-Za-z0-9]{30,}\b/ },
  { id: "openai-token", pattern: /\bsk-[A-Za-z0-9]{48,}\b/ },
  { id: "private-key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
];
const WORKFLOW_PATH_PATTERN = /^\.github\/workflows\/.+\.ya?ml$/;
const ACTION_REF_PATTERN = /^\s*uses:\s*([^@\s]+)@([^\s#]+)/;
const OFFICIAL_ACTION_OWNER = "actions/";
const FULL_SHA_PATTERN = /^[a-f0-9]{40}$/;
const MAJOR_VERSION_PATTERN = /^v[0-9]+$/;
const DISALLOWED_LICENSES = new Set(["UNLICENSED", "SEE LICENSE IN LICENSE"]);

function checkSecrets() {
  const failures = [];

  for (const filePath of listRepoFiles().filter(isTextFile)) {
    const text = readText(filePath);
    for (const secretPattern of SECRET_PATTERNS) {
      if (secretPattern.pattern.test(text)) {
        failures.push(`${filePath}: possible ${secretPattern.id}`);
      }
    }
  }

  return failures;
}

function checkWorkflowPolicies() {
  return listRepoFiles()
    .filter((filePath) => WORKFLOW_PATH_PATTERN.test(filePath))
    .flatMap(validateWorkflowFile);
}

function validateWorkflowFile(filePath) {
  const lines = readText(filePath).split(/\r?\n/);
  return [
    ...validateWorkflowPermissions(filePath, lines),
    ...validateWorkflowActions(filePath, lines),
  ];
}

function validateWorkflowPermissions(filePath, lines) {
  return lines.flatMap((line, index) => {
    const normalized = line.trim();
    if (normalized === "permissions: write-all" || normalized === "contents: write") {
      return [`${filePath}:${index + 1}: workflow must not request ${normalized}`];
    }

    return [];
  });
}

function validateWorkflowActions(filePath, lines) {
  return lines.flatMap((line, index) => {
    const match = line.match(ACTION_REF_PATTERN);
    return match ? validateActionRef(filePath, index + 1, match[1], match[2]) : [];
  });
}

function validateActionRef(filePath, lineNumber, actionName, ref) {
  const allowedOfficialMajor = actionName.startsWith(OFFICIAL_ACTION_OWNER) && MAJOR_VERSION_PATTERN.test(ref);
  if (FULL_SHA_PATTERN.test(ref) || allowedOfficialMajor) {
    return [];
  }

  return [`${filePath}:${lineNumber}: ${actionName} must be pinned to a full SHA or approved official major`];
}

function checkPackageLicenses() {
  return packageJsonFiles().flatMap((filePath) => {
    const manifest = readJson(filePath);
    if (manifest.private === true || filePath === "package.json") {
      return [];
    }

    return DISALLOWED_LICENSES.has(manifest.license)
      ? [`${filePath}: license ${manifest.license} is not publishable`]
      : [];
  });
}

function main() {
  const failures = [...checkSecrets(), ...checkWorkflowPolicies(), ...checkPackageLicenses()];

  if (failures.length > 0) {
    console.error("Security compliance failed:");
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log("Security compliance passed.");
}

main();
