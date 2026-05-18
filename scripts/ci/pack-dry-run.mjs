/**
 * Run npm pack dry-runs for publishable workspace package manifests.
 */
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { packageJsonFiles, readJson } from "./lib/repo-files.mjs";

const PUBLISHABLE_ROOTS = ["packages/", "adapters/", "plugins/"];

function isPublishablePackage(filePath, manifest) {
  return manifest.private !== true && PUBLISHABLE_ROOTS.some((root) => filePath.startsWith(root));
}

function publishablePackageDirs() {
  return packageJsonFiles().flatMap((filePath) => {
    const manifest = readJson(filePath);
    return isPublishablePackage(filePath, manifest) ? [dirname(filePath)] : [];
  });
}

function runPackDryRun(packageDir) {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: packageDir,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    return [`${packageDir}: npm pack --dry-run failed: ${result.stderr.trim()}`];
  }

  return validatePackOutput(packageDir, result.stdout);
}

function validatePackOutput(packageDir, output) {
  try {
    const packEntries = JSON.parse(output);
    const fileCount = packEntries?.[0]?.files?.length ?? 0;
    return fileCount > 0 ? [] : [`${packageDir}: npm pack dry-run reported no packed files`];
  } catch (error) {
    return [`${packageDir}: npm pack dry-run did not emit valid JSON: ${error.message}`];
  }
}

function main() {
  const packageDirs = publishablePackageDirs();
  const failures = packageDirs.flatMap(runPackDryRun);

  if (failures.length > 0) {
    console.error("Pack dry-run failed:");
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`Pack dry-run passed for ${packageDirs.length} publishable packages.`);
}

main();
