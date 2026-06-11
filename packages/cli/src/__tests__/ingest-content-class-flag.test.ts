/**
 * @file Command-path coverage for `ingest --content-class`. Regression
 * guard: the handler reads `ctx.flags['content-class']`, but unless the
 * flag is declared in cli-spec.json the spec-driven commander program
 * rejects it as an unknown option before the handler ever runs. These
 * tests parse real argv through `parseInvocation` (the production entry
 * that sets allowUnknownOption(false)) to pin both acceptance and the
 * kebab-case key the handler depends on.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseInvocation } from '../cli/parse-invocation.js';
import { _resetSpecCache } from '../spec/loader.js';

test('ingest --content-class is accepted and normalized to the handler key', async () => {
  _resetSpecCache();
  const { invocation, error } = await parseInvocation([
    'ingest', '--mode', 'verbatim', '--content-class', 'summary', 'hello',
  ]);
  assert.equal(error, null, 'spec must declare --content-class so commander accepts it');
  assert.ok(invocation);
  assert.equal(invocation?.path, 'ingest');
  assert.equal(invocation?.flags['content-class'], 'summary');
});

test('ingest rejects an unknown option (proves the gate is real, not allowUnknown)', async () => {
  _resetSpecCache();
  const { invocation, error } = await parseInvocation([
    'ingest', '--mode', 'verbatim', '--not-a-real-flag', 'x', 'hello',
  ]);
  assert.equal(invocation, null);
  assert.ok(error, 'unknown options must surface as a usage error');
});
