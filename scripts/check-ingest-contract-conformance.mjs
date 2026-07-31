#!/usr/bin/env node
/**
 * Every surface that can write a verbatim memory must be able to stamp
 * `content_class`.
 *
 * Core 1.2.0 defaults to RAW_CONTENT_POLICY=reject: an unstamped verbatim
 * ingest is refused with 422 raw_content_rejected. The plugin family was moved
 * to 0.2.0 to satisfy that, but the fix was applied per surface. Hermes was
 * fixed; OpenClaw's docs and skill were updated while its tool schema was not,
 * and because `objectSchema` pins `additionalProperties: false` the parameter
 * was rejected before the call ever left the plugin. The published plugin could
 * not perform any verbatim ingest, and no test compared the surfaces to each
 * other or to the contract.
 *
 * Checks are STRUCTURAL, not textual. An earlier version matched any quoted
 * "content_class" anywhere in the file, so a mention in a handler body
 * satisfied it just as well as a schema declaration, and a commented-out
 * declaration satisfied it too. Both are the closed-schema defect this guard
 * exists to prevent, so each surface now extracts the region that actually
 * governs the wire format, strips comments, and asserts within it.
 *
 * Usage: node scripts/check-ingest-contract-conformance.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { families } from "./version-families.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONTRACT = "packages/sdk/schema/v1/provider-contract.schema.json";

const read = (rel) => readFileSync(resolve(ROOT, rel), "utf8");

/** Remove comments, so a commented-out declaration cannot satisfy a check. */
export function stripComments(text, style) {
  if (style === "c") {
    return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
  }
  return text.replace(/(^|\s)#.*$/gm, "$1"); // shell / python
}

/** Slice the region that actually governs the wire format. */
function region(text, startRe, endRe) {
  const start = text.search(startRe);
  if (start === -1) return null;
  const rest = text.slice(start);
  const end = rest.search(endRe);
  return end === -1 ? rest : rest.slice(0, end + 1);
}

/**
 * How each surface satisfies the contract.
 *
 * declares  - owns an ingest parameter schema and must name the property in it,
 *             because a closed schema rejects anything undeclared
 * stamps    - builds the request body itself and must set the field, because
 *             nothing downstream can add it
 * delegates - has no ingest surface of its own and must demonstrably invoke
 *             @atomicmemory/mcp-server, which is checked in its own right
 */
export const SURFACES = [
  {
    id: "mcp-server",
    kind: "declares",
    file: "packages/mcp-server/src/tools.ts",
    why: "canonical MCP tool schema; every delegating plugin inherits it",
    verify(text) {
      const clean = stripComments(text, "c");
      if (!/contentClass\s*:\s*z\s*\.enum\(\s*\[\s*['"]summary['"]/.test(clean)) {
        return "does not declare contentClass as a z.enum starting with 'summary'";
      }
      return null;
    },
  },
  {
    id: "openclaw",
    kind: "declares",
    file: "plugins/openclaw/src/index.ts",
    why: "owns a closed tool schema (additionalProperties: false)",
    verify(text) {
      const schema = region(stripComments(text, "c"), /case\s+['"]memory_ingest['"]\s*:/, /\]\s*\)\s*;/);
      if (!schema) return "could not locate the memory_ingest schema block";
      if (!/contentClass\s*:\s*enumSchema\(\s*\[\s*['"]summary['"]/.test(schema)) {
        return "the memory_ingest schema block does not declare contentClass as an enumSchema";
      }
      return null;
    },
  },
  {
    id: "hermes",
    kind: "declares",
    file: "plugins/hermes/tools.py",
    why: "owns the atomicmemory_conclude tool schema",
    verify(text) {
      const schema = region(stripComments(text, "py"), /CONCLUDE_SCHEMA\s*=\s*\{/, /\n\}/);
      if (!schema) return "could not locate CONCLUDE_SCHEMA";
      // A mention in the handler body is not a declaration: a closed schema
      // rejects the argument before any handler runs.
      const props = region(schema, /["']properties["']\s*:\s*\{/, /\n\s{8}\},?\n/);
      if (!props || !/["']content_class["']\s*:/.test(props)) {
        return "CONCLUDE_SCHEMA.properties does not declare content_class";
      }
      const required = region(schema, /["']required["']\s*:\s*\[/, /\]/);
      if (!required || !/["']content_class["']/.test(required)) {
        return "content_class is declared but not listed in CONCLUDE_SCHEMA.required";
      }
      return null;
    },
  },
  {
    id: "claude-code",
    kind: "stamps",
    file: "plugins/claude-code/scripts/lib/atomicmemory.sh",
    why: "hook scripts build the ingest body directly",
    verify(text) {
      const body = region(stripComments(text, "sh"), /am_quick_ingest_body\s*\(\)/, /\n\}/);
      if (!body) return "could not locate am_quick_ingest_body";

      // The function builds the payload in more than one `jq -n` branch, and
      // EVERY branch must stamp. Requiring a single match anywhere in the
      // function let one branch lose its stamp while the check stayed green,
      // which is the same "one path fixed, another missed" shape this whole
      // check exists to catch.
      const branches = body.split(/jq\s+-n/).slice(1);
      if (branches.length === 0) return "am_quick_ingest_body builds no jq payload";
      const unstamped = branches.filter((b) => !/content_class:\s*["']summary["']/.test(b)).length;
      if (unstamped > 0) {
        return `${unstamped} of ${branches.length} jq payload branch(es) in am_quick_ingest_body do not set content_class`;
      }
      return null;
    },
  },
  {
    id: "codex",
    kind: "delegates",
    file: "plugins/codex/.codex-mcp.json",
    why: "invokes @atomicmemory/mcp-server rather than owning a schema",
    verify(text) {
      return /@atomicmemory\/mcp-server/.test(text)
        ? null
        : "delegation config no longer references @atomicmemory/mcp-server, so the claim that it owns no schema is unsupported";
    },
  },
  {
    id: "cursor",
    kind: "delegates",
    file: "plugins/cursor/.cursor/mcp.json",
    why: "invokes @atomicmemory/mcp-server rather than owning a schema",
    verify(text) {
      return /@atomicmemory\/mcp-server/.test(text)
        ? null
        : "delegation config no longer references @atomicmemory/mcp-server, so the claim that it owns no schema is unsupported";
    },
  },
];

/**
 * Family members, derived from the release definition rather than restated.
 *
 * Also returns targets this function could not map. Dropping an unrecognised
 * target shape would reintroduce the gap this check exists to close: a member
 * could join the family and never be required to classify itself.
 */
export function familyMembers(targets = families.plugin) {
  const members = new Set();
  const unmapped = [];
  for (const target of targets) {
    const path = target.file ?? target.path ?? "";
    const m = /^plugins\/([^/]+)\//.exec(path);
    if (m) members.add(m[1]);
    else if (/(^|\/)marketplace\.json$/.test(path)) {
      // No fallback. Defaulting an unidentified marketplace target to
      // "claude-code" made a SECOND plugin in the same marketplace file collapse
      // into the first, so it never had to classify itself - the same
      // enumeration gap this check exists to close.
      if (target.pluginId) members.add(target.pluginId);
      else unmapped.push(`${path} (marketplace target without pluginId)`);
    } else unmapped.push(path || JSON.stringify(target));
  }
  return { members: [...members].sort(), unmapped };
}

/** Pure decision logic, so every branch can be exercised on synthetic inputs. */
export function evaluate({ surfaces, family, contract, readFile, exists }) {
  const problems = [];

  const defs = contract.$defs ?? contract.definitions ?? {};
  if (!("content_class" in (defs.VerbatimIngest?.properties ?? {}))) {
    problems.push(
      `${CONTRACT}: VerbatimIngest no longer declares content_class. ` +
        `Either the contract regressed or this check is obsolete; resolve deliberately.`,
    );
  }

  for (const path of family.unmapped) {
    problems.push(
      `version-families.mjs target '${path}' could not be mapped to a plugin id. ` +
        `Unmapped targets are dropped before conformance runs, so a member could ` +
        `join the family without ever being classified. Teach familyMembers() this ` +
        `shape, or give the target an explicit pluginId.`,
    );
  }

  const known = new Set(surfaces.map((s) => s.id));
  for (const member of family.members) {
    if (!known.has(member)) {
      problems.push(
        `plugins/${member} is in the lockstep plugin family but has no entry in ` +
          `SURFACES. Add one: it either declares an ingest schema, stamps the body ` +
          `itself, or delegates to @atomicmemory/mcp-server. This is the gap that ` +
          `let OpenClaw ship unable to perform a verbatim ingest.`,
      );
    }
  }

  for (const surface of surfaces) {
    if (!exists(surface.file)) {
      // Never skip, including delegating surfaces: a deleted delegation config
      // is unverified, not satisfied.
      problems.push(`${surface.id}: ${surface.file} not found; conformance is unverified, not satisfied.`);
      continue;
    }
    const failure = surface.verify(readFile(surface.file));
    if (failure) {
      problems.push(
        `${surface.id}: ${failure} (${surface.file}; ${surface.why}). A verbatim ` +
          `ingest from this surface will be refused by a core running the default ` +
          `RAW_CONTENT_POLICY=reject.`,
      );
    }
  }

  return problems;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const family = familyMembers();
  const problems = evaluate({
    surfaces: SURFACES,
    family,
    contract: JSON.parse(read(CONTRACT)),
    readFile: read,
    exists: (rel) => existsSync(resolve(ROOT, rel)),
  });

  if (problems.length > 0) {
    console.error("ingest contract conformance: FAILED\n");
    for (const p of problems) console.error(`  - ${p}\n`);
    process.exit(1);
  }

  const owning = SURFACES.filter((s) => s.kind !== "delegates").length;
  const delegating = SURFACES.length - owning;
  console.log(
    `ingest contract conformance: ok (${owning} owning surface(s) verified, ` +
      `${delegating} delegation(s) verified, ${family.members.length} family member(s) accounted for)`,
  );
}
