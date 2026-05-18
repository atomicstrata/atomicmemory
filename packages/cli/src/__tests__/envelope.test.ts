/**
 * @file Tests envelope builders, sanitizer registry, exit-code mapping.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  _resetSanitizers,
  buildErrorEnvelope,
  buildSuccessEnvelope,
  exitCodeFor,
  hasSanitizer,
  registerSanitizer,
  sanitizeForAgent,
} from '../output/envelope.js';
import { CliError, type RenderContext } from '../types.js';

function ctx(overrides: Partial<RenderContext> = {}): RenderContext {
  return {
    mode: 'agent',
    interactive: false,
    profileName: 'default',
    scope: { user: 'u1' },
    startTime: Date.now() - 10,
    command: 'add',
    color: false,
    ...overrides,
  };
}

test('buildSuccessEnvelope reports count from explicit field then array length then 1', () => {
  const c = ctx();
  const e1 = buildSuccessEnvelope(c, { command: 'add', data: { id: 'm1' }, count: 5 }, { id: 'm1' });
  assert.equal(e1.count, 5);

  const e2 = buildSuccessEnvelope(c, { command: 'list', data: [1, 2, 3] }, [1, 2, 3]);
  assert.equal(e2.count, 3);

  const e3 = buildSuccessEnvelope(c, { command: 'get', data: { id: 'x' } }, { id: 'x' });
  assert.equal(e3.count, 1);

  const e4 = buildSuccessEnvelope(c, { command: 'doctor', data: null }, null);
  assert.equal(e4.count, 0);
});

test('buildErrorEnvelope uses CliError.code or falls back to runtime', () => {
  const c = ctx({ command: 'search' });
  const e1 = buildErrorEnvelope(c, new CliError('missing_user', 'no user'));
  assert.equal(e1.status, 'error');
  assert.equal(e1.error?.code, 'missing_user');
  assert.equal(e1.data, null);
  assert.equal(e1.count, 0);

  const e2 = buildErrorEnvelope(c, new Error('boom'));
  assert.equal(e2.error?.code, 'runtime');
});

test('exitCodeFor uses CliError default-by-code or 1 for plain Error', () => {
  assert.equal(exitCodeFor(new CliError('missing_user', 'x')), 2);
  assert.equal(exitCodeFor(new CliError('not_found', 'x')), 4);
  assert.equal(exitCodeFor(new CliError('connectivity', 'x')), 3);
  assert.equal(exitCodeFor(new CliError('runtime', 'x')), 1);
  assert.equal(exitCodeFor(new Error('x')), 1);
});

test('exitCodeFor honors explicit override when caller supplies one', () => {
  // Override is allowed but discouraged; defaults should be preferred.
  assert.equal(exitCodeFor(new CliError('runtime', 'x', 4)), 4);
});

test('sanitizer registry: agent mode without registration raises', () => {
  _resetSanitizers();
  assert.equal(hasSanitizer('search'), false);
  assert.throws(
    () => sanitizeForAgent('search', { foo: 1 }, ctx()),
    /no agent sanitizer registered/,
  );
});

test('sanitizer registry: registered sanitizer is invoked', () => {
  _resetSanitizers();
  registerSanitizer<{ a: number; secret: string }, { a: number }>('search', (input) => ({
    a: input.a,
  }));
  const sanitized = sanitizeForAgent<{ a: number; secret: string }, { a: number }>(
    'search',
    { a: 1, secret: 'shh' },
    ctx(),
  );
  assert.deepEqual(sanitized, { a: 1 });
});
