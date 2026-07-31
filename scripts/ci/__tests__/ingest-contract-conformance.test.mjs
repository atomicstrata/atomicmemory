/**
 * @file Tests for the ingest contract conformance check.
 *
 * The check exists because a per-surface fix silently missed a surface: the
 * plugin family moved to 0.2.0 for Core's raw-content policy, Hermes was fixed,
 * and OpenClaw shipped with updated docs but an unchanged tool schema that
 * rejected the parameter its own instructions told the agent to send.
 *
 * A guard nobody has watched fail is worth nothing, so each case below is the
 * failure it is supposed to catch.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { evaluate, familyMembers, stripComments, SURFACES } from "../../check-ingest-contract-conformance.mjs";

const CONTRACT_OK = { $defs: { VerbatimIngest: { properties: { content_class: {} } } } };

const surface = (over = {}) => ({
  id: "openclaw",
  kind: "declares",
  file: "plugins/openclaw/src/index.ts",
  why: "owns a closed tool schema",
  verify: (text) => (/contentClass/.test(text) ? null : "does not declare contentClass"),
  ...over,
});

const run = (over = {}) =>
  evaluate({
    surfaces: [surface()],
    family: { members: ["openclaw"], unmapped: [] },
    contract: CONTRACT_OK,
    readFile: () => "contentClass: enumSchema(['summary'])",
    exists: () => true,
    ...over,
  });

test("passes when the surface declares the property", () => {
  assert.deepEqual(run(), []);
});

test("fails when a declaring surface omits the property (the OpenClaw bug)", () => {
  const problems = run({ readFile: () => "mode: enumSchema(['verbatim'])" });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /does not declare contentClass/);
});

test("fails when a stamping surface omits the field", () => {
  const problems = evaluate({
    surfaces: [
      surface({
        id: "claude-code",
        kind: "stamps",
        file: "lib.sh",
        verify: (t) => (/content_class/.test(t) ? null : "does not stamp content_class"),
      }),
    ],
    family: { members: ["claude-code"], unmapped: [] },
    contract: CONTRACT_OK,
    readFile: () => 'jq -n --arg u "$U" \'{user_id: $u}\'',
    exists: () => true,
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /does not stamp content_class/);
});

test("a missing file is unverified, never satisfied", () => {
  // The dangerous shape: a moved file must not let the check quietly stop
  // covering that surface while still reporting success.
  const problems = run({ exists: () => false });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /not found; conformance is unverified/);
});

test("a new family member with no conformance entry fails", () => {
  // This is the case that would have caught OpenClaw: the family grew, and
  // nothing forced the new member to be classified.
  const problems = run({ family: { members: ["openclaw", "brandnew"], unmapped: [] } });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /plugins\/brandnew .* no entry in SURFACES/s);
});

test("a delegating surface is verified, not merely asserted", () => {
  const problems = evaluate({
    surfaces: [
      { id: "codex", kind: "delegates", file: ".codex-mcp.json", why: "invokes mcp-server", verify: () => null },
    ],
    family: { members: ["codex"], unmapped: [] },
    contract: CONTRACT_OK,
    readFile: () => '{"command":"npx","args":["@atomicmemory/mcp-server"]}',
    exists: () => true,
  });
  assert.deepEqual(problems, []);
});

test("fails if the contract itself stops requiring content_class", () => {
  // Otherwise this check would keep enforcing a rule that no longer exists.
  const problems = run({ contract: { $defs: { VerbatimIngest: { properties: {} } } } });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /no longer declares content_class/);
});

test("an unmapped family target fails instead of being dropped", () => {
  // Dropping an unrecognised target shape would let a member join the family
  // and never be required to classify itself.
  const problems = run({ family: { members: ["openclaw"], unmapped: ["integrations/brandnew/package.json"] } });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /could not be mapped to a plugin id/);
});

test("familyMembers reports unmapped targets rather than discarding them", () => {
  const { members, unmapped } = familyMembers([
    { file: "plugins/openclaw/package.json" },
    { file: "integrations/brandnew/package.json" },
  ]);
  assert.deepEqual(members, ["openclaw"]);
  assert.deepEqual(unmapped, ["integrations/brandnew/package.json"]);
});

test("a commented-out declaration does not satisfy a check", () => {
  // The bypass that made the first version of this check worthless.
  assert.equal(/contentClass/.test(stripComments("// contentClass: enumSchema(['summary'])", "c")), false);
  assert.equal(/content_class/.test(stripComments('# "content_class": {}', "py")), false);
});

test("every real surface declares a verify() and a file", () => {
  for (const s of SURFACES) {
    assert.equal(typeof s.verify, "function", `${s.id} must define verify()`);
    assert.ok(s.file, `${s.id} must name a file, including delegating surfaces`);
  }
});

test("two marketplace plugins map to two distinct members", () => {
  // The bypass: a `?? "claude-code"` fallback collapsed every marketplace
  // target onto the first plugin, so a SECOND plugin sharing the marketplace
  // file never had to classify itself.
  const { members, unmapped } = familyMembers([
    { file: ".claude-plugin/marketplace.json", pluginId: "claude-code" },
    { file: ".claude-plugin/marketplace.json", pluginId: "brandnew" },
  ]);
  assert.deepEqual(members, ["brandnew", "claude-code"]);
  assert.deepEqual(unmapped, []);
});

test("a marketplace target without an identity is unmapped, not assumed", () => {
  const { members, unmapped } = familyMembers([{ file: ".claude-plugin/marketplace.json" }]);
  assert.deepEqual(members, []);
  assert.equal(unmapped.length, 1);
  assert.match(unmapped[0], /marketplace target without pluginId/);
});

test("the real marketplace targets carry a pluginId", () => {
  // Guards the coupling: if marketplacePluginTarget stops exposing pluginId,
  // the identity check above silently starts failing closed on real targets.
  const { unmapped } = familyMembers();
  assert.deepEqual(unmapped, []);
});
