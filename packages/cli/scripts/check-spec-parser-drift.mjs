#!/usr/bin/env node
/**
 * check-spec-parser-drift.mjs
 *
 * Asserts that the commander program built from `cli-spec.json` agrees
 * with the spec on:
 *
 *   - the set of top-level commands (visible AND hidden)
 *   - the visibility of each command (the spec's `hidden:true` entries
 *     must be hidden in commander's default help; non-hidden entries must
 *     be visible)
 *   - the set of top-level options, including `--no-foo` negations
 *     (commander 12 does not auto-derive negations from a positive
 *     declaration; both forms must be declared explicitly)
 *
 * Until Phase 2 lands `dist/spec/commander-bridge.js`, the script
 * performs spec-only invariants and exits 0. Once the bridge is built,
 * the full drift check runs.
 *
 * Per the v5 plan §"Two key user decisions locked", post-V1 surfaces
 * (lifecycle/audit/lessons/agents) MUST stay hidden in commander's
 * default help while still being registered for dispatch. This script
 * is the regression gate for that contract.
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const specPath = resolve(root, 'cli-spec.json');
const bridgePath = resolve(root, 'dist/spec/commander-bridge.js');

const spec = JSON.parse(readFileSync(specPath, 'utf8'));

if (typeof spec.spec_version !== 'string' || spec.spec_version.length === 0) {
  console.error('cli-spec.json: missing or invalid "spec_version"');
  process.exit(1);
}
if (!Array.isArray(spec.commands)) {
  console.error('cli-spec.json: "commands" must be an array');
  process.exit(1);
}

const specCommands = spec.commands;
const specCommandNames = new Set(specCommands.map((c) => c.name));
{
  const seen = new Set();
  for (const n of specCommandNames) {
    if (seen.has(n)) {
      console.error(`cli-spec.json: duplicate command name "${n}"`);
      process.exit(1);
    }
    seen.add(n);
  }
}

if (!existsSync(bridgePath)) {
  console.log(
    `commander bridge not yet built at ${bridgePath} (Phase 2). Spec invariants OK; full drift check deferred.`,
  );
  process.exit(0);
}

// Phase 2+ behavior.
const bridgeModule = await import(bridgePath);
const buildProgram = bridgeModule.buildProgram;
if (typeof buildProgram !== 'function') {
  console.error(
    `${bridgePath} must export buildProgram(spec) -> commander Program`,
  );
  process.exit(1);
}

const program = buildProgram(spec);

const errors = [];

// 1. Command-name set (visible AND hidden combined)
const programCommandNames = new Set(program.commands.map((c) => c.name()));
for (const specName of specCommandNames) {
  if (!programCommandNames.has(specName)) {
    errors.push(
      `parser drift: spec command "${specName}" not registered on commander program`,
    );
  }
}
for (const programName of programCommandNames) {
  // Commander auto-adds a `help` command. The spec's `help` command must
  // exist, so this branch only fires if the parser registers a name the
  // spec did not declare.
  if (!specCommandNames.has(programName) && programName !== 'help') {
    errors.push(
      `parser drift: commander program registers "${programName}" but cli-spec.json does not declare it`,
    );
  }
}

// 2. Per-command visibility — hidden:true in spec must be hidden in commander.
for (const specCmd of specCommands) {
  const programCmd = program.commands.find((c) => c.name() === specCmd.name);
  if (!programCmd) continue; // already reported above
  const programHidden = Boolean(programCmd._hidden);
  const specHidden = Boolean(specCmd.hidden);
  if (programHidden !== specHidden) {
    errors.push(
      `visibility drift: spec command "${specCmd.name}" has hidden=${specHidden} but commander has _hidden=${programHidden}`,
    );
  }
}

// 3. Default help must NOT mention hidden commands.
const helpText = program.helpInformation();
for (const specCmd of specCommands) {
  if (!specCmd.hidden) continue;
  // Match the command name as a token (commander prefixes commands with
  // two leading spaces in default help).
  const tokenPattern = new RegExp(`(^|\\s)${escapeRegex(specCmd.name)}\\b`);
  if (tokenPattern.test(helpText)) {
    errors.push(
      `visibility drift: hidden spec command "${specCmd.name}" appears in commander's default help output`,
    );
  }
}

// 4. Top-level option set. Commander 12 does NOT auto-generate
//    `--no-foo` from `--foo`, so the spec must list both forms when
//    the negation is supported and the parser must register both. The
//    drift check enforces that the full spec set matches the program.
const programOptionFlags = new Set();
for (const opt of program.options) {
  for (const flag of opt.long ? [opt.long] : []) {
    programOptionFlags.add(flag);
  }
  if (opt.short) programOptionFlags.add(opt.short);
}
const specOptionFlags = (spec.global_options ?? [])
  .map((o) => extractFlagName(o.name))
  .filter((name) => Boolean(name));

for (const specFlag of specOptionFlags) {
  if (!programOptionFlags.has(specFlag)) {
    errors.push(
      `option drift: spec global option "${specFlag}" not registered on commander program`,
    );
  }
}
for (const programFlag of programOptionFlags) {
  // commander auto-adds --help and --version; ignore them.
  if (programFlag === '--help' || programFlag === '--version' || programFlag === '-V' || programFlag === '-h') {
    continue;
  }
  if (!specOptionFlags.includes(programFlag)) {
    errors.push(
      `option drift: commander program registers "${programFlag}" but cli-spec.json does not declare it`,
    );
  }
}

if (errors.length > 0) {
  console.error('Spec/parser drift detected:');
  for (const e of errors) console.error('  -', e);
  process.exit(1);
}

console.log(
  `OK cli-spec.json (spec_version ${spec.spec_version}) and commander parser are in sync (${specCommands.length} commands, ${specOptionFlags.length} top-level options).`,
);

function extractFlagName(declaration) {
  // "--filter-json JSON" -> "--filter-json"
  // "--no-interactive"   -> "--no-interactive"
  return declaration.trim().split(/\s+/)[0] ?? declaration.trim();
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
