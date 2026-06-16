/**
 * Unit coverage for the public-push guard.
 *
 * The guard accepts an injectable env so the override can be simulated
 * without setting real environment variables, and a remote URL so every
 * remote shape can be exercised without touching git.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { enforce, normalizeGithubSlug } from "../guard-public-push.mjs";

const NO_OVERRIDE = {};

test("blocks ssh push to the public mirror", () => {
  assert.throws(
    () => enforce({ remoteUrl: "git@github.com:atomicstrata/atomicmemory.git", env: NO_OVERRIDE }),
    /refusing to push to the public mirror/,
  );
});

test("blocks https push to the public mirror", () => {
  assert.throws(
    () => enforce({ remoteUrl: "https://github.com/atomicstrata/atomicmemory", env: NO_OVERRIDE }),
    /public mirror/,
  );
});

test("allows push to the canonical source repo (origin)", () => {
  assert.doesNotThrow(() =>
    enforce({ remoteUrl: "git@github.com:atomicstrata/atomicmemory-source.git", env: NO_OVERRIDE }),
  );
});

test("does not confuse a source repo whose name extends the public slug", () => {
  assert.equal(
    normalizeGithubSlug("git@github.com:atomicstrata/atomicmemory-source.git"),
    "atomicstrata/atomicmemory-source",
  );
});

test("allows push to an unrelated remote", () => {
  assert.doesNotThrow(() =>
    enforce({ remoteUrl: "git@github.com:someone/other-repo.git", env: NO_OVERRIDE }),
  );
});

test("override lets the publish tooling push to the public mirror", () => {
  assert.doesNotThrow(() =>
    enforce({
      remoteUrl: "git@github.com:atomicstrata/atomicmemory.git",
      env: { ALLOW_PUBLIC_ATOMICMEMORY_PUSH: "1" },
    }),
  );
});

test("normalizes ssh, https, and ssh:// remote shapes to owner/repo", () => {
  assert.equal(normalizeGithubSlug("git@github.com:atomicstrata/atomicmemory.git"), "atomicstrata/atomicmemory");
  assert.equal(normalizeGithubSlug("https://github.com/atomicstrata/atomicmemory.git"), "atomicstrata/atomicmemory");
  assert.equal(normalizeGithubSlug("ssh://git@github.com/atomicstrata/atomicmemory"), "atomicstrata/atomicmemory");
});

test("returns null for empty or non-git remote strings", () => {
  assert.equal(normalizeGithubSlug(""), null);
  assert.equal(normalizeGithubSlug(undefined), null);
  assert.equal(normalizeGithubSlug("not-a-url"), null);
});
