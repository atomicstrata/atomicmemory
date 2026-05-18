/**
 * @file Lifecycle-ordering regression tests for runLifecycle.
 *
 * The documented v5 order (lifecycle.ts header):
 *   1. validate
 *   2. staticScope
 *   3. initAdapter
 *   4. loadCapabilities
 *   5. dynamicScope
 *   6. interactive gate (--interactive rejected when mode !== 'text')
 *   7. execute
 *   8. render
 *
 * This test instruments every hook to record its call order and asserts
 * the sequence matches the docs. It also asserts:
 *   - missing_user from staticScope fires *before* initAdapter
 *     (so we don't pay the cost of provider init for a deterministic
 *      validation failure)
 *   - --interactive + non-text mode is rejected only *after* validate,
 *     staticScope, initAdapter, loadCapabilities, dynamicScope all pass
 *     (so deterministic failures shadow the interactive-mode rejection)
 */

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { runLifecycle, type LifecycleHooks } from '../lifecycle.js';
import { registerSanitizer } from '../output/envelope.js';
import { CliError, type CliProfile, type RenderContext } from '../types.js';

// Agent-mode happy-path tests below need a sanitizer for the synthetic
// 'test' command. Pass through whatever the execute() hook returned.
before(() => {
  registerSanitizer<unknown, unknown>('test', (input) => input);
});

interface Flags {
  user?: string;
}
type Adapter = { id: 'fake' };
type Result = { ok: true };

const PROFILE: CliProfile = {
  provider: 'atomicmemory',
  apiUrl: 'http://localhost:3000',
  trustSurface: 'local',
};

function ctx(overrides: Partial<RenderContext> = {}): RenderContext {
  return {
    mode: 'text',
    interactive: false,
    profileName: 'default',
    startTime: Date.now(),
    command: 'test',
    color: false,
    ...overrides,
  };
}

interface Recorder {
  calls: string[];
  hooks: LifecycleHooks<Flags, Adapter, Result>;
}

function makeRecorder(overrides: Partial<LifecycleHooks<Flags, Adapter, Result>> = {}): Recorder {
  const calls: string[] = [];
  const adapter: Adapter = { id: 'fake' };
  const hooks: LifecycleHooks<Flags, Adapter, Result> = {
    validate: (flags) => {
      calls.push('validate');
      return overrides.validate?.(flags);
    },
    staticScope: (flags, profile) => {
      calls.push('staticScope');
      return overrides.staticScope?.(flags, profile);
    },
    initAdapter: async (flags, profile) => {
      calls.push('initAdapter');
      if (overrides.initAdapter) return overrides.initAdapter(flags, profile);
      return adapter;
    },
    loadCapabilities: async (a) => {
      calls.push('loadCapabilities');
      if (overrides.loadCapabilities) return overrides.loadCapabilities(a);
      return { ingestModes: ['text'], extensions: { package: true } };
    },
    dynamicScope: (flags, profile, caps) => {
      calls.push('dynamicScope');
      return overrides.dynamicScope?.(flags, profile, caps);
    },
    execute: async (flags, a, caps) => {
      calls.push('execute');
      if (overrides.execute) return overrides.execute(flags, a, caps);
      return { command: 'test', data: { ok: true } };
    },
  };
  return { calls, hooks };
}

// Silence renderer output for these tests; we only care about the order.
function silentCtx(mode: RenderContext['mode']): RenderContext {
  return ctx({ mode });
}

const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);

function withSilencedStdio<T>(fn: () => Promise<T>): Promise<T> {
  process.stdout.write = ((..._args: unknown[]) => true) as typeof process.stdout.write;
  process.stderr.write = ((..._args: unknown[]) => true) as typeof process.stderr.write;
  return fn().finally(() => {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  });
}

test('happy path runs hooks in documented v5 order', async () => {
  const r = makeRecorder();
  const code = await withSilencedStdio(() =>
    runLifecycle(
      { flags: { user: 'u1' }, profile: PROFILE, ctx: silentCtx('text'), interactiveHint: null },
      r.hooks,
    ),
  );
  assert.equal(code, 0);
  assert.deepEqual(r.calls, [
    'validate',
    'staticScope',
    'initAdapter',
    'loadCapabilities',
    'dynamicScope',
    'execute',
  ]);
});

test('missing_user from staticScope fires before initAdapter', async () => {
  const r = makeRecorder({
    staticScope: () => {
      throw new CliError('missing_user', 'no user resolved');
    },
  });
  const code = await withSilencedStdio(() =>
    runLifecycle(
      { flags: {}, profile: PROFILE, ctx: silentCtx('agent'), interactiveHint: null },
      r.hooks,
    ),
  );
  assert.equal(code, 2);
  assert.deepEqual(r.calls, ['validate', 'staticScope']);
  assert.equal(r.calls.includes('initAdapter'), false);
  assert.equal(r.calls.includes('loadCapabilities'), false);
  assert.equal(r.calls.includes('execute'), false);
});

test('validate failure short-circuits before staticScope', async () => {
  const r = makeRecorder({
    validate: () => {
      throw new CliError('usage', 'bad flag');
    },
  });
  const code = await withSilencedStdio(() =>
    runLifecycle(
      { flags: { user: 'u1' }, profile: PROFILE, ctx: silentCtx('agent'), interactiveHint: null },
      r.hooks,
    ),
  );
  assert.equal(code, 2);
  assert.deepEqual(r.calls, ['validate']);
});

test('dynamicScope failure fires after capabilities load but before execute and interactive gate', async () => {
  const r = makeRecorder({
    dynamicScope: () => {
      throw new CliError('missing_scope_field', 'namespace required');
    },
  });
  // Use --interactive + agent mode so the interactive gate would also fire if reached;
  // dynamicScope must trip first.
  const code = await withSilencedStdio(() =>
    runLifecycle(
      { flags: { user: 'u1' }, profile: PROFILE, ctx: silentCtx('agent'), interactiveHint: true },
      r.hooks,
    ),
  );
  assert.equal(code, 2);
  assert.deepEqual(r.calls, [
    'validate',
    'staticScope',
    'initAdapter',
    'loadCapabilities',
    'dynamicScope',
  ]);
  assert.equal(r.calls.includes('execute'), false);
});

test('--interactive + agent mode is rejected only after every prior stage passes', async () => {
  const r = makeRecorder();
  const code = await withSilencedStdio(() =>
    runLifecycle(
      { flags: { user: 'u1' }, profile: PROFILE, ctx: silentCtx('agent'), interactiveHint: true },
      r.hooks,
    ),
  );
  assert.equal(code, 2);
  // All five validation/scope/init stages ran; only execute was skipped.
  assert.deepEqual(r.calls, [
    'validate',
    'staticScope',
    'initAdapter',
    'loadCapabilities',
    'dynamicScope',
  ]);
  assert.equal(r.calls.includes('execute'), false);
});

test('--interactive + agent + earlier validation failure surfaces the validation error, not the interactive-gate error', async () => {
  const r = makeRecorder({
    validate: () => {
      throw new CliError('usage', 'invalid filter-json');
    },
  });
  const code = await withSilencedStdio(() =>
    runLifecycle(
      { flags: { user: 'u1' }, profile: PROFILE, ctx: silentCtx('agent'), interactiveHint: true },
      r.hooks,
    ),
  );
  assert.equal(code, 2);
  // Only validate ran; the interactive gate never had a chance.
  assert.deepEqual(r.calls, ['validate']);
});

test('--interactive + text mode is allowed (gate only rejects non-text)', async () => {
  const r = makeRecorder();
  const code = await withSilencedStdio(() =>
    runLifecycle(
      { flags: { user: 'u1' }, profile: PROFILE, ctx: silentCtx('text'), interactiveHint: true },
      r.hooks,
    ),
  );
  assert.equal(code, 0);
  assert.deepEqual(r.calls, [
    'validate',
    'staticScope',
    'initAdapter',
    'loadCapabilities',
    'dynamicScope',
    'execute',
  ]);
});

test('--no-interactive (hint=false) is silently honored in any mode', async () => {
  const r = makeRecorder();
  const code = await withSilencedStdio(() =>
    runLifecycle(
      { flags: { user: 'u1' }, profile: PROFILE, ctx: silentCtx('agent'), interactiveHint: false },
      r.hooks,
    ),
  );
  assert.equal(code, 0);
});
