/**
 * @file Defensive coverage for the hooks agent sanitizer registered in
 * `output/sanitizers/index.ts`. The runtime path
 * (`runUserPromptSubmit` → `sanitizePromptContext`) already redacts
 * additionalContext at the source, so a leak past the sanitizer would
 * be a regression in the run path. The agent sanitizer is the
 * belt-and-suspenders: agent-mode envelopes are the most-replayed
 * surface (machine consumers cache and chain them), so we re-redact
 * any `additionalContext` we encounter here too. These tests prove
 * that defense-in-depth pass actually fires.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
// Side-effect import — registers the hooks sanitizer.
import '../output/sanitizers/index.js';
import { sanitizeForAgent } from '../output/envelope.js';
import type { RenderContext } from '../types.js';

const ctx: RenderContext = {
  mode: 'agent',
  interactive: false,
  profileName: 'default',
  startTime: 0,
  command: 'hooks',
  color: false,
};

test('hooks agent sanitizer defensively redacts secrets in additionalContext', () => {
  const input = {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit' as const,
      additionalContext: '## ctx\n\n- prior memory contains sk-AAAAAAAAAAAAAAAA1234',
    },
  };
  const out = sanitizeForAgent('hooks', input, ctx) as typeof input;
  assert.equal(/sk-AAAAAAAAAAAAAAAA1234/.test(out.hookSpecificOutput.additionalContext), false);
  assert.match(out.hookSpecificOutput.additionalContext, /sk-\[redacted\]/);
});

test('hooks agent sanitizer passes through empty / lifecycle-success data unchanged', () => {
  // post-compact / stop / skip cases all return data:''. The sanitizer
  // must not throw or coerce the shape.
  const out = sanitizeForAgent('hooks', '', ctx);
  assert.equal(out, '');
});

test('hooks agent sanitizer passes through install-plan data unchanged', () => {
  const installPlan = { action: 'install', host: 'codex', runtime: 'node' };
  const out = sanitizeForAgent('hooks', installPlan, ctx);
  assert.deepEqual(out, installPlan);
});
