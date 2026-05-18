/**
 * @file Tests v5 output-mode precedence (renderers/index.ts).
 * Per v5 §"Output Semantics": agent > json > --output > command default.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveOutputMode } from '../renderers/index.js';

test('agent flag wins over everything else', () => {
  assert.equal(
    resolveOutputMode({
      agentFlag: true,
      jsonFlag: true,
      outputFlag: 'table',
      commandDefault: 'text',
    }),
    'agent',
  );
});

test('--output agent is equivalent to --agent', () => {
  assert.equal(
    resolveOutputMode({
      jsonFlag: true,
      outputFlag: 'agent',
      commandDefault: 'text',
    }),
    'agent',
  );
});

test('json wins over --output and command default', () => {
  assert.equal(
    resolveOutputMode({
      jsonFlag: true,
      outputFlag: 'table',
      commandDefault: 'text',
    }),
    'json',
  );
});

test('--output beats command default when no agent or json', () => {
  assert.equal(
    resolveOutputMode({ outputFlag: 'quiet', commandDefault: 'text' }),
    'quiet',
  );
});

test('command default applies when nothing is specified', () => {
  assert.equal(resolveOutputMode({ commandDefault: 'table' }), 'table');
});
