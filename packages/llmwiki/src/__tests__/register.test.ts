/**
 * Tests for the light lazy-registration surface in `../register.ts`.
 *
 * Covers:
 * - `liveLlmwikiLazyEntry`: factory construction and round-trip ingest/get
 * - `mapCompilerLoadError`: correct wrapping for the llm-wiki-compiler peer,
 *   non-wrapping for unrelated missing modules, and quoted-exact-match semantics
 *   (adversarial substring case)
 * - `LLMWIKI_COMPILER_PEER_RANGE`: drift check against package.json peerDependencies
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { liveLlmwikiLazyEntry } from "../register.ts";
import { mapCompilerLoadError, LLMWIKI_COMPILER_PEER_RANGE } from "../register-internals.ts";
import { LLMWikiBridgeError, E_LLMWIKI_COMPILER_MISSING } from "../errors.ts";

describe("liveLlmwikiLazyEntry", () => {
  it("returns a factory that constructs a working live provider on invocation", async () => {
    const factory = liveLlmwikiLazyEntry();
    assert.equal(typeof factory, "function");
    const root = await mkdtemp(path.join(tmpdir(), "register-"));
    const scope = { user: "u1" };
    const { provider } = await factory({ root, scope, projectId: "proj-1" });
    // round-trip a real source op to prove the dynamically-imported provider works
    // (ingest/get shapes mirror live-provider.test.ts; use a comfortably long body)
    const content = "This is a comfortably long body of source text used to exercise the live llmwiki provider through the lazy registration factory.";
    const r = await provider.ingest({ mode: "text", content, scope, metadata: { title: "Note" } });
    assert.ok(r.created.length > 0, "expected at least one created id");
    const id = r.created[0] as string;
    const got = await provider.get({ id, scope });
    assert.ok(got);
  });
});

describe("mapCompilerLoadError", () => {
  it("wraps a missing llm-wiki-compiler as E_LLMWIKI_COMPILER_MISSING", () => {
    const err = Object.assign(new Error("Cannot find package 'llm-wiki-compiler' imported from /x/live/provider.js"), { code: "ERR_MODULE_NOT_FOUND" });
    const mapped = mapCompilerLoadError(err);
    assert.ok(mapped instanceof LLMWikiBridgeError);
    assert.equal(mapped?.code, E_LLMWIKI_COMPILER_MISSING);
  });
  it("does NOT wrap an unrelated missing module (caller rethrows the original)", () => {
    const err = Object.assign(new Error("Cannot find package 'some-other-dep' imported from /x/live/provider.js"), { code: "ERR_MODULE_NOT_FOUND" });
    assert.equal(mapCompilerLoadError(err), undefined);
  });
  it("returns undefined for non-module-not-found errors", () => {
    assert.equal(mapCompilerLoadError(new Error("boom")), undefined);
  });
  it("ignores a REAL Node ERR_MODULE_NOT_FOUND for an unrelated specifier", async () => {
    // Deliberately adversarial: the specifier CONTAINS "llm-wiki-compiler" as a
    // hyphen-prefixed substring. The quoted-exact match ('llm-wiki-compiler') must
    // not wrap it; a \b-based match would (hyphens are non-word chars → \b matches).
    let realErr: unknown;
    // @ts-expect-error intentionally unresolvable
    try { await import("llm-wiki-compiler-definitely-not-installed-xyz"); } catch (e) { realErr = e; }
    assert.equal((realErr as NodeJS.ErrnoException)?.code, "ERR_MODULE_NOT_FOUND");
    assert.equal(mapCompilerLoadError(realErr), undefined);
  });
});

describe("LLMWIKI_COMPILER_PEER_RANGE", () => {
  it("matches the declared peerDependencies range in package.json (no drift)", async () => {
    const { readFile } = await import("node:fs/promises");
    const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf-8"));
    assert.equal(LLMWIKI_COMPILER_PEER_RANGE, pkg.peerDependencies["llm-wiki-compiler"]);
  });
});

describe("LLMWIKI_COMPILER_PEER_RANGE — SDK peer floor", () => {
  it("requires an @atomicmemory/sdk that awaits async registry factories (floor >= 1.1.0)", async () => {
    const { readFile } = await import("node:fs/promises");
    const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf-8"));
    const range = pkg.peerDependencies["@atomicmemory/sdk"] as string;
    const floor = range.match(/(\d+)\.(\d+)\.(\d+)/);
    assert.ok(floor, `cannot parse SDK peer range: ${range}`);
    const [major, minor] = [Number(floor[1]), Number(floor[2])];
    // SDK 1.1.0 introduced awaited async registry factories; older SDKs would
    // store the lazy factory's Promise as the provider.
    assert.ok(major > 1 || (major === 1 && minor >= 1), `SDK peer floor must be >= 1.1.0, got ${range}`);
  });
});
