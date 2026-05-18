/**
 * @file Coverage gate: every spec command must have a registered
 * handler in commands/registry.ts. Without this gate it is easy to
 * add a new spec entry, ship it, and never notice the dispatch path
 * is unreachable. A regression here means cli-spec.json and the
 * runtime registry have drifted.
 *
 * Hidden experimental commands are included — they are still
 * dispatchable when --experimental is on, so they need handlers too.
 *
 * For commands with children (config, skill), each child segment
 * (`config show`, `config get`, ..., `config profile list`,
 * `skill list`, etc.) must also have a handler.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { _resetSpecCache, loadSpec } from '../spec/loader.js';
import { knownCommands } from '../commands/registry.js';

test('every visible spec command has a registered handler', () => {
  _resetSpecCache();
  const spec = loadSpec();
  const registry = new Set(knownCommands());
  const missing: string[] = [];

  for (const cmd of spec.commands) {
    if (cmd.hidden) continue;
    const hasChildren = (cmd.children ?? []).length > 0;
    if (hasChildren) {
      // Parents with children act as routers; commander dispatches to
      // the leaf. The bare parent handler is optional (skill provides
      // one defaulting to "list"; config does not). What matters is
      // that every advertised child path is dispatchable.
      for (const child of cmd.children!) {
        const fullPath = `${cmd.name} ${child.name}`;
        if (!registry.has(fullPath)) missing.push(fullPath);
      }
    } else if (!registry.has(cmd.name)) {
      missing.push(cmd.name);
    }
  }

  assert.deepEqual(missing, [], `spec commands without handlers: ${missing.join(', ')}`);
});

test('every hidden experimental command has a registered handler', () => {
  _resetSpecCache();
  const spec = loadSpec();
  const registry = new Set(knownCommands());
  const missing: string[] = [];

  for (const cmd of spec.commands) {
    if (!cmd.hidden) continue;
    if (cmd.category !== 'experimental') continue;
    if (!registry.has(cmd.name)) missing.push(cmd.name);
  }

  assert.deepEqual(
    missing,
    [],
    `hidden experimental commands without handlers: ${missing.join(', ')}`,
  );
});

test('registry has no orphan handlers (every handler key maps to a spec command)', () => {
  _resetSpecCache();
  const spec = loadSpec();

  // Build the set of all valid command paths from the spec, including
  // children. The registry can ALSO contain bare parent paths (e.g.,
  // "skill") even when commander only dispatches to children — that's
  // intentional default-routing.
  const validPaths = new Set<string>();
  for (const cmd of spec.commands) {
    validPaths.add(cmd.name);
    for (const child of cmd.children ?? []) {
      validPaths.add(`${cmd.name} ${child.name}`);
    }
  }

  const orphans: string[] = [];
  for (const handlerKey of knownCommands()) {
    if (!validPaths.has(handlerKey)) orphans.push(handlerKey);
  }
  assert.deepEqual(orphans, [], `handlers not in spec: ${orphans.join(', ')}`);
});
