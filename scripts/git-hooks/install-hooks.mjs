#!/usr/bin/env node
/**
 * Install the repo's committed git hooks into the active hooks directory.
 *
 * Wired as the root `prepare` script, so `pnpm install` keeps every
 * contributor's clone guarded without adding a hook-manager dependency.
 * Hooks live in `scripts/git-hooks/` and are copied into the directory git
 * reports via `git rev-parse --git-path hooks`, which is worktree-correct
 * (each linked worktree resolves to the shared common hooks dir).
 *
 * This is dev tooling, not runtime app code: if it cannot find a git hooks
 * directory (for example, install from a tarball with no `.git`), it warns
 * and exits 0 rather than failing the whole install. It never silently
 * overwrites a pre-existing hook it did not author.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOOKS = ["pre-push"];
const MARKER = "AtomicMemory pre-push guard";
const sourceDir = dirname(fileURLToPath(import.meta.url));

main();

function main() {
  const hooksDir = resolveHooksDir();
  if (!hooksDir) {
    console.warn("install-hooks: no git hooks directory found; skipping (not a git checkout?).");
    return;
  }
  mkdirSync(hooksDir, { recursive: true });
  for (const hook of HOOKS) installOne(hooksDir, hook);
}

function resolveHooksDir() {
  const result = spawnSync("git", ["rev-parse", "--git-path", "hooks"], { encoding: "utf8" });
  if (result.status !== 0) return null;
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  const base = top.status === 0 ? top.stdout.trim() : process.cwd();
  const reported = result.stdout.trim();
  return reported.startsWith("/") ? reported : join(base, reported);
}

function installOne(hooksDir, hook) {
  const src = join(sourceDir, hook);
  const dest = join(hooksDir, hook);
  if (existsSync(dest) && !readFileSync(dest, "utf8").includes(MARKER)) {
    console.warn(`install-hooks: ${dest} exists and is not ours; leaving it untouched.`);
    return;
  }
  copyFileSync(src, dest);
  chmodSync(dest, 0o755);
  console.log(`install-hooks: installed ${hook} -> ${dest}`);
}
