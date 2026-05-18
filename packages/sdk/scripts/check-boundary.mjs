/**
 * Verify the SDK stays independent from application-layer modules.
 *
 * The SDK is the portable memory layer. It must not import user-account,
 * web-SDK, consent, settings, knowledge-base, or request-context modules from
 * product applications. This script scans tracked source files only so
 * generated output and dependency folders cannot create false positives.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".d.ts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

const FORBIDDEN_IMPORT = /(from|import\(|require\()\s*['"][^'"]*\/(user-accounts|web-sdk|consent|settings|knowledge-base|context)[/'"]/;

function main() {
  const root = repoRoot();
  const files = trackedFiles(root).filter(isScannableSource);
  const matches = files.flatMap((filePath) => forbiddenMatches(root, filePath));

  if (matches.length > 0) {
    console.error("Application-layer paths are forbidden in the memory-layer SDK:");
    for (const match of matches) {
      console.error(match);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`SDK boundary check passed for ${files.length} tracked source files.`);
}

function trackedFiles(root) {
  const result = spawnSync("git", ["ls-files"], {
    encoding: "utf8",
    cwd: root,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "git ls-files failed");
  }

  return result.stdout.split("\n").filter(Boolean).filter((filePath) => {
    return filePath.startsWith("packages/sdk/");
  });
}

function repoRoot() {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "git rev-parse --show-toplevel failed");
  }

  return result.stdout.trim();
}

function isScannableSource(filePath) {
  return [...SOURCE_EXTENSIONS].some((extension) => filePath.endsWith(extension));
}

function forbiddenMatches(root, filePath) {
  return readFileSync(join(root, filePath), "utf8").split("\n").flatMap((line, index) => {
    if (!FORBIDDEN_IMPORT.test(line)) {
      return [];
    }

    return `${relative("packages/sdk", filePath)}:${index + 1}:${line}`;
  });
}

main();
