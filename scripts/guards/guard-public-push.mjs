#!/usr/bin/env node
/**
 * Refuse a local `git push` whose destination is the public AtomicMemory
 * mirror (`atomicstrata/atomicmemory`).
 *
 * This is a read-only release surface, updated only by the release-sync
 * tooling, which opens a sanitized pull request. Nobody should push to it
 * directly — not from a mirror clone, and not via a clone's `upstream` remote.
 * This guard runs as the repo's `pre-push` hook (installed by
 * `scripts/git-hooks/install-hooks.mjs` on `pnpm install`) and blocks exactly
 * that.
 *
 * It is an accidental-push guard, not a security boundary — the real boundary
 * is public branch protection. The release-sync tooling sets
 * `ALLOW_PUBLIC_ATOMICMEMORY_PUSH=1` so its own push is not blocked.
 *
 * See the release-process documentation for the full flow.
 */

const PUBLIC_SLUG = "atomicstrata/atomicmemory";
const OVERRIDE_ENV = "ALLOW_PUBLIC_ATOMICMEMORY_PUSH";

if (process.argv[1] && process.argv[1].endsWith("guard-public-push.mjs")) main();

function main() {
  // git invokes pre-push as: <hook> <remote-name> <remote-url>
  const remoteName = process.argv[2] ?? "";
  const remoteUrl = process.argv[3] ?? "";
  try {
    enforce({ remoteUrl, env: process.env });
  } catch (error) {
    console.error(`guard-public-push: ${error instanceof Error ? error.message : error}`);
    console.error(
      `  remote: ${remoteName || "<unknown>"} -> ${remoteUrl || "<unknown>"}`,
    );
    console.error("  Update the release mirror via the release-sync tooling, not a direct push.");
    console.error("  See the release-process documentation.");
    console.error(`  Override (rarely correct): ${OVERRIDE_ENV}=1 git push ...`);
    process.exit(1);
  }
}

/**
 * Throw when `remoteUrl` resolves to the public mirror and the override is not
 * set. Pure and side-effect free so it can be unit-tested directly.
 */
export function enforce({ remoteUrl, env }) {
  if (env?.[OVERRIDE_ENV] === "1") return;
  if (normalizeGithubSlug(remoteUrl) === PUBLIC_SLUG) {
    throw new Error(`refusing to push to the public mirror (${PUBLIC_SLUG}).`);
  }
}

/**
 * Reduce a GitHub remote URL to its `owner/repo` slug (without a trailing
 * `.git`). Returns null for anything that is not a recognizable GitHub remote.
 * Handles `git@host:owner/repo(.git)`, `https://host/owner/repo(.git)`, and
 * `ssh://git@host/owner/repo(.git)`.
 */
export function normalizeGithubSlug(remoteUrl) {
  if (typeof remoteUrl !== "string" || remoteUrl.length === 0) return null;
  let path = remoteUrl.trim();
  const scp = path.match(/^[^@]+@[^:]+:(.+)$/); // git@github.com:owner/repo.git
  if (scp) {
    path = scp[1];
  } else {
    const url = path.match(/^[a-z]+:\/\/[^/]+\/(.+)$/i); // https://github.com/owner/repo.git
    if (url) path = url[1];
    else return null;
  }
  path = path.replace(/\.git$/, "").replace(/\/+$/, "");
  const parts = path.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}
