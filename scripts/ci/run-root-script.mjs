/**
 * Run a required root pnpm script once the monorepo root package exists.
 */
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { readJson } from "./lib/repo-files.mjs";

const ROOT_PACKAGE = "package.json";
const TURBO_SCRIPT_PREFIX = "ci:";

function main() {
  const scriptName = process.argv[2];
  if (!scriptName) {
    throw new Error("Usage: node scripts/ci/run-root-script.mjs <script-name>");
  }

  if (!existsSync(ROOT_PACKAGE)) {
    console.log(`::notice::No root package.json yet; skipped ${scriptName}.`);
    return;
  }

  const scriptCommand = readRootScript(scriptName);
  validateTurboScript(scriptName, scriptCommand);
  runPnpmScript(scriptName);
}

function readRootScript(scriptName) {
  const manifest = readJson(ROOT_PACKAGE);
  const scriptCommand = manifest.scripts?.[scriptName];
  if (typeof scriptCommand !== "string" || !scriptCommand.trim()) {
    throw new Error(`Root package.json must define scripts.${scriptName}.`);
  }

  return scriptCommand;
}

function validateTurboScript(scriptName, scriptCommand) {
  if (scriptName.startsWith(TURBO_SCRIPT_PREFIX) && !scriptCommand.includes("turbo run")) {
    throw new Error(`Root script ${scriptName} must call turbo run.`);
  }
}

function runPnpmScript(scriptName) {
  const result = spawnSync("pnpm", ["run", scriptName], { stdio: "inherit" });
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
  }
}

main();
