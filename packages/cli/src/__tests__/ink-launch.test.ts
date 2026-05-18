/**
 * @file Phase 7 Ink-launch tests. The Ink renderer mounts only when
 * `isInteractive` returns true; the runtime asks via the
 * `inkShouldLaunch` adapter in cli/output-policy.ts. These tests
 * verify the two helpers stay aligned (single source of truth) and
 * cover the v5 §"Output Semantics" launch matrix end-to-end.
 *
 * The live dashboard now mounts only for bare or explicit interactive
 * entry; one-shot commands still use the static Ink renderer. Both stay
 * out of every machine-mode path.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { isInteractive } from '../interactive/detect.js';
import { inkShouldLaunch } from '../cli/output-policy.js';

const ttyAll = { stdinTTY: true, stdoutTTY: true } as const;

test('inkShouldLaunch delegates to isInteractive (single source of truth)', () => {
  // The wrapper must produce the same answer as the underlying
  // detection rule across the v5 launch matrix. Stdin/stdout TTY
  // bits read from process by default; we exercise the env+mode+hint
  // axes here and trust the TTY axis from interactive-detect.test.ts.
  const cases: Array<{
    mode: 'text' | 'json' | 'agent' | 'table' | 'quiet';
    interactive?: boolean;
    env?: NodeJS.ProcessEnv;
    expected: boolean;
  }> = [
    { mode: 'text', expected: process.stdin.isTTY === true && process.stdout.isTTY === true },
    { mode: 'json', expected: false },
    { mode: 'agent', expected: false },
    { mode: 'table', expected: false },
    { mode: 'quiet', expected: false },
    { mode: 'text', interactive: false, expected: false },
    { mode: 'text', env: { CI: 'true' }, expected: false },
    { mode: 'text', env: { CI: '1' }, expected: false },
    { mode: 'text', interactive: true, env: { CI: 'true' }, expected: false },
  ];

  for (const c of cases) {
    const inkAnswer = inkShouldLaunch(
      c.interactive === undefined ? {} : { interactive: c.interactive },
      c.mode,
      c.env ?? {},
    );
    const detectAnswer = isInteractive({
      mode: c.mode,
      hint:
        c.interactive === undefined
          ? null
          : c.interactive
            ? true
            : false,
      env: c.env ?? {},
    });
    assert.equal(
      inkAnswer,
      detectAnswer,
      `mismatch mode=${c.mode} interactive=${String(c.interactive)} env=${JSON.stringify(c.env ?? {})}`,
    );
  }
});

test('inkShouldLaunch: --interactive=true is a hint, not an override of suppressors', () => {
  // CI suppression wins even when --interactive is explicitly true.
  assert.equal(
    inkShouldLaunch({ interactive: true }, 'text', { CI: 'true' }),
    false,
  );
  // Machine-mode suppression wins too.
  assert.equal(inkShouldLaunch({ interactive: true }, 'json', {}), false);
  assert.equal(inkShouldLaunch({ interactive: true }, 'agent', {}), false);
  assert.equal(inkShouldLaunch({ interactive: true }, 'quiet', {}), false);
});

test('inkShouldLaunch: --no-interactive (interactive=false) suppresses Ink even in TTY+text', () => {
  // Use the underlying detector with stdin/stdout TTY forced true to
  // isolate the hint axis from process state.
  assert.equal(
    isInteractive({ mode: 'text', hint: false, env: {}, ...ttyAll }),
    false,
  );
});

test('inkShouldLaunch: every machine output mode suppresses Ink regardless of TTY/CI/hint', () => {
  for (const mode of ['json', 'agent', 'table', 'quiet'] as const) {
    for (const hint of [null, true, false] as const) {
      assert.equal(
        isInteractive({ mode, hint, env: {}, ...ttyAll }),
        false,
        `mode=${mode} hint=${String(hint)} should not launch Ink`,
      );
    }
  }
});
