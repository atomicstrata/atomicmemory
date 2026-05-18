/**
 * Shared repository file helpers for public CI checks.
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const TEXT_FILE_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".py",
  ".sh",
  ".sql",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);

export function listRepoFiles() {
  const result = spawnSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { encoding: "utf8" },
  );

  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "Unable to list repository files.");
  }

  return result.stdout.split("\0").filter(Boolean);
}

export function readJson(filePath) {
  try {
    return JSON.parse(readText(filePath));
  } catch (error) {
    throw new Error(`${filePath}: invalid JSON: ${error.message}`);
  }
}

export function readText(filePath) {
  return readFileSync(filePath, "utf8");
}

export function isTextFile(filePath) {
  const lowerPath = filePath.toLowerCase();
  for (const extension of TEXT_FILE_EXTENSIONS) {
    if (lowerPath.endsWith(extension)) {
      return true;
    }
  }

  return false;
}

export function packageJsonFiles() {
  return listRepoFiles().filter((filePath) => {
    return filePath === "package.json" || filePath.endsWith("/package.json");
  });
}
