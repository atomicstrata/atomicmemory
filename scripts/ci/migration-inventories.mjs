/**
 * Generate and verify source snapshot file inventories from committed history.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { readJson } from "./lib/repo-files.mjs";

const MANIFEST_PATH = "docs/migration/source-snapshot-manifest.json";
const INVENTORY_DIR = "docs/migration/inventories";
const GENERATED_BY = "scripts/ci/migration-inventories.mjs";

function main() {
  const mode = parseMode(process.argv.slice(2));
  const inventories = buildInventories();

  if (mode === "write") {
    writeInventories(inventories);
    return;
  }

  checkInventories(inventories);
}

function parseMode(args) {
  if (args.length === 1 && args[0] === "--write") {
    return "write";
  }

  if (args.length === 1 && args[0] === "--check") {
    return "check";
  }

  throw new Error("Usage: node scripts/ci/migration-inventories.mjs --check|--write");
}

function buildInventories() {
  const manifest = readJson(MANIFEST_PATH);
  return manifest.entries.map(buildInventory);
}

function buildInventory(entry) {
  const commit = resolveCommit(entry.initial_monorepo_commit);
  const files = snapshotFiles(entry, commit);
  return {
    $schema: "../schemas/file-inventory.schema.json",
    description: `File inventory for ${entry.id} source snapshot.`,
    id: entry.id,
    source_repo: entry.source_repo,
    source_ref: entry.source_ref,
    source_commit: entry.source_commit,
    source_subpath: entry.source_subpath ?? null,
    target_path: entry.target_path,
    target_commit: commit,
    allowlist: entry.allowlist,
    copied_on: commitDate(commit),
    copy_tool: `${GENERATED_BY} --write`,
    files,
    summary: summarizeFiles(files),
    verification: verification(entry, files),
  };
}

function snapshotFiles(entry, commit) {
  const allowlist = readJson(entry.allowlist);
  return treeFiles(commit, entry.target_path).map((targetPath) => {
    const relativePath = relativeTargetPath(entry.target_path, targetPath);
    const content = showFile(commit, targetPath);
    return {
      source_path: sourcePath(entry, relativePath),
      target_path: targetPath,
      sha256: sha256(content),
      size_bytes: content.length,
      matched_include: matchedInclude(allowlist, relativePath, entry.id),
    };
  });
}

function treeFiles(commit, targetPath) {
  const output = git(["ls-tree", "-r", "-z", "--full-tree", commit, "--", targetPath], "utf8");
  return output.split("\0").filter(Boolean).map((entry) => {
    return entry.slice(entry.indexOf("\t") + 1);
  });
}

function showFile(commit, filePath) {
  return git(["show", `${commit}:${filePath}`], null);
}

function relativeTargetPath(targetRoot, filePath) {
  const prefix = `${targetRoot}/`;
  if (!filePath.startsWith(prefix)) {
    throw new Error(`${filePath}: not under target root ${targetRoot}`);
  }

  return filePath.slice(prefix.length);
}

function sourcePath(entry, relativePath) {
  return entry.source_subpath ? `${entry.source_subpath}/${relativePath}` : relativePath;
}

function matchedInclude(allowlist, relativePath, id) {
  const matched = allowlist.included_paths.find((pattern) => matchesGlob(pattern, relativePath));
  if (!matched) {
    throw new Error(`${id}: ${relativePath} is not matched by any included_paths entry`);
  }

  return matched;
}

function matchesGlob(pattern, relativePath) {
  return new RegExp(`^${globToRegex(pattern)}$`).test(relativePath);
}

function globToRegex(pattern) {
  let regex = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*" && pattern[index + 1] === "*") {
      regex += ".*";
      index += 1;
    } else if (char === "*") {
      regex += "[^/]*";
    } else {
      regex += escapeRegex(char);
    }
  }

  return regex;
}

function escapeRegex(char) {
  return /[\\^$+?.()|[\]{}]/.test(char) ? `\\${char}` : char;
}

function summarizeFiles(files) {
  return {
    file_count: files.length,
    total_size_bytes: files.reduce((total, file) => total + file.size_bytes, 0),
  };
}

function verification(entry, files) {
  return {
    allowlist_checked: true,
    inventory_source: "git tree at target_commit",
    reviewer_signoff: "pending CODEOWNERS review",
    note: `${files.length} files matched against ${entry.allowlist}.`,
  };
}

function writeInventories(inventories) {
  mkdirSync(INVENTORY_DIR, { recursive: true });
  for (const inventory of inventories) {
    const outputPath = inventoryPath(inventory.id);
    writeFileSync(outputPath, `${JSON.stringify(inventory, null, 2)}\n`);
    console.log(`wrote ${outputPath}`);
  }
}

function checkInventories(expectedInventories) {
  const failures = expectedInventories.flatMap((expected) => {
    return inventoryFailures(expected);
  });

  if (failures.length > 0) {
    console.error("Migration inventory validation failed:");
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`Migration inventories passed for ${expectedInventories.length} snapshots.`);
}

function inventoryFailures(expected) {
  const outputPath = inventoryPath(expected.id);
  let actualText;
  try {
    actualText = readFileSync(outputPath, "utf8");
  } catch {
    return [`${outputPath}: missing; run ${GENERATED_BY} --write`];
  }

  const expectedText = `${JSON.stringify(expected, null, 2)}\n`;
  return actualText === expectedText ? [] : [`${outputPath}: out of date; run ${GENERATED_BY} --write`];
}

function inventoryPath(id) {
  return `${INVENTORY_DIR}/${id}.json`;
}

function resolveCommit(ref) {
  return git(["rev-parse", ref], "utf8").trim();
}

function commitDate(commit) {
  return git(["show", "-s", "--format=%cI", commit], "utf8").trim();
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function git(args, encoding) {
  const result = spawnSync("git", args, {
    encoding,
    maxBuffer: 1024 * 1024 * 200,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr?.toString().trim() || `git ${args.join(" ")} failed`);
  }

  return result.stdout;
}

main();
