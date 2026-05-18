/**
 * @file Tests centralized interactivity detection.
 * Rule (v5 §"Output Semantics"):
 *   stdin.isTTY && stdout.isTTY && !CI && output === 'text' && hint !== false
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { isInteractive } from '../interactive/detect.js';

test('text mode + TTY + non-CI + no hint => interactive', () => {
  assert.equal(
    isInteractive({
      mode: 'text',
      hint: null,
      env: {},
      stdinTTY: true,
      stdoutTTY: true,
    }),
    true,
  );
});

test('--no-interactive (hint=false) suppresses Ink even if everything else passes', () => {
  assert.equal(
    isInteractive({
      mode: 'text',
      hint: false,
      env: {},
      stdinTTY: true,
      stdoutTTY: true,
    }),
    false,
  );
});

test('non-text modes never launch Ink', () => {
  for (const mode of ['json', 'agent', 'table', 'quiet'] as const) {
    assert.equal(
      isInteractive({ mode, hint: null, env: {}, stdinTTY: true, stdoutTTY: true }),
      false,
      `mode=${mode} should not be interactive`,
    );
  }
});

test('CI=true suppresses Ink', () => {
  for (const ciValue of ['true', '1']) {
    assert.equal(
      isInteractive({
        mode: 'text',
        hint: null,
        env: { CI: ciValue },
        stdinTTY: true,
        stdoutTTY: true,
      }),
      false,
      `CI=${ciValue} should suppress Ink`,
    );
  }
});

test('non-TTY stdin or stdout suppresses Ink', () => {
  assert.equal(
    isInteractive({ mode: 'text', hint: null, env: {}, stdinTTY: false, stdoutTTY: true }),
    false,
  );
  assert.equal(
    isInteractive({ mode: 'text', hint: null, env: {}, stdinTTY: true, stdoutTTY: false }),
    false,
  );
});

test('hint=true does not override other suppressors', () => {
  assert.equal(
    isInteractive({
      mode: 'text',
      hint: true,
      env: { CI: 'true' },
      stdinTTY: true,
      stdoutTTY: true,
    }),
    false,
  );
  assert.equal(
    isInteractive({
      mode: 'json',
      hint: true,
      env: {},
      stdinTTY: true,
      stdoutTTY: true,
    }),
    false,
  );
});
