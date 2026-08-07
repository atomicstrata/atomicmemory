/**
 * Public security and compliance checks for CI-safe repository boundaries.
 */
import { parse as parseYaml } from "yaml";
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
const RELEASE_CLI_WORKFLOW = ".github/workflows/release-cli.yml";
const INTERNAL_CLI_WORKFLOW = ".github/workflows/internal-cli-release.yml";
const MIRROR_CLI_WORKFLOW = ".github/workflows/mirror-cli-r2.yml";
const PUBLISH_PACKAGES_WORKFLOW = ".github/workflows/publish-packages.yml";
const PUBLISH_CORE_DOCKER_WORKFLOW = ".github/workflows/publish-core-docker.yml";
const INTERNAL_CORE_DOCKER_WORKFLOW = ".github/workflows/internal-core-docker-image.yml";
const RELEASE_PUBLISH_JOB = "publish";
const READ_ONLY_WORKFLOW_PERMISSIONS = { contents: "read" };
const RELEASE_PUBLISH_PERMISSIONS = {
  contents: "write",
  "id-token": "write",
  attestations: "write",
};
const INTERNAL_CLI_PUBLISH_PERMISSIONS = {
  contents: "write",
};
const NPM_TRUSTED_PUBLISH_PERMISSIONS = {
  contents: "read",
  "id-token": "write",
};
const GHCR_PUBLISH_PERMISSIONS = {
  contents: "read",
  packages: "write",
};
const DOCKER_PUBLISH_WORKFLOW_PERMISSIONS = GHCR_PUBLISH_PERMISSIONS;

// Single data-driven allow-table for every workflow that legitimately holds
// write scopes. Anything not listed here must be read-only at both the
// workflow and job level; the YAML parser is the one universal chokepoint so
// spelling bypasses (double spaces, quoted values, trailing comments,
// flow-style maps) cannot slip past a line-grep.
//
// Entries must name every job that is allowed to hold write permissions.
// Any other job in the same workflow is enforced read-only (empty perms map,
// or inheritance from workflow-level, is permitted).
const RELEASE_LANE_ALLOW_TABLE = new Map([
  [
    RELEASE_CLI_WORKFLOW,
    {
      workflow: READ_ONLY_WORKFLOW_PERMISSIONS,
      jobs: { [RELEASE_PUBLISH_JOB]: RELEASE_PUBLISH_PERMISSIONS },
    },
  ],
  [
    INTERNAL_CLI_WORKFLOW,
    {
      workflow: READ_ONLY_WORKFLOW_PERMISSIONS,
      jobs: { [RELEASE_PUBLISH_JOB]: INTERNAL_CLI_PUBLISH_PERMISSIONS },
    },
  ],
  [
    PUBLISH_PACKAGES_WORKFLOW,
    {
      workflow: READ_ONLY_WORKFLOW_PERMISSIONS,
      jobs: {
        "publish-npm": NPM_TRUSTED_PUBLISH_PERMISSIONS,
        "publish-core-docker": GHCR_PUBLISH_PERMISSIONS,
      },
    },
  ],
  [
    PUBLISH_CORE_DOCKER_WORKFLOW,
    {
      workflow: DOCKER_PUBLISH_WORKFLOW_PERMISSIONS,
      jobs: {},
    },
  ],
  [
    INTERNAL_CORE_DOCKER_WORKFLOW,
    {
      workflow: DOCKER_PUBLISH_WORKFLOW_PERMISSIONS,
      jobs: {},
    },
  ],
]);

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
  const text = readText(filePath);
  const lines = text.split(/\r?\n/);
  return [
    ...validateWorkflowPermissions(filePath, text),
    ...validateMirrorCliPromotionGuard(filePath, text),
    ...validateWorkflowActions(filePath, lines),
  ];
}

function workflowSourceText(source) {
  return Array.isArray(source) ? source.join("\n") : source;
}

function permissionMap(permissions) {
  if (permissions === "write-all") {
    return new Map([["write-all", "write-all"]]);
  }
  if (permissions === "read-all") {
    return new Map([["read-all", "read-all"]]);
  }
  if (!permissions || typeof permissions !== "object") {
    return new Map();
  }
  return new Map(Object.entries(permissions).map(([key, value]) => [key, String(value)]));
}

function mapsEqual(left, right) {
  const leftKeys = [...left.keys()].sort();
  const rightKeys = [...right.keys()].sort();
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  return leftKeys.every((key, index) => {
    return key === rightKeys[index] && left.get(key) === right.get(key);
  });
}

function hasAnyWritePermission(permsMap) {
  if (permsMap.has("write-all")) {
    return true;
  }
  for (const level of permsMap.values()) {
    if (String(level).trim() === "write") {
      return true;
    }
  }
  return false;
}

function formatExpectedPermissions(perms) {
  return Object.entries(perms)
    .map(([key, value]) => `${key}: ${value}`)
    .join(", ");
}

/**
 * Validate workflow-level and per-job permissions against the release-lane
 * allow-table. Every workflow flows through this parseYaml-based check;
 * exemptions live in the allow-table only. Adding a new release lane requires
 * a table entry plus a negative test in security-compliance.test.mjs.
 */
export function validateWorkflowPermissions(filePath, source) {
  const doc = parseWorkflowDocument(filePath, source);
  if (!doc) {
    return [`${filePath}: workflow yaml did not parse to an object`];
  }

  const allow = RELEASE_LANE_ALLOW_TABLE.get(filePath);
  const failures = [];

  const workflowPerms = permissionMap(doc.permissions);
  if (allow) {
    const expected = permissionMap(allow.workflow);
    if (!mapsEqual(workflowPerms, expected)) {
      failures.push(
        `${filePath}: workflow permissions must be exactly ${formatExpectedPermissions(allow.workflow)}`,
      );
    }
  } else if (hasAnyWritePermission(workflowPerms)) {
    failures.push(`${filePath}: workflow must not request write permissions`);
  }

  for (const [jobName, job] of Object.entries(doc.jobs ?? {})) {
    failures.push(...validateJobPermissions(filePath, jobName, job, allow));
  }

  return failures;
}

function validateJobPermissions(filePath, jobName, job, allow) {
  const jobPerms = permissionMap(job?.permissions);
  const jobAllow = allow?.jobs?.[jobName];
  if (jobAllow) {
    const expected = permissionMap(jobAllow);
    if (mapsEqual(jobPerms, expected)) {
      return [];
    }
    return [
      `${filePath}: job ${jobName} must request exactly ${formatExpectedPermissions(jobAllow)}`,
    ];
  }
  if (hasAnyWritePermission(jobPerms)) {
    return [`${filePath}: job ${jobName} must not request write permissions`];
  }
  return [];
}

function parseWorkflowDocument(filePath, source) {
  try {
    const doc = parseYaml(workflowSourceText(source));
    if (!doc || typeof doc !== "object") {
      return null;
    }
    return doc;
  } catch (error) {
    throw new Error(`${filePath}: invalid workflow yaml: ${error.message}`);
  }
}

/**
 * mirror-cli-r2.yml must not let an older workflow_dispatch version replace
 * the mutable root install.sh/version.json pointers after a newer release.
 */
export function validateMirrorCliPromotionGuard(filePath, source) {
  if (filePath !== MIRROR_CLI_WORKFLOW) {
    return [];
  }

  const text = workflowSourceText(source);
  const required = [
    /VERSION:\s*\$\{\{\s*steps\.rel\.outputs\.version\s*\}\}/,
    /semver_ge\(\)/,
    /aws s3api head-object/,
    /--key version\.json/,
    /semver_ge "\$ver" "\$current_ver"/,
    /refusing to promote \$\{ver\}: older than current \$\{current_ver\}/,
    /failed to read current version\.json \(not a 404\); refusing to promote/,
  ];

  if (required.every((pattern) => pattern.test(text))) {
    return [];
  }

  return [`${filePath}: must compare requested version against current version.json before promoting latest`];
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

if (process.argv[1]?.endsWith("security-compliance.mjs")) {
  main();
}
