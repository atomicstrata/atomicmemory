/**
 * @file Coverage gate: every spec command whose `allowed_outputs`
 * includes "agent" must have a registered sanitizer in
 * output/envelope.ts. Without this gate the agent-mode path will
 * throw `runtime` for any unregistered command at first invocation
 * — exactly what tripped Phase 5 audit-3.
 *
 * Side-effect-imports the sanitizer registry so registrations run.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { _resetSpecCache, loadSpec } from '../spec/loader.js';
import { hasSanitizer } from '../output/envelope.js';
// Side-effect import: registers every V1 command's agent sanitizer.
import '../output/sanitizers/index.js';

test('every spec command that allows agent output has a registered sanitizer', () => {
  _resetSpecCache();
  const spec = loadSpec();
  const missing: string[] = [];

  for (const cmd of spec.commands) {
    if (!cmd.allowed_outputs.includes('agent')) continue;
    const hasChildren = (cmd.children ?? []).length > 0;
    if (hasChildren) {
      // Parents with children act as routers; only leaf paths emit
      // command results that flow through a sanitizer.
      for (const child of cmd.children!) {
        const path = `${cmd.name} ${child.name}`;
        if (!hasSanitizer(path)) missing.push(path);
      }
    } else if (!hasSanitizer(cmd.name)) {
      missing.push(cmd.name);
    }
  }

  assert.deepEqual(
    missing,
    [],
    `commands missing agent sanitizers: ${missing.join(', ')}`,
  );
});
